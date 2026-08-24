import type {
  Cvp3Command,
  Cvp3Event,
  Cvp3SessionProjection,
  MatrixGatewayCapabilities,
  NativeClientRelease,
  SessionExtensionBinding,
  SessionExtensionDescriptor,
} from "@codever/protocol";
import {
  cvp3EventSchema,
  matrixGatewayCapabilitiesSchema,
  nativeClientReleaseSchema,
  sessionExtensionBindingSchema,
  sessionExtensionDescriptorSchema,
} from "@codever/protocol";

export const MATRIX_CVP3_PROJECTION_STATE_VERSION = 6 as const;

export type V3ProjectedSession = Cvp3SessionProjection & {
  sessionId: string;
  projectId: string;
  threadRootEventId: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  extensionBindings?: SessionExtensionBinding[];
  activeTurnId?: string;
};

export type V3ProjectedMessage = {
  logicalId: string;
  physicalEventId: string;
  sessionId: string;
  sender: "user" | "agent" | "system";
  timestamp: number;
  body: string;
  format: "plain" | "markdown";
  version: number;
  partIndex?: number;
  partCount?: number;
  commandId?: string;
  originDeviceId?: string;
  payload?: Cvp3Event["payload"];
  resolvedActionId?: string;
};

export type V3ProjectedInboxFile = {
  fileId: string;
  physicalEventId: string;
  projectId: string;
  receivedAt: number;
  caption?: string;
  sourceLabel?: string;
  attachment: Extract<Cvp3Event["payload"], { type: "inbox.file.received" }>["attachment"];
};

export type Cvp3CommandCompletion = {
  commandId: string;
  outcome: "succeeded" | "failed" | "rejected" | "interrupted";
  sessionId?: string;
  event: Cvp3Event;
};

export type V3ProjectProjection = {
  projectId: string;
  snapshotVersion: number;
  name: string;
  cwd: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: string;
  installedExtensions: SessionExtensionDescriptor[];
  defaultExtensions: SessionExtensionBinding[];
  extensionDefaultsRevision: number;
};

export type V3WorkspaceProjection = {
  snapshotVersion: number;
  gatewayKeyId: string;
  capabilities: MatrixGatewayCapabilities;
  clientReleases: NativeClientRelease[];
};

export type MatrixCvp3ProjectionState = {
  version: typeof MATRIX_CVP3_PROJECTION_STATE_VERSION;
  workspace: V3WorkspaceProjection | null;
  project: V3ProjectProjection | null;
  sessions: V3ProjectedSession[];
  messages: V3ProjectedMessage[];
  inboxFiles: V3ProjectedInboxFile[];
  completions: Cvp3CommandCompletion[];
  seenLogicalEvents: string[];
};

/**
 * Order-independent client projection over Matrix timeline history.
 *
 * Matrix stream position is used only for display order. Business convergence
 * uses stable logical IDs and per-entity versions, never a global revision.
 */
export class MatrixCvp3Projection {
  readonly sessions = new Map<string, V3ProjectedSession>();
  readonly messages = new Map<string, V3ProjectedMessage>();
  readonly inboxFiles = new Map<string, V3ProjectedInboxFile>();
  readonly completions = new Map<string, Cvp3CommandCompletion>();
  readonly seenLogicalEvents = new Set<string>();
  workspace: V3WorkspaceProjection | null = null;
  project: V3ProjectProjection | null = null;

  reset(): void {
    this.workspace = null;
    this.project = null;
    this.sessions.clear();
    this.messages.clear();
    this.inboxFiles.clear();
    this.completions.clear();
    this.seenLogicalEvents.clear();
  }

  durableState(): MatrixCvp3ProjectionState {
    return structuredClone({
      version: MATRIX_CVP3_PROJECTION_STATE_VERSION,
      workspace: this.workspace,
      project: this.project,
      sessions: [...this.sessions.values()],
      messages: [...this.messages.values()],
      inboxFiles: [...this.inboxFiles.values()],
      completions: [...this.completions.values()],
      seenLogicalEvents: [...this.seenLogicalEvents],
    });
  }

