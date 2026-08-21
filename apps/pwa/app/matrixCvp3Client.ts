import {
  CODEVER_MATRIX_EXTENSION,
  cvp3ProjectKeyGrantStateSchema,
  type CodeverAttachment,
  type Cvp3Command,
  type Cvp3Event,
  type Cvp3ProjectKeyGrantPlaintext,
  type CommandPayload,
} from "@codever/protocol";
import {
  base64UrlDecode,
  openCvp3Envelope,
  openCvp3ProjectKeyGrant,
  sealCvp3Envelope,
  signCvp3Command,
  verifyCvp3Command,
  verifyCvp3Event,
} from "@codever/security";
import type { DeviceIdentity } from "./matrix";
import type { TrustedGateway } from "./pairing";
import {
  MatrixCvp3Projection,
  type MatrixCvp3ProjectionState,
  type Cvp3CommandCompletion,
} from "./matrixCvp3Projection";

export type MatrixCvp3RawEvent = {
  roomId: string;
  eventId: string;
  sender: string;
  timestamp: number;
  content: Record<string, unknown>;
};

export type MatrixCvp3OutboxRecord = {
  command: Cvp3Command;
  content: Record<string, unknown>;
  transactionId: string;
  status: "pending" | "completed";
  matrixEventId?: string;
  completion?: Cvp3CommandCompletion;
};

export type MatrixCvp3InboxRecord = {
  raw: MatrixCvp3RawEvent;
  status: "pending" | "projected" | "quarantined";
  error?: string;
};

export interface MatrixCvp3ClientStore {
  putOutbox(record: MatrixCvp3OutboxRecord): Promise<void>;
  getOutbox(commandId: string): Promise<MatrixCvp3OutboxRecord | null>;
  listPendingOutbox(): Promise<MatrixCvp3OutboxRecord[]>;
  putInbox(record: MatrixCvp3InboxRecord): Promise<boolean>;
  listInbox(): Promise<MatrixCvp3InboxRecord[]>;
  listPendingInbox(): Promise<MatrixCvp3InboxRecord[]>;
  updateInbox(eventId: string, update: Pick<MatrixCvp3InboxRecord, "status" | "error">): Promise<void>;
  loadProjection(): Promise<unknown | null>;
  saveProjection(state: MatrixCvp3ProjectionState): Promise<void>;
  clearProjection(): Promise<void>;
}

export interface MatrixCvp3ClientTransport {
  sendMessage(input: {
    roomId: string;
    content: Record<string, unknown>;
    transactionId: string;
  }): Promise<{ eventId: string }>;
}

export type MatrixCvp3ClientConfig = {
  workspaceId: string;
  roomId: string;
  projectId: string;
};

export type MatrixCvp3SendResult = {
  commandId: string;
  sessionId?: string;
  eventId?: string;
  completion: Promise<Cvp3CommandCompletion>;
};

interface CompletionWaiter {
  resolve(value: Cvp3CommandCompletion): void;
  reject(error: Error): void;
}

/** Browser/native-web shared CVP/3 command, inbox and projection core. */
export class MatrixCvp3ProtocolClient {
  readonly projection = new MatrixCvp3Projection();
  private keyGrant: Cvp3ProjectKeyGrantPlaintext | null = null;
  private readonly waiters = new Map<string, Set<CompletionWaiter>>();
  private drainChain: Promise<void> = Promise.resolve();
  private projectionSaveChain: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | null = null;
  private projectionNeedsRebuild = false;

