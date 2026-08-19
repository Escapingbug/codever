import {
  matrixNativeContentSchema,
  matrixStateContentSchema,
  type MatrixGatewayState,
  type MatrixSessionState,
  type MatrixStateContent,
} from "@codever/protocol";
import {
  parseGatewayStateExtension,
  type GatewaySessionSummary,
  type GatewayStateSnapshot,
} from "./gatewayState";

type NativeRevision = {
  revision: number;
  revision_epoch: string;
  revision_epoch_generation: number;
};

/**
 * Projects Matrix Room State into the existing UI model. Room State is the
 * authority; timeline events only advance command revision and never create or
 * resurrect inventory entities.
 */
export class MatrixNativeProjection {
  private gateway: MatrixGatewayState | null = null;
  private readonly sessionStates = new Map<string, MatrixSessionState>();
  private readonly pendingSessionStates = new Map<string, MatrixSessionState>();
  private readonly statusOverrides = new Map<string, {
    status: "idle" | "running" | "stopping" | "failed";
    activityPhase?: "starting" | "working" | "stopping" | "idle" | "failed";
  }>();
  private latestRevision: NativeRevision | null = null;

  /**
   * A Gateway entity is the commit marker for an immutable session-directory
   * generation. Live entity events can keep the current view fresh, but once
   * this pointer changes the complete directory must be materialized again so
   * a client restarted inside the coalescing window cannot retain an older
   * inventory entry.
   */
  requiresAuthoritativeDirectoryRefresh(state: MatrixGatewayState): boolean {
    const current = this.gateway;
    if (!current) return false;
    return current.gateway_id !== state.gateway_id ||
      current.conversation_id !== state.conversation_id ||
      current.revision_epoch_generation !== state.revision_epoch_generation ||
      current.revision_epoch !== state.revision_epoch ||
      current.session_directory.generation !== state.session_directory.generation ||
      current.session_directory.state_version !== state.session_directory.state_version ||
      current.session_directory.slot !== state.session_directory.slot ||
      current.session_directory.page_count !== state.session_directory.page_count ||
      current.session_directory.state_key_prefix !== state.session_directory.state_key_prefix ||
      current.session_directory.digest !== state.session_directory.digest;
  }

  requiresCommandScopeRefresh(state: MatrixGatewayState): boolean {
    const current = this.gateway;
    return current !== null &&
      (current.revision_epoch_generation !== state.revision_epoch_generation ||
        current.revision_epoch !== state.revision_epoch);
  }

  async applyRoomState(input: unknown): Promise<GatewayStateSnapshot | null> {
    const state = matrixStateContentSchema.parse(input);
    if (state.kind === "gateway_state") {
      this.observeRevision(state);
      if (this.acceptsGateway(state)) {
        const previous = this.gateway;
        this.gateway = state;
        if (
          previous &&
          (previous.revision_epoch_generation !== state.revision_epoch_generation ||
            previous.revision_epoch !== state.revision_epoch)
        ) {
          this.sessionStates.clear();
          this.statusOverrides.clear();
          for (const [sessionId, pending] of this.pendingSessionStates) {
            if (
              pending.revision_epoch_generation !== state.revision_epoch_generation ||
              pending.revision_epoch !== state.revision_epoch
            ) this.pendingSessionStates.delete(sessionId);
          }
        }
        this.commitPendingSessionStates();
      }
      return this.snapshot();
    }
    if (state.kind === "session_directory") return this.snapshot();
    if (this.belongsToCurrentGateway(state)) {
      this.commitSessionState(state);
    } else {
      const pending = this.pendingSessionStates.get(state.session_id);
      if (!pending || compareEntityState(state, pending) >= 0) {
        this.pendingSessionStates.set(state.session_id, state);
      }
    }
    return this.snapshot();
  }