  restore(input: unknown): void {
    const state = validateProjectionState(input);
    this.reset();
    this.workspace = state.workspace;
    this.project = state.project;
    for (const session of state.sessions) this.sessions.set(session.sessionId, session);
    for (const message of state.messages) this.messages.set(message.logicalId, message);
    for (const file of state.inboxFiles) this.inboxFiles.set(file.fileId, file);
    for (const completion of state.completions) {
      this.completions.set(completion.commandId, completion);
    }
    for (const logicalId of state.seenLogicalEvents) this.seenLogicalEvents.add(logicalId);
    // Version four could persist a terminal command together with a stale
    // working session. Reconcile from the durable completion on every restore
    // so skipped-version upgrades repair themselves without replaying Matrix.
    for (const sessionId of this.sessions.keys()) this.reconcileCompletedTurn(sessionId);
  }

  applyCommand(
    command: Cvp3Command,
    physicalEventId: string,
    timestamp = command.createdAt,
  ): boolean {
    const logicalId = `command:${command.deviceId}:${command.certificateId}:${command.commandId}`;
    if (this.seenLogicalEvents.has(logicalId)) return false;
    this.seenLogicalEvents.add(logicalId);
    if (command.operation === "session.create") {
      this.sessions.set(command.sessionId, {
        sessionId: command.sessionId,
        projectId: command.projectId,
        threadRootEventId: physicalEventId,
        title: command.payload.title ?? titleFromPrompt(command.payload.initialPrompt?.text ?? ""),
        scope: command.payload.scope ?? "project",
        ...(this.project?.cwd ? { cwd: this.project.cwd } : {}),
        lifecycle: "active",
        activity: command.payload.initialPrompt ? "queued" : "idle",
        updatedAt: timestamp,
        stateVersion: 1,
        ...(command.payload.provider ? { provider: command.payload.provider } : {}),
        ...(command.payload.model ? { model: command.payload.model } : {}),
        ...(command.payload.reasoningEffort
          ? { reasoningEffort: command.payload.reasoningEffort }
          : {}),
        ...(command.payload.permissionMode
          ? { permissionMode: command.payload.permissionMode }
          : {}),
        extensionBindings: command.payload.extensions ?? [],
        extensions: (command.payload.extensions ?? []).map(binding => ({
          id: binding.id,
          name: binding.id,
          version: "pending",
        })),
        extensionRevision: 1,
      });
      if (command.payload.initialPrompt) {
        this.addUserPrompt(
          command.commandId,
          command.sessionId,
          physicalEventId,
          timestamp,
          command.payload.initialPrompt.text,
          command.deviceId,
        );
      }
    } else if (command.operation === "prompt.submit") {
      this.addUserPrompt(
        command.commandId,
        command.sessionId,
        physicalEventId,
        timestamp,
        command.payload.text,
        command.deviceId,
      );
    }
    return true;
  }

