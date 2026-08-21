import type {
  Cvp3Command,
  Cvp3Event,
  Cvp3SessionProjection,
  MatrixGatewayCapabilities,
} from "@codever/protocol";
import {
  cvp3EventSchema,
  matrixGatewayCapabilitiesSchema,
} from "@codever/protocol";

export type V3ProjectedSession = Cvp3SessionProjection & {
  sessionId: string;
  projectId: string;
  threadRootEventId: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
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
  payload?: Cvp3Event["payload"];
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
};

export type V3WorkspaceProjection = {
  snapshotVersion: number;
  gatewayKeyId: string;
  capabilities: MatrixGatewayCapabilities;
};

export type MatrixCvp3ProjectionState = {
  version: 2;
  workspace: V3WorkspaceProjection | null;
  project: V3ProjectProjection | null;
  sessions: V3ProjectedSession[];
  messages: V3ProjectedMessage[];
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
  readonly completions = new Map<string, Cvp3CommandCompletion>();
  readonly seenLogicalEvents = new Set<string>();
  workspace: V3WorkspaceProjection | null = null;
  project: V3ProjectProjection | null = null;

  durableState(): MatrixCvp3ProjectionState {
    return structuredClone({
      version: 2,
      workspace: this.workspace,
      project: this.project,
      sessions: [...this.sessions.values()],
      messages: [...this.messages.values()],
      completions: [...this.completions.values()],
      seenLogicalEvents: [...this.seenLogicalEvents],
    });
  }

  restore(input: unknown): void {
    const state = validateProjectionState(input);
    this.workspace = state.workspace;
    this.project = state.project;
    this.sessions.clear();
    this.messages.clear();
    this.completions.clear();
    this.seenLogicalEvents.clear();
    for (const session of state.sessions) this.sessions.set(session.sessionId, session);
    for (const message of state.messages) this.messages.set(message.logicalId, message);
    for (const completion of state.completions) {
      this.completions.set(completion.commandId, completion);
    }
    for (const logicalId of state.seenLogicalEvents) this.seenLogicalEvents.add(logicalId);
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
      });
      if (command.payload.initialPrompt) {
        this.addUserPrompt(
          command.commandId,
          command.sessionId,
          physicalEventId,
          timestamp,
          command.payload.initialPrompt.text,
        );
      }
    } else if (command.operation === "prompt.submit") {
      this.addUserPrompt(
        command.commandId,
        command.sessionId,
        physicalEventId,
        timestamp,
        command.payload.text,
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
      if (this.workspace && payload.snapshotVersion <= this.workspace.snapshotVersion) {
        return false;
      }
      this.seenLogicalEvents.add(event.eventId);
      this.workspace = {
        snapshotVersion: payload.snapshotVersion,
        gatewayKeyId: payload.gatewayKeyId,
        capabilities: structuredClone(payload.capabilities),
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
        };
      }
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
      });
      if (payload.initialPrompt && payload.rootCommandId) {
        this.addUserPrompt(
          payload.rootCommandId,
          event.sessionId,
          this.sessions.get(event.sessionId)?.threadRootEventId || physicalEventId,
          event.occurredAt,
          payload.initialPrompt.text,
        );
      }
    }
    if (payload.type === "turn.queued" && event.sessionId) {
      this.addUserPrompt(
        payload.turnId,
        event.sessionId,
        physicalEventId,
        event.occurredAt,
        payload.text,
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
          timestamp: event.occurredAt,
          body: payload.body,
          format: payload.format,
          version: payload.messageVersion,
          ...(payload.partIndex === undefined ? {} : { partIndex: payload.partIndex }),
          ...(payload.partCount === undefined ? {} : { partCount: payload.partCount }),
          ...(event.causationCommandId ? { commandId: event.causationCommandId } : {}),
          payload,
        });
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
    if (payload.type === "tool.activity" && event.sessionId) {
      this.messages.set(`tool:${payload.toolCallId}`, {
        logicalId: `tool:${payload.toolCallId}`,
        physicalEventId,
        sessionId: event.sessionId,
        sender: "system",
        timestamp: event.occurredAt,
        body: payload.name,
        format: "plain",
        version: payload.toolVersion,
        ...(event.causationCommandId ? { commandId: event.causationCommandId } : {}),
        payload,
      });
    }
    if (event.causationCommandId) {
      const completion = completionFromEvent(event);
      if (completion) this.completions.set(event.causationCommandId, completion);
    }
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
      .filter(session => session.lifecycle !== "deleted")
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId),
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
    });
  }
}

function validateProjectionState(input: unknown): MatrixCvp3ProjectionState {
  const value = record(input);
  if (value?.version !== 1 && value?.version !== 2) {
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
    ) throw new Error("The CVP/3 session projection is invalid.");
    return structuredClone(session) as V3ProjectedSession;
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
    ) throw new Error("The CVP/3 message projection is invalid.");
    return structuredClone(message) as V3ProjectedMessage;
  });
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
  requireUnique(completions.map(completion => completion.commandId), "completion");
  requireUnique(seenLogicalEvents, "logical event");
  return {
    version: 2,
    workspace,
    project,
    sessions,
    messages,
    completions,
    seenLogicalEvents,
  };
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
  };
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
  return structuredClone(project) as V3ProjectProjection;
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
    case "device.invitation.created":
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