  /** Replaces the materialized directory behind one publication barrier. */
  async applyRoomStateBatch(
    inputs: readonly unknown[],
  ): Promise<GatewayStateSnapshot | null> {
    const states = inputs.map((input) => matrixStateContentSchema.parse(input));
    const gateways = states.filter(
      (state): state is MatrixGatewayState => state.kind === "gateway_state",
    );
    if (gateways.length !== 1 || states.some((state) => state.kind === "session_directory")) {
      throw new Error("A Matrix directory snapshot requires one Gateway and session entities only.");
    }
    const nextGateway = gateways[0]!;
    const watermark = nextGateway.session_directory.state_version;
    const previousGateway = this.gateway;
    if (previousGateway && gatewayCommitIsNewer(previousGateway, nextGateway)) {
      throw new Error(
        "The Matrix session directory advanced while an older snapshot was loading.",
      );
    }
    const previousSessionStates = new Map(this.sessionStates);
    const previousPendingSessionStates = new Map(this.pendingSessionStates);
    const previousStatusOverrides = new Map(this.statusOverrides);
    const previousLatestRevision = this.latestRevision;
    try {
      const newerSessionStates = [...this.sessionStates.values(), ...this.pendingSessionStates.values()]
        .filter((state) =>
          state.revision_epoch_generation === nextGateway.revision_epoch_generation &&
          state.revision_epoch === nextGateway.revision_epoch &&
          state.state_version > watermark,
        )
        .sort(compareEntityState);
      this.gateway = null;
      this.sessionStates.clear();
      this.pendingSessionStates.clear();
      this.statusOverrides.clear();
      this.latestRevision = null;
      await this.applyRoomState(nextGateway);
      for (const state of states) {
        if (state.kind === "session_state") await this.applyRoomState(state);
      }
      for (const state of newerSessionStates) await this.applyRoomState(state);
      return this.snapshot();
    } catch (error) {
      this.gateway = previousGateway;
      this.sessionStates.clear();
      for (const [key, value] of previousSessionStates) {
        this.sessionStates.set(key, value);
      }
      this.pendingSessionStates.clear();
      for (const [key, value] of previousPendingSessionStates) {
        this.pendingSessionStates.set(key, value);
      }
      this.statusOverrides.clear();
      for (const [key, value] of previousStatusOverrides) {
        this.statusOverrides.set(key, value);
      }
      this.latestRevision = previousLatestRevision;
      throw error;
    }
  }

  applyTimeline(input: unknown): GatewayStateSnapshot | null {
    const event = matrixNativeContentSchema.parse(input);
    this.observeRevision(event);
    return this.snapshot();
  }

  applySessionStatus(input: Record<string, unknown>): GatewayStateSnapshot | null {
    if (
      input.kind !== "status" ||
      typeof input.session_id !== "string" ||
      !input.session_id
    ) return this.snapshot();
    const current = this.sessionStates.get(input.session_id);
    if (!current || current.state === "deleted" || !current.session) {
      return this.snapshot();
    }
    const status =
      input.state === "running" || input.state === "stopping" || input.state === "failed"
        ? input.state
        : "idle";
    const activityPhase =
      input.activity_phase === "starting" ||
      input.activity_phase === "working" ||
      input.activity_phase === "stopping" ||
      input.activity_phase === "idle" ||
      input.activity_phase === "failed"
        ? input.activity_phase
        : undefined;
    this.statusOverrides.set(input.session_id, {
      status,
      ...(activityPhase ? { activityPhase } : {}),
    });
    return this.snapshot();
  }