  applyEvent(
    event: Cvp3Event,
    physicalEventId: string,
    threadRootHint?: string,
  ): boolean {
    const payload = event.payload;
    // The first deployed CVP/3 client recorded unknown workspace snapshots as
    // seen before it knew how to project them. Apply capability snapshots by
    // their monotonic entity version even when that old cache contains the
    // logical ID, so an app upgrade repairs itself without a cache reset.
    if (payload.type === "workspace.snapshot") {
      const clientReleases = mergeNativeClientReleases(
        this.workspace?.clientReleases ?? [],
        payload.clientReleases ?? [],
      );
      if (this.workspace && payload.snapshotVersion <= this.workspace.snapshotVersion) {
        if (clientReleases === this.workspace.clientReleases) return false;
        this.seenLogicalEvents.add(event.eventId);
        this.workspace = { ...this.workspace, clientReleases };
        return true;
      }
      this.seenLogicalEvents.add(event.eventId);
      this.workspace = {
        snapshotVersion: payload.snapshotVersion,
        gatewayKeyId: payload.gatewayKeyId,
        capabilities: structuredClone(payload.capabilities),
        clientReleases,
      };
      return true;
    }
    if (this.seenLogicalEvents.has(event.eventId)) return false;
    this.seenLogicalEvents.add(event.eventId);
    if (payload.type === "project.snapshot" && event.projectId) {
      if (!this.project || payload.snapshotVersion >= this.project.snapshotVersion) {
        this.project = {
          projectId: event.projectId,
          snapshotVersion: payload.snapshotVersion,
          name: payload.name,
          cwd: payload.cwd,
          provider: payload.provider,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
          permissionMode: payload.permissionMode,
          installedExtensions: payload.installedExtensions ?? [],
          defaultExtensions: payload.defaultExtensions ?? [],
          extensionDefaultsRevision: payload.extensionDefaultsRevision ?? 1,
        };
      }
      return true;
    }
    if (payload.type === "inbox.file.received" && event.projectId) {
      this.inboxFiles.set(payload.fileId, {
        fileId: payload.fileId,
        physicalEventId,
        projectId: event.projectId,
        receivedAt: event.occurredAt,
        ...(payload.caption ? { caption: payload.caption } : {}),
        ...(payload.source.label ? { sourceLabel: payload.source.label } : {}),
        attachment: payload.attachment,
      });
      return true;
    }
    if (event.sessionId && "projection" in payload) {
      this.applySessionProjection(event, payload.projection, threadRootHint);
    }
    if (payload.type === "session.ready" && event.sessionId && event.projectId) {
      const current = this.sessions.get(event.sessionId);
      this.sessions.set(event.sessionId, {
        sessionId: event.sessionId,
        projectId: event.projectId,
        threadRootEventId: current?.threadRootEventId || threadRootHint || "",
        ...payload.projection,
        provider: payload.provider,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
        permissionMode: payload.permissionMode,
        extensionBindings: payload.extensionBindings ?? current?.extensionBindings ?? [],
        ...(current?.activeTurnId ? { activeTurnId: current.activeTurnId } : {}),
      });
      if (payload.initialPrompt && payload.rootCommandId) {
        this.addUserPrompt(
          payload.rootCommandId,
          event.sessionId,
          this.sessions.get(event.sessionId)?.threadRootEventId || physicalEventId,
          event.occurredAt,
          payload.initialPrompt.text,
          payload.originDeviceId,
        );
      }
    }
    this.observeActiveTurn(event);
    if (payload.type === "turn.queued" && event.sessionId) {
      this.addUserPrompt(
        payload.turnId,
        event.sessionId,
        physicalEventId,
        event.occurredAt,
        payload.text,
        payload.originDeviceId,
        payload,
      );
    }
    if (payload.type === "assistant.message" && event.sessionId) {
      const part = payload.partIndex ?? 0;
      const key = `assistant:${payload.messageId}:${part}`;
      const current = this.messages.get(key);
      if (!current || payload.messageVersion > current.version) {
        this.messages.set(key, {
          logicalId: key,
          physicalEventId,
          sessionId: event.sessionId,
          sender: "agent",
          // Streamed versions update one bubble. Its first appearance owns
          // the timeline position so live delivery and restored history agree.
          timestamp: current ? Math.min(current.timestamp, event.occurredAt) : event.occurredAt,
          body: payload.body,
          format: payload.format,
          version: payload.messageVersion,
          ...(payload.partIndex === undefined ? {} : { partIndex: payload.partIndex }),
          ...(payload.partCount === undefined ? {} : { partCount: payload.partCount }),
          ...(event.causationCommandId ? { commandId: event.causationCommandId } : {}),
          payload,
        });
      } else if (event.occurredAt < current.timestamp) {
        // A paged Matrix batch may arrive newest-first. Learn the initial
        // position from an older version without downgrading its final body.
        this.messages.set(key, { ...current, timestamp: event.occurredAt });
      }
    }
    if (payload.type === "decision.requested" && event.sessionId) {
      this.messages.set(`decision:${payload.requestId}`, {
        logicalId: `decision:${payload.requestId}`,
        physicalEventId,
        sessionId: event.sessionId,
        sender: "system",
        timestamp: event.occurredAt,
        body: [payload.title, typeof payload.details === "string" ? payload.details : ""]
          .filter(Boolean)
          .join("\n\n"),
        format: "markdown",
        version: 1,
        ...(event.causationCommandId ? { commandId: event.causationCommandId } : {}),
        payload,
      });
    }
    if (payload.type === "extension.interaction.requested" && event.sessionId) {
      this.messages.set(`decision:${payload.requestId}`, {
        logicalId: `decision:${payload.requestId}`,
        physicalEventId,
        sessionId: event.sessionId,
        sender: "system",
        timestamp: event.occurredAt,
        body: payload.view.title,
        format: "plain",
        version: 1,
        ...(event.causationCommandId ? { commandId: event.causationCommandId } : {}),
        payload,
      });
    }
    if (
      (payload.type === "decision.resolved" || payload.type === "extension.interaction.resolved")
      && event.sessionId
    ) {
      const key = `decision:${payload.requestId}`;
      const current = this.messages.get(key);
      if (current) {
        this.messages.set(key, {
          ...current,
          physicalEventId,
          version: current.version + 1,
          resolvedActionId: payload.type === "decision.resolved"
            ? payload.decision
            : payload.actionId,
        });
      }
    }
    if (payload.type === "turn.failed" && event.sessionId) {
      this.messages.set(`turn-failed:${payload.turnId}`, {
        logicalId: `turn-failed:${payload.turnId}`,
        physicalEventId,
        sessionId: event.sessionId,
        sender: "system",
        timestamp: event.occurredAt,
        body: payload.message,
        format: "plain",
        version: 1,
        commandId: payload.turnId,
        payload,
      });
    }
    if (payload.type === "command.rejected" && event.sessionId) {
      this.messages.set(`command-rejected:${payload.commandId}`, {
        logicalId: `command-rejected:${payload.commandId}`,
        physicalEventId,
        sessionId: event.sessionId,
        sender: "system",
        timestamp: event.occurredAt,
        body: payload.message,
        format: "plain",
        version: 1,
        commandId: payload.commandId,
        payload,
      });
    }
    if (payload.type === "tool.activity" && event.sessionId) {
      const key = `tool:${payload.toolCallId}`;
      const current = this.messages.get(key);
      if (!current || payload.toolVersion > current.version) {
        this.messages.set(key, {
          logicalId: key,
          physicalEventId,
          sessionId: event.sessionId,
          sender: "system",
          timestamp: current ? Math.min(current.timestamp, event.occurredAt) : event.occurredAt,
          body: payload.name,
          format: "plain",
          version: payload.toolVersion,
          ...(event.causationCommandId ? { commandId: event.causationCommandId } : {}),
          payload,
        });
      } else if (event.occurredAt < current.timestamp) {
        this.messages.set(key, { ...current, timestamp: event.occurredAt });
      }
    }
    if (event.causationCommandId) {
      const completion = completionFromEvent(event);
      if (completion) this.completions.set(event.causationCommandId, completion);
    }
    if (event.sessionId) this.reconcileCompletedTurn(event.sessionId);
    return true;
  }