  constructor(
    private readonly config: MatrixCvp3ClientConfig,
    private readonly identity: DeviceIdentity,
    private readonly trust: TrustedGateway,
    private readonly transport: MatrixCvp3ClientTransport,
    private readonly store: MatrixCvp3ClientStore,
    private readonly onProjection?: () => void,
    private readonly onQuarantine?: (event: MatrixCvp3RawEvent, error: Error) => void,
  ) {}

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      const state = await this.store.loadProjection();
      if (state === null) {
        this.projectionNeedsRebuild = true;
        return;
      }
      try {
        this.projection.restore(state);
      } catch {
        // The projection is rebuildable from the durable raw inbox and Matrix
        // history. Never let a stale/corrupt materialized view block startup.
        await this.store.clearProjection();
        this.projectionNeedsRebuild = true;
      }
    })();
    return this.initialization;
  }

  async acceptKeyGrant(input: unknown): Promise<void> {
    await this.initialize();
    const grant = cvp3ProjectKeyGrantStateSchema.parse(input);
    const certificate = this.trust.certificate.certificate;
    if (
      grant.workspaceId !== this.config.workspaceId ||
      grant.projectId !== this.config.projectId ||
      grant.roomId !== this.config.roomId ||
      grant.deviceId !== certificate.deviceId ||
      grant.certificateId !== certificate.certificateId
    ) {
      throw new Error("The CVP/3 project key grant is not addressed to this device.");
    }
    this.keyGrant = await openCvp3ProjectKeyGrant(grant.sealedGrant, {
      expected: {
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        projectId: grant.projectId,
        roomId: grant.roomId,
        deviceId: grant.deviceId,
        certificateId: grant.certificateId,
        senderKeyId: this.trust.gatewayKey.keyId,
        recipientKeyId: this.identity.keyId,
      },
      recipientPrivateKey: this.identity.privateKey,
      senderPublicKey: this.trust.gatewayKey.publicKey,
    });
    if (this.projectionNeedsRebuild) await this.rebuildProjection();
  }

  async send(payload: CommandPayload): Promise<MatrixCvp3SendResult> {
    await this.initialize();
    const command = toCvp3Command(
      payload,
      this.config,
      this.identity.keyId,
      this.trust.certificate.certificate.certificateId,
    );
    const key = this.activeProjectKey();
    const signed = await signCvp3Command(
      command,
      this.identity.privateKey,
      this.identity.keyId,
    );
    const envelope = await sealCvp3Envelope({
      plaintext: { kind: "signed_command", value: signed },
      projectKey: base64UrlDecode(key.key),
      roomId: this.config.roomId,
      projectId: this.config.projectId,
      keyId: key.keyId,
      logicalEventId: command.commandId,
    });
    const rootEventId = command.operation === "session.create" || !command.sessionId
      ? undefined
      : this.projection.sessions.get(command.sessionId)?.threadRootEventId || undefined;
    const content = {
      msgtype: "m.notice",
      body: "Encrypted Codever command",
      ...(rootEventId ? { "m.relates_to": threadRelation(rootEventId) } : {}),
      [CODEVER_MATRIX_EXTENSION]: { version: 3, envelope },
    };
    const record: MatrixCvp3OutboxRecord = {
      command,
      content,
      transactionId: transactionId(command.commandId),
      status: "pending",
    };
    await this.store.putOutbox(record);
    const completion = this.observeCompletion(command.commandId);
    const eventId = await this.transmit(record).catch(() => undefined);
    return {
      commandId: command.commandId,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(eventId ? { eventId } : {}),
      completion,
    };
  }

  async recover(commandId: string): Promise<MatrixCvp3SendResult> {
    await this.initialize();
    const record = await this.store.getOutbox(commandId);
    if (!record) throw new Error(`The durable command ${commandId} is unavailable.`);
    if (record.completion) {
      return {
        commandId,
        ...(record.command.sessionId ? { sessionId: record.command.sessionId } : {}),
        ...(record.matrixEventId ? { eventId: record.matrixEventId } : {}),
        completion: Promise.resolve(record.completion),
      };
    }
    const completion = this.observeCompletion(commandId);
    const eventId = await this.transmit(record).catch(() => undefined);
    return {
      commandId,
      ...(record.command.sessionId ? { sessionId: record.command.sessionId } : {}),
      ...(eventId ? { eventId } : {}),
      completion,
    };
  }

  async retryPending(): Promise<void> {
    await this.initialize();
    await Promise.all((await this.store.listPendingOutbox()).map(record =>
      this.transmit(record).catch(() => undefined),
    ));
  }

  async ingest(raw: MatrixCvp3RawEvent): Promise<void> {
    await this.initialize();
    if (raw.roomId !== this.config.roomId) return;
    if (await this.store.putInbox({ raw, status: "pending" })) {
      await this.drainInbox();
    }
  }

  drainInbox(): Promise<void> {
    const operation = this.drainChain.then(async () => {
      await this.initialize();
      for (const record of await this.store.listPendingInbox()) {
        try {
          await this.projectRaw(record.raw);
          await this.store.updateInbox(record.raw.eventId, { status: "projected", error: undefined });
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          await this.store.updateInbox(record.raw.eventId, {
            status: "quarantined",
            error: normalized.message,
          });
          this.onQuarantine?.(record.raw, normalized);
        }
      }
    });
    this.drainChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  observeCompletion(commandId: string, timeoutMs = 120_000): Promise<Cvp3CommandCompletion> {
    return this.initialize().then(() => this.store.getOutbox(commandId)).then(record => {
      if (record?.completion) return record.completion;
      return new Promise<Cvp3CommandCompletion>((resolve, reject) => {
        const waiter = { resolve, reject };
        const waiters = this.waiters.get(commandId) ?? new Set<CompletionWaiter>();
        waiters.add(waiter);
        this.waiters.set(commandId, waiters);
        const timeout = setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.waiters.delete(commandId);
          reject(new Error(`Command ${commandId} did not reach a terminal event in time.`));
        }, timeoutMs);
        const originalResolve = waiter.resolve;
        waiter.resolve = value => {
          clearTimeout(timeout);
          originalResolve(value);
        };
      });
    });
  }

  private async transmit(record: MatrixCvp3OutboxRecord): Promise<string> {
    // A Matrix event ID is the durable server acknowledgement. The command
    // remains semantically pending until its terminal Gateway event arrives,
    // but repeatedly PUTting the same transaction on every /sync cycle only
    // creates a rate-limit feedback loop and cannot improve delivery.
    if (record.matrixEventId) {
      if (this.projection.applyCommand(record.command, record.matrixEventId)) {
        await this.persistProjection();
      }
      return record.matrixEventId;
    }
    const result = await this.transport.sendMessage({
      roomId: this.config.roomId,
      content: record.content,
      transactionId: record.transactionId,
    });
    const updated = { ...record, matrixEventId: result.eventId };
    await this.store.putOutbox(updated);
    if (this.projection.applyCommand(record.command, result.eventId)) {
      await this.persistProjection();
    }
    this.onProjection?.();
    return result.eventId;
  }

  private async projectRaw(
    raw: MatrixCvp3RawEvent,
    persistAndPublish = true,
  ): Promise<void> {
    const extension = asRecord(raw.content[CODEVER_MATRIX_EXTENSION]);
    if (extension?.version !== 3 || !extension.envelope) return;
    const key = this.keyForEnvelope(extension.envelope);
    const opened = await openCvp3Envelope(extension.envelope, {
      projectKey: base64UrlDecode(key.key),
      roomId: this.config.roomId,
      projectId: this.config.projectId,
      keyId: key.keyId,
    });
    if (opened.plaintext.kind === "signed_command") {
      const candidate = opened.plaintext.value.command;
      // Only our own command can be verified with the local public key. Remote
      // user text is projected from the Gateway-signed canonical event.
      if (candidate.deviceId === this.identity.keyId) {
        const command = await verifyCvp3Command(
          opened.plaintext.value,
          this.identity.publicKey,
          {
            workspaceId: this.config.workspaceId,
            projectId: this.config.projectId,
            deviceId: this.identity.keyId,
            certificateId: this.trust.certificate.certificate.certificateId,
          },
        );
        if (opened.envelope.logicalEventId !== command.commandId) {
          throw new Error("The CVP/3 command envelope logical ID is invalid.");
        }
        const changed = this.projection.applyCommand(command, raw.eventId, raw.timestamp);
        if (changed && persistAndPublish) {
          await this.persistProjection();
        }
      }
      if (persistAndPublish) this.onProjection?.();
      return;
    }
    const event = await verifyCvp3Event(
      opened.plaintext.value,
      this.trust.gatewayKey.publicKey,
      {
        workspaceId: this.config.workspaceId,
        projectId: this.config.projectId,
      },
    );
    if (
      event.payload.type === "workspace.snapshot"
      && event.payload.gatewayKeyId !== this.trust.gatewayKey.keyId
    ) {
      throw new Error("The CVP/3 workspace capability snapshot names another Gateway key.");
    }
    if (opened.envelope.logicalEventId !== event.eventId) {
      throw new Error("The CVP/3 event envelope logical ID is invalid.");
    }
    const relation = asRecord(raw.content["m.relates_to"]);
    const threadRootHint = relation?.rel_type === "m.thread" && typeof relation.event_id === "string"
      ? relation.event_id
      : undefined;
    const changed = this.projection.applyEvent(event, raw.eventId, threadRootHint);
    await this.recordCompletion(event);
    if (changed && persistAndPublish) {
      await this.persistProjection();
    }
    if (persistAndPublish) this.onProjection?.();
  }

  private async rebuildProjection(): Promise<void> {
    for (const record of (await this.store.listInbox())
      .filter(candidate => candidate.status !== "quarantined")
      .sort((left, right) =>
        left.raw.timestamp - right.raw.timestamp
        || left.raw.eventId.localeCompare(right.raw.eventId)
      )) {
      try {
        await this.projectRaw(record.raw, false);
        if (record.status === "pending") {
          await this.store.updateInbox(record.raw.eventId, {
            status: "projected",
            error: undefined,
          });
        }
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        await this.store.updateInbox(record.raw.eventId, {
          status: "quarantined",
          error: normalized.message,
        });
        this.onQuarantine?.(record.raw, normalized);
      }
    }
    await this.persistProjection();
    this.projectionNeedsRebuild = false;
    this.onProjection?.();
  }

  private async recordCompletion(event: Cvp3Event): Promise<void> {
    if (!event.causationCommandId) return;
    const completion = this.projection.completions.get(event.causationCommandId);
    if (!completion) return;
    const record = await this.store.getOutbox(event.causationCommandId);
    if (record) {
      await this.store.putOutbox({ ...record, status: "completed", completion });
    }
    const waiters = this.waiters.get(event.causationCommandId);
    this.waiters.delete(event.causationCommandId);
    for (const waiter of waiters ?? []) waiter.resolve(completion);
  }

  private persistProjection(): Promise<void> {
    const operation = this.projectionSaveChain.then(() =>
      this.store.saveProjection(this.projection.durableState())
    );
    this.projectionSaveChain = operation.catch(() => undefined);
    return operation;
  }

  private activeProjectKey() {
    const grant = this.keyGrant;
    if (!grant) throw new Error("The CVP/3 project key grant has not been loaded.");
    const key = grant.keys.find(candidate => candidate.keyId === grant.activeKeyId);
    if (!key) throw new Error("The active CVP/3 project key is unavailable.");
    return key;
  }

  private keyForEnvelope(input: unknown) {
    const envelope = asRecord(input);
    const keyId = typeof envelope?.keyId === "string" ? envelope.keyId : "";
    const key = this.keyGrant?.keys.find(candidate => candidate.keyId === keyId);
    if (!key) throw new Error(`CVP/3 project key ${keyId || "<missing>"} is unavailable.`);
    return key;
  }
}