  snapshot(): GatewayStateSnapshot | null {
    const gateway = this.gateway;
    if (!gateway) return null;
    const revision = this.latestRevision ?? gateway;
    const entityStates = [...this.sessionStates.values()].filter((state) =>
      state.revision_epoch_generation === gateway.revision_epoch_generation &&
      state.revision_epoch === gateway.revision_epoch,
    );
    const sessions = entityStates
      .filter((state) =>
        state.state !== "deleted" &&
        state.session !== undefined,
      )
      .map((state) => sessionSummary(state, this.statusOverrides.get(state.session_id)))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return parseGatewayStateExtension({
      version: 1,
      kind: "gateway_state",
      state_version: Math.max(
        gateway.state_version,
        ...[...this.sessionStates.values()].map((state) => state.state_version),
      ),
      revision: revision.revision,
      revision_epoch: revision.revision_epoch,
      revision_epoch_generation: revision.revision_epoch_generation,
      active_device_count: gateway.active_device_count,
      updated_at: gateway.updated_at,
      current_session_id: null,
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updated_at: session.updatedAt,
        status: session.status === "archived" ? "idle" : session.status,
        ...(session.activityPhase ? { activity_phase: session.activityPhase } : {}),
        ...(session.status === "archived" ? { archived: true } : {}),
        project_id: session.projectId,
        project_name: session.projectName,
        cwd: session.cwd,
        provider: session.provider,
        ...(session.model ? { model: session.model } : {}),
        ...(session.reasoningEffort
          ? { reasoning_effort: session.reasoningEffort }
          : {}),
        extensions: session.extensions,
      })),
      workspace: {
        project_id: gateway.workspace.project.id,
        project_name: gateway.workspace.project.name,
        cwd: gateway.workspace.project.cwd,
        provider: gateway.workspace.provider,
        ...(gateway.workspace.model ? { model: gateway.workspace.model } : {}),
        ...(gateway.workspace.reasoning_effort
          ? { reasoning_effort: gateway.workspace.reasoning_effort }
          : {}),
        permission_mode: gateway.workspace.permission_mode,
      },
      capabilities: gateway.capabilities,
    });
  }

  private acceptsGateway(state: MatrixGatewayState): boolean {
    const current = this.gateway;
    if (!current) return true;
    if (
      state.revision_epoch_generation === current.revision_epoch_generation &&
      state.revision_epoch === current.revision_epoch &&
      state.state_version < current.state_version
    ) return false;
    const revision = compareRevisions(state, current);
    return revision > 0 || (revision === 0 && state.state_version >= current.state_version);
  }

  private belongsToCurrentGateway(state: MatrixSessionState): boolean {
    const gateway = this.gateway;
    return Boolean(
      gateway &&
      state.revision_epoch_generation === gateway.revision_epoch_generation &&
      state.revision_epoch === gateway.revision_epoch,
    );
  }

  private commitPendingSessionStates(): void {
    for (const [sessionId, pending] of this.pendingSessionStates) {
      if (!this.belongsToCurrentGateway(pending)) continue;
      this.pendingSessionStates.delete(sessionId);
      this.commitSessionState(pending);
    }
  }

  private commitSessionState(state: MatrixSessionState): void {
    const current = this.sessionStates.get(state.session_id);
    if (!current || compareEntityState(state, current) >= 0) {
      this.sessionStates.set(state.session_id, state);
      this.statusOverrides.delete(state.session_id);
      this.observeRevision(state);
    }
  }

  private observeRevision(event: NativeRevision): void {
    const current = this.latestRevision;
    if (!current || event.revision_epoch_generation > current.revision_epoch_generation) {
      this.latestRevision = revisionOf(event);
      return;
    }
    if (event.revision_epoch_generation < current.revision_epoch_generation) return;
    if (event.revision_epoch !== current.revision_epoch) {
      throw new Error("Matrix events disagree on the Gateway revision epoch.");
    }
    if (event.revision >= current.revision) this.latestRevision = revisionOf(event);
  }
}

function gatewayCommitIsNewer(
  current: MatrixGatewayState,
  candidate: MatrixGatewayState,
): boolean {
  if (current.revision_epoch_generation !== candidate.revision_epoch_generation) {
    return current.revision_epoch_generation > candidate.revision_epoch_generation;
  }
  if (current.revision_epoch !== candidate.revision_epoch) {
    throw new Error("Matrix Gateway state disagrees on the revision epoch.");
  }
  return current.state_version > candidate.state_version;
}

function sessionSummary(
  state: MatrixSessionState,
  override?: {
    status: "idle" | "running" | "stopping" | "failed";
    activityPhase?: "starting" | "working" | "stopping" | "idle" | "failed";
  },
): GatewaySessionSummary {
  const session = state.session!;
  return {
    id: session.session_id,
    title: session.title,
    updatedAt: session.updated_at,
    status: state.state === "archived" ? "archived" : override?.status ?? session.status,
    ...(override?.activityPhase
      ? { activityPhase: override.activityPhase }
      : session.activity_phase
        ? { activityPhase: session.activity_phase }
        : {}),
    projectId: session.project.id,
    projectName: session.project.name,
    cwd: session.project.cwd,
    provider: session.provider,
    ...(session.model ? { model: session.model } : {}),
    ...(session.reasoning_effort
      ? { reasoningEffort: session.reasoning_effort }
      : {}),
    extensions: session.extensions,
  };
}

function compareEntityState(left: MatrixStateContent, right: MatrixStateContent): number {
  if (left.revision_epoch_generation !== right.revision_epoch_generation) {
    return left.revision_epoch_generation - right.revision_epoch_generation;
  }
  if (left.revision_epoch !== right.revision_epoch) {
    throw new Error("Matrix events disagree on the Gateway revision epoch.");
  }
  return left.state_version - right.state_version ||
    left.revision - right.revision ||
    left.updated_at - right.updated_at;
}

function compareRevisions(left: NativeRevision, right: NativeRevision): number {
  if (left.revision_epoch_generation !== right.revision_epoch_generation) {
    return left.revision_epoch_generation - right.revision_epoch_generation;
  }
  if (left.revision_epoch !== right.revision_epoch) {
    throw new Error("Matrix events disagree on the Gateway revision epoch.");
  }
  return left.revision - right.revision;
}

function revisionOf(value: NativeRevision): NativeRevision {
  return {
    revision: value.revision,
    revision_epoch: value.revision_epoch,
    revision_epoch_generation: value.revision_epoch_generation,
  };
}