  sessionMessages(sessionId: string): V3ProjectedMessage[] {
    return [...this.messages.values()]
      .filter(message => message.sessionId === sessionId)
      .sort((left, right) =>
        left.timestamp - right.timestamp
        || (left.partIndex ?? 0) - (right.partIndex ?? 0)
        || left.logicalId.localeCompare(right.logicalId),
      );
  }

  visibleSessions(): V3ProjectedSession[] {
    return [...this.sessions.values()]
      .filter(session => session.lifecycle === "active")
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId),
      );
  }

  visibleInboxFiles(): V3ProjectedInboxFile[] {
    return [...this.inboxFiles.values()].sort((left, right) =>
      right.receivedAt - left.receivedAt || left.fileId.localeCompare(right.fileId),
    );
  }

  private applySessionProjection(
    event: Cvp3Event,
    next: Cvp3SessionProjection,
    threadRootHint?: string,
  ): void {
    const sessionId = event.sessionId!;
    const current = this.sessions.get(sessionId);
    if (current && current.stateVersion > next.stateVersion) return;
    this.sessions.set(sessionId, {
      sessionId,
      projectId: event.projectId ?? current?.projectId ?? "",
      threadRootEventId: current?.threadRootEventId || threadRootHint || "",
      ...current,
      ...next,
    });
  }

  private addUserPrompt(
    commandId: string,
    sessionId: string,
    physicalEventId: string,
    timestamp: number,
    body: string,
    originDeviceId?: string,
    payload?: Cvp3Event["payload"],
  ): void {
    this.messages.set(`user:${commandId}`, {
      logicalId: `user:${commandId}`,
      physicalEventId,
      sessionId,
      sender: "user",
      timestamp,
      body,
      format: "markdown",
      version: 1,
      commandId,
      ...(originDeviceId ? { originDeviceId } : {}),
      ...(payload ? { payload } : {}),
    });
  }

  private observeActiveTurn(event: Cvp3Event): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    const current = this.sessions.get(sessionId);
    if (!current) return;
    const payload = event.payload;

    if (payload.type === "turn.completed" || payload.type === "turn.failed") {
      if (current.activeTurnId === payload.turnId) {
        const completed = { ...current };
        delete completed.activeTurnId;
        this.sessions.set(sessionId, completed);
      }
      return;
    }

    if (!("projection" in payload) || payload.projection.stateVersion !== current.stateVersion) {
      return;
    }
    if (!isActiveSessionActivity(current.activity)) return;

    const turnId = payload.type === "turn.queued" || payload.type === "turn.started"
      ? payload.turnId
      : payload.type === "assistant.message"
          || payload.type === "tool.activity"
          || payload.type === "decision.requested"
          || payload.type === "extension.interaction.requested"
        ? event.causationCommandId
        : undefined;
    if (turnId && (!current.activeTurnId || current.activeTurnId === turnId)) {
      this.sessions.set(sessionId, { ...current, activeTurnId: turnId });
    }
  }

  private reconcileCompletedTurn(sessionId: string): void {
    const current = this.sessions.get(sessionId);
    if (!current?.activeTurnId) return;
    const completion = this.completions.get(current.activeTurnId);
    if (!completion || (completion.sessionId && completion.sessionId !== sessionId)) return;

    const settled = {
      ...current,
      activity: "idle" as const,
      updatedAt: Math.max(current.updatedAt, completion.event.occurredAt),
    };
    delete settled.activeTurnId;
    this.sessions.set(sessionId, settled);
  }
}