/** Deterministic in-memory store used by protocol tests and ephemeral hosts. */
export class MemoryMatrixCvp3ClientStore implements MatrixCvp3ClientStore {
  readonly outbox = new Map<string, MatrixCvp3OutboxRecord>();
  readonly inbox = new Map<string, MatrixCvp3InboxRecord>();
  projectionState: MatrixCvp3ProjectionState | null = null;
  async putOutbox(record: MatrixCvp3OutboxRecord): Promise<void> {
    this.outbox.set(record.command.commandId, structuredClone(record));
  }
  async getOutbox(commandId: string): Promise<MatrixCvp3OutboxRecord | null> {
    const record = this.outbox.get(commandId);
    return record ? structuredClone(record) : null;
  }
  async listPendingOutbox(): Promise<MatrixCvp3OutboxRecord[]> {
    return [...this.outbox.values()].filter(record => record.status === "pending").map(record => structuredClone(record));
  }
  async putInbox(record: MatrixCvp3InboxRecord): Promise<boolean> {
    if (this.inbox.has(record.raw.eventId)) return false;
    this.inbox.set(record.raw.eventId, structuredClone(record));
    return true;
  }
  async listPendingInbox(): Promise<MatrixCvp3InboxRecord[]> {
    return [...this.inbox.values()].filter(record => record.status === "pending").map(record => structuredClone(record));
  }
  async listInbox(): Promise<MatrixCvp3InboxRecord[]> {
    return [...this.inbox.values()].map(record => structuredClone(record));
  }
  async updateInbox(
    eventId: string,
    update: Pick<MatrixCvp3InboxRecord, "status" | "error">,
  ): Promise<void> {
    const record = this.inbox.get(eventId);
    if (!record) throw new Error(`Unknown raw Matrix event ${eventId}`);
    this.inbox.set(eventId, {
      ...record,
      status: update.status,
      ...(update.error ? { error: update.error } : { error: undefined }),
    });
  }
  async loadProjection(): Promise<unknown | null> {
    return this.projectionState ? structuredClone(this.projectionState) : null;
  }
  async saveProjection(state: MatrixCvp3ProjectionState): Promise<void> {
    this.projectionState = structuredClone(state);
  }
  async clearProjection(): Promise<void> {
    this.projectionState = null;
  }
}

