import {
  matrixNativeContentSchema,
  type MatrixNativeContent,
} from "@codever/protocol";
import {
  parseGatewayStateExtension,
  type GatewaySessionSummary,
  type GatewayStateSnapshot,
} from "./gatewayState";

type SessionDelta = Extract<
  MatrixNativeContent,
  { kind: "session_update" | "session_lifecycle" }
>;
type NativeRevision = Pick<
  MatrixNativeContent,
  "revision" | "revision_epoch" | "revision_epoch_generation"
>;

const MAX_PENDING_DELTAS_PER_SESSION = 256;

/** Deterministically rebuilds the existing UI model from Matrix-native events. */
export class MatrixNativeProjection {
  private readonly sessions = new Map<string, GatewaySessionSummary>();
  private readonly pendingDeltas = new Map<string, SessionDelta[]>();
  private readonly deletedAt = new Map<string, number>();
  private checkpoint: Extract<MatrixNativeContent, { kind: "gateway_checkpoint" }> | null = null;
  private latestRevision: NativeRevision | null = null;

  apply(input: unknown): GatewayStateSnapshot | null {
    const event = matrixNativeContentSchema.parse(input);
    this.observeRevision(event);
    if (event.kind === "gateway_checkpoint") {
      if (!this.checkpoint || event.state_version >= this.checkpoint.state_version) {
        this.checkpoint = event;
      }
      return this.snapshot();
    }
    if (event.kind === "gateway_revision") return this.snapshot();
    if (event.kind === "session_root") {
      if (this.deletedAt.has(event.session_id)) return this.snapshot();
      const current = this.sessions.get(event.session_id);
      if (!current || event.updated_at >= current.updatedAt) {
        this.sessions.set(event.session_id, {
          id: event.session_id,
          title: event.title,
          updatedAt: event.updated_at,
          status: event.archived ? "archived" : event.status,
          projectId: event.project.id,
          projectName: event.project.name,
          cwd: event.project.cwd,
          provider: event.provider,
          ...(event.model ? { model: event.model } : {}),
          ...(event.reasoning_effort
            ? { reasoningEffort: event.reasoning_effort }
            : {}),
          extensions: event.extensions,
        });
      }
      this.drainPendingDeltas(event.session_id);
      return this.snapshot();
    }
    if (!this.sessions.has(event.session_id)) {
      this.queuePendingDelta(event);
      return this.snapshot();
    }
    this.applyDelta(event);
    return this.snapshot();
  }

  private applyDelta(event: SessionDelta): void {
    if (event.kind === "session_update") {
      const current = this.sessions.get(event.session_id);
      if (!current || event.updated_at < current.updatedAt) return;
      this.sessions.set(event.session_id, {
        ...current,
        updatedAt: event.updated_at,
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.project
          ? {
              projectId: event.project.id,
              projectName: event.project.name,
              cwd: event.project.cwd,
            }
          : {}),
        ...(event.provider !== undefined ? { provider: event.provider } : {}),
        ...(event.extensions !== undefined ? { extensions: event.extensions } : {}),
        ...nullableProperty("model", event.model),
        ...nullableProperty("reasoningEffort", event.reasoning_effort),
      });
      return;
    }
    if (event.state === "deleted") {
      this.deletedAt.set(
        event.session_id,
        Math.max(event.updated_at, this.deletedAt.get(event.session_id) ?? 0),
      );
      this.sessions.delete(event.session_id);
      return;
    }
    const current = this.sessions.get(event.session_id);
    if (!current || event.updated_at < current.updatedAt) return;
    this.sessions.set(event.session_id, {
      ...current,
      updatedAt: event.updated_at,
      status: event.state === "archived" ? "archived" : event.state,
    });
  }

  private queuePendingDelta(event: SessionDelta): void {
    const pending = this.pendingDeltas.get(event.session_id) ?? [];
    if (pending.length >= MAX_PENDING_DELTAS_PER_SESSION) {
      throw new Error(`Too many Matrix session deltas before root ${event.session_id}`);
    }
    pending.push(event);
    this.pendingDeltas.set(event.session_id, pending);
  }

  private drainPendingDeltas(sessionId: string): void {
    const pending = this.pendingDeltas.get(sessionId);
    if (!pending) return;
    this.pendingDeltas.delete(sessionId);
    pending
      .sort((left, right) => left.updated_at - right.updated_at)
      .forEach((event) => this.applyDelta(event));
  }

  applySessionStatus(input: Record<string, unknown>): GatewayStateSnapshot | null {
    if (
      input.kind !== "status" ||
      typeof input.session_id !== "string" ||
      !input.session_id
    ) return this.snapshot();
    const current = this.sessions.get(input.session_id);
    if (!current) return this.snapshot();
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
    this.sessions.set(input.session_id, {
      ...current,
      status,
      ...(activityPhase ? { activityPhase } : {}),
    });
    return this.snapshot();
  }

  snapshot(): GatewayStateSnapshot | null {
    const checkpoint = this.checkpoint;
    if (!checkpoint) return null;
    const revision = this.latestRevision ?? checkpoint;
    return parseGatewayStateExtension({
      version: 1,
      kind: "gateway_state",
      state_version: checkpoint.state_version,
      revision: revision.revision,
      revision_epoch: revision.revision_epoch,
      revision_epoch_generation: revision.revision_epoch_generation,
      active_device_count: checkpoint.active_device_count,
      current_session_id: null,
      sessions: [...this.sessions.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((session) => ({
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
        project_id: checkpoint.workspace.project.id,
        project_name: checkpoint.workspace.project.name,
        cwd: checkpoint.workspace.project.cwd,
        provider: checkpoint.workspace.provider,
        ...(checkpoint.workspace.model ? { model: checkpoint.workspace.model } : {}),
        ...(checkpoint.workspace.reasoning_effort
          ? { reasoning_effort: checkpoint.workspace.reasoning_effort }
          : {}),
        permission_mode: checkpoint.workspace.permission_mode,
      },
      capabilities: checkpoint.capabilities,
    });
  }

  private observeRevision(event: NativeRevision): void {
    const current = this.latestRevision;
    if (!current || event.revision_epoch_generation > current.revision_epoch_generation) {
      this.latestRevision = revisionOf(event);
      return;
    }
    if (event.revision_epoch_generation < current.revision_epoch_generation) return;
    if (event.revision_epoch !== current.revision_epoch) {
      throw new Error("Matrix native events disagree on the revision epoch.");
    }
    if (event.revision >= current.revision) this.latestRevision = revisionOf(event);
  }
}

function revisionOf(value: NativeRevision): NativeRevision {
  return {
    revision: value.revision,
    revision_epoch: value.revision_epoch,
    revision_epoch_generation: value.revision_epoch_generation,
  };
}

function nullableProperty(
  key: "model" | "reasoningEffort",
  value: string | null | undefined,
): Partial<Pick<GatewaySessionSummary, "model" | "reasoningEffort">> {
  if (value === undefined) return {};
  return value === null ? { [key]: undefined } : { [key]: value };
}