function validateProjectionState(input: unknown): MatrixCvp3ProjectionState {
  const value = record(input);
  if (
    value?.version !== 1
    && value?.version !== 2
    && value?.version !== 3
    && value?.version !== 4
    && value?.version !== 5
    && value?.version !== 6
  ) {
    throw new Error("Unsupported CVP/3 projection version.");
  }
  const sessions = boundedArray(value.sessions, "sessions").map(sessionValue => {
    const session = record(sessionValue);
    if (
      !session
      || !text(session.sessionId)
      || !text(session.projectId)
      || typeof session.threadRootEventId !== "string"
      || !text(session.title)
      || !["active", "archived", "deleted"].includes(String(session.lifecycle))
      || !["idle", "queued", "working", "attention", "failed"].includes(String(session.activity))
      || !integer(session.updatedAt)
      || !integer(session.stateVersion, 1)
      || !(session.activeTurnId === undefined || text(session.activeTurnId))
    ) throw new Error("The CVP/3 session projection is invalid.");
    return {
      ...structuredClone(session),
      extensionBindings: Array.isArray(session.extensionBindings)
        ? session.extensionBindings.map(binding => sessionExtensionBindingSchema.parse(binding))
        : [],
    } as V3ProjectedSession;
  });
  const messages = boundedArray(value.messages, "messages").map(messageValue => {
    const message = record(messageValue);
    if (
      !message
      || !text(message.logicalId)
      || typeof message.physicalEventId !== "string"
      || !text(message.sessionId)
      || !["user", "agent", "system"].includes(String(message.sender))
      || !integer(message.timestamp)
      || typeof message.body !== "string"
      || !["plain", "markdown"].includes(String(message.format))
      || !integer(message.version, 1)
      || !(message.originDeviceId === undefined || text(message.originDeviceId))
    ) throw new Error("The CVP/3 message projection is invalid.");
    return structuredClone(message) as V3ProjectedMessage;
  });
  const inboxFiles = value.version >= 3
    ? boundedArray(value.inboxFiles, "inbox files").map(fileValue => {
        const file = record(fileValue);
        if (
          !file
          || !text(file.fileId)
          || typeof file.physicalEventId !== "string"
          || !text(file.projectId)
          || !integer(file.receivedAt)
        ) throw new Error("The CVP/3 inbox file projection is invalid.");
        const payload = cvp3EventSchema.parse({
          kind: "codever.event",
          version: 3,
          eventId: file.fileId,
          workspaceId: "projection-validation",
          projectId: file.projectId,
          occurredAt: file.receivedAt,
          payload: {
            type: "inbox.file.received",
            fileId: file.fileId,
            ...(file.caption === undefined ? {} : { caption: file.caption }),
            source: {
              kind: "local-cli",
              ...(file.sourceLabel === undefined ? {} : { label: file.sourceLabel }),
            },
            attachment: file.attachment,
          },
        }).payload;
        if (payload.type !== "inbox.file.received") {
          throw new Error("The CVP/3 inbox file projection is invalid.");
        }
        return { ...structuredClone(file), attachment: payload.attachment } as V3ProjectedInboxFile;
      })
    : [];
  const completions = boundedArray(value.completions, "completions").map(completionValue => {
    const completion = record(completionValue);
    if (
      !completion
      || !text(completion.commandId)
      || !["succeeded", "failed", "rejected", "interrupted"].includes(String(completion.outcome))
    ) throw new Error("The CVP/3 completion projection is invalid.");
    return {
      ...structuredClone(completion),
      event: cvp3EventSchema.parse(completion.event),
    } as Cvp3CommandCompletion;
  });
  const seenLogicalEvents = boundedArray(value.seenLogicalEvents, "logical events")
    .map(item => {
      if (!text(item)) throw new Error("The CVP/3 logical event ID is invalid.");
      return item;
    });
  const projectValue = value.project;
  const project = projectValue === null ? null : validateProjectProjection(projectValue);
  const workspace = value.version === 1 || value.workspace === null
    ? null
    : validateWorkspaceProjection(value.workspace);
  requireUnique(sessions.map(session => session.sessionId), "session");
  requireUnique(messages.map(message => message.logicalId), "message");
  requireUnique(inboxFiles.map(file => file.fileId), "inbox file");
  requireUnique(completions.map(completion => completion.commandId), "completion");
  requireUnique(seenLogicalEvents, "logical event");
  if (value.version < 4) {
    for (const session of sessions) {
      if (session.activeTurnId || !isActiveSessionActivity(session.activity)) continue;
      const unresolved = messages
        .filter(message =>
          message.sessionId === session.sessionId
          && message.sender === "user"
          && message.commandId
          && !completions.some(completion => completion.commandId === message.commandId)
        )
        .sort((left, right) =>
          left.timestamp - right.timestamp || left.logicalId.localeCompare(right.logicalId)
        )[0];
      if (unresolved?.commandId) session.activeTurnId = unresolved.commandId;
    }
  }
  return {
    version: MATRIX_CVP3_PROJECTION_STATE_VERSION,
    workspace,
    project,
    sessions,
    messages,
    inboxFiles,
    completions,
    seenLogicalEvents,
  };
}