function toCvp3Command(
  payload: CommandPayload,
  config: MatrixCvp3ClientConfig,
  deviceId: string,
  certificateId: string,
): Cvp3Command {
  const common = {
    kind: "codever.command" as const,
    version: 3 as const,
    commandId: crypto.randomUUID(),
    workspaceId: config.workspaceId,
    projectId: config.projectId,
    deviceId,
    certificateId,
    createdAt: Date.now(),
  };
  switch (payload.operation) {
    case "session.create":
      if (payload.cwd || payload.projectName) {
        throw new Error("A CVP/3 project is a Matrix room; create or select a project room instead of changing cwd per session.");
      }
      return {
        ...common,
        sessionId: crypto.randomUUID(),
        operation: "session.create",
        payload: {
          operation: "session.create",
          ...(payload.provider ? { provider: payload.provider } : {}),
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
          ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
          ...(payload.extensions ? { extensions: payload.extensions } : {}),
        },
      };
    case "prompt":
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "prompt.submit",
        payload: {
          operation: "prompt.submit",
          text: payload.text,
          ...(payload.attachments ? { attachments: payload.attachments } : {}),
        },
      };
    case "cancel":
      if (!payload.targetCommandId) throw new Error("The active turn ID is required to cancel a CVP/3 turn.");
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "turn.cancel",
        payload: { operation: "turn.cancel", turnId: payload.targetCommandId },
      };
    case "decision":
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "decision.answer",
        payload: {
          operation: "decision.answer",
          requestId: payload.requestId,
          decision: payload.decision,
        },
      };
    case "session.settings": {
      if (payload.cwd || payload.projectName) {
        throw new Error("Project directory changes belong to a project room in CVP/3.");
      }
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "session.update",
        payload: {
          operation: "session.update",
          patch: {
            ...(payload.provider ? { provider: payload.provider } : {}),
            ...(payload.model ? { model: payload.model } : {}),
            ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
            ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
          },
        },
      };
    }
    case "session.archive":
    case "session.restore":
    case "session.delete":
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "session.set_lifecycle",
        payload: {
          operation: "session.set_lifecycle",
          state: payload.operation === "session.archive"
            ? "archived"
            : payload.operation === "session.restore"
              ? "active"
              : "deleted",
        },
      };
    case "device.invite":
      return {
        ...common,
        operation: "device.invitation.create",
        payload: {
          operation: "device.invitation.create",
          ...(payload.lifetimeMs ? { lifetimeMs: payload.lifetimeMs } : {}),
        },
      };
  }
}

function threadRelation(rootEventId: string) {
  return {
    rel_type: "m.thread",
    event_id: rootEventId,
    is_falling_back: true,
    "m.in_reply_to": { event_id: rootEventId },
  };
}

function transactionId(commandId: string): string {
  return `codever.v3.command.${commandId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