function isActiveSessionActivity(activity: Cvp3SessionProjection["activity"]): boolean {
  return activity === "queued" || activity === "working" || activity === "attention";
}

function validateWorkspaceProjection(input: unknown): V3WorkspaceProjection {
  const workspace = record(input);
  if (
    !workspace
    || !integer(workspace.snapshotVersion, 1)
    || !text(workspace.gatewayKeyId)
  ) throw new Error("The CVP/3 workspace projection is invalid.");
  return {
    snapshotVersion: workspace.snapshotVersion,
    gatewayKeyId: workspace.gatewayKeyId,
    capabilities: matrixGatewayCapabilitiesSchema.parse(workspace.capabilities),
    clientReleases: mergeNativeClientReleases(
      [],
      Array.isArray(workspace.clientReleases) ? workspace.clientReleases : [],
    ),
  };
}

function mergeNativeClientReleases(
  current: NativeClientRelease[],
  incoming: readonly unknown[],
): NativeClientRelease[] {
  const releases = new Map<string, NativeClientRelease>();
  for (const release of current) releases.set(nativeClientReleaseKey(release), release);
  let changed = false;
  for (const value of incoming) {
    const release = nativeClientReleaseSchema.parse(value);
    const key = nativeClientReleaseKey(release);
    const existing = releases.get(key);
    if (!existing || release.versionCode > existing.versionCode) {
      releases.set(key, structuredClone(release));
      changed = true;
    } else if (
      release.versionCode === existing.versionCode
      && JSON.stringify(release) !== JSON.stringify(existing)
    ) {
      throw new Error(`Native client release ${key}/${release.versionCode} is immutable.`);
    }
  }
  if (!changed) return current;
  return [...releases.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, release]) => release);
}

function nativeClientReleaseKey(release: NativeClientRelease): string {
  return `${release.platform}\u0000${release.channel}\u0000${release.architecture}`;
}

function validateProjectProjection(input: unknown): V3ProjectProjection {
  const project = record(input);
  if (
    !project
    || !text(project.projectId)
    || !integer(project.snapshotVersion, 1)
    || !text(project.name)
    || !text(project.cwd)
    || !text(project.provider)
    || !text(project.permissionMode)
  ) throw new Error("The CVP/3 project projection is invalid.");
  return {
    ...structuredClone(project),
    installedExtensions: Array.isArray(project.installedExtensions)
      ? project.installedExtensions.map(extension => sessionExtensionDescriptorSchema.parse(extension))
      : [],
    defaultExtensions: Array.isArray(project.defaultExtensions)
      ? project.defaultExtensions.map(binding => sessionExtensionBindingSchema.parse(binding))
      : [],
    extensionDefaultsRevision: integer(project.extensionDefaultsRevision, 1)
      ? project.extensionDefaultsRevision
      : 1,
  } as V3ProjectProjection;
}

function boundedArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > 100_000) {
    throw new Error(`The CVP/3 ${name} projection is invalid.`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function requireUnique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`The CVP/3 ${name} projection contains duplicate IDs.`);
  }
}

function completionFromEvent(event: Cvp3Event): Cvp3CommandCompletion | null {
  const commandId = event.causationCommandId;
  if (!commandId) return null;
  switch (event.payload.type) {
    case "session.ready":
    case "session.updated":
    case "session.lifecycle":
    case "decision.resolved":
    case "extension.interaction.resolved":
    case "project.snapshot":
    case "device.invitation.created":
    case "notification.subscription.changed":
    case "provider.sessions.listed":
    case "provider.session.inspected":
      return { commandId, outcome: "succeeded", ...(event.sessionId ? { sessionId: event.sessionId } : {}), event };
    case "turn.completed":
      return { commandId, outcome: "succeeded", ...(event.sessionId ? { sessionId: event.sessionId } : {}), event };
    case "turn.failed":
      return { commandId, outcome: "failed", ...(event.sessionId ? { sessionId: event.sessionId } : {}), event };
    case "command.rejected":
      return {
        commandId,
        outcome: event.payload.code === "execution_interrupted" ? "interrupted" : "rejected",
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        event,
      };
    default:
      return null;
  }
}

function titleFromPrompt(text: string): string {
  const value = text.replace(/\s+/gu, " ").trim();
  if (!value) return "New session";
  return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
}
