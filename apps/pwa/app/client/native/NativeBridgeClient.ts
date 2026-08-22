import {
  BridgeProtocolError,
  NATIVE_BRIDGE_LIMITS,
  parseClientMessage,
  parseCommandView,
  parsePublicTrustState,
  type BridgeMethodParams,
  type ClientBootstrapResult,
  type ClientEvent,
  type ClientSnapshot,
  type CommandReceipt,
  type CommandView,
  type HelloResult,
  type JsonObject,
} from "@codever/native-bridge";
import type { CodeverAttachment, CommandPayload } from "@codever/protocol";
import {
  CommandAcknowledgementTimeoutError,
  CommandCompletionExpiredError,
  CommandCompletionTimeoutError,
  type CommandCompletion,
} from "../../commandLifecycle";
import { parseGatewayStateExtension } from "../../gatewayState";
import {
  MatrixRateLimitError,
  type MatrixLoginTokenResult,
} from "../../matrixAuth";
import type {
  CodeverClient,
  CodeverClientHandlers,
  CodeverCommandReview,
  CodeverCommandSendResult,
  CodeverHistoryPage,
  CodeverPublicTrust,
} from "../CodeverClient";
import { CommandReviewRequiredError } from "../CodeverClient";
import { NativeRpcBridge } from "./NativeRpcBridge";
import { NATIVE_CURSOR_STORAGE_PREFIX } from "./storageKeys";

export const REQUIRED_NATIVE_CAPABILITIES = [
  "client.lifecycle",
  "events.replay",
  "state.snapshot",
  "commands.durable",
  "history.page",
  "attachments.chunked",
  "pairing.native",
  "trust.native",
  "matrix.session-bootstrap",
  "background.foreground-service",
] as const;

export const OPTIONAL_NATIVE_CAPABILITIES = ["matrix.login-token"] as const;

export function nativeCapabilityVersions(
  name: (typeof REQUIRED_NATIVE_CAPABILITIES)[number] |
    (typeof OPTIONAL_NATIVE_CAPABILITIES)[number],
): number[] {
  // v2 separates local projection reads from explicit Matrix pagination.
  // Request v1 as a negotiation fallback only so an older APK can return an
  // actionable update requirement instead of failing the hello handshake.
  return name === "history.page" ? [2, 1] : [1];
}

export function hasCurrentNativeCapability(
  hello: HelloResult,
  name: (typeof REQUIRED_NATIVE_CAPABILITIES)[number],
): boolean {
  return hello.capabilities[name]?.version ===
    (name === "history.page" ? 2 : 1);
}

const DEFAULT_COMMAND_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_COMMAND_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_BLOCKED_COMMAND_RETRY_WINDOW_MS = 2 * 60_000;
type Acknowledgement = {
  commandId: string;
  sequence: number;
  revision: number;
};

type AcknowledgementWaiter = {
  commandId: string;
  sequence: number;
  resolve(acknowledgement: Acknowledgement): void;
  reject(error: Error): void;
};

type CompletionWaiter = {
  resolve(value: CommandCompletion): void;
  reject(error: Error): void;
};

type BlockingCommand = CodeverCommandReview & {
  state: "queued" | "transmitting" | "recovery_required" | "needs_review";
};

export type NativeBootstrapInput = Omit<
  BridgeMethodParams["codever.client.bootstrap"],
  "context" | "idempotencyKey"
>;

export type NativeCursorStore = {
  load(deviceId: string): string | undefined;
  save(deviceId: string, cursor: string): void;
};

const defaultCursorStore: NativeCursorStore = {
  load(deviceId) {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage.getItem(`${NATIVE_CURSOR_STORAGE_PREFIX}.${deviceId}`) ?? undefined;
  },
  save(deviceId, cursor) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`${NATIVE_CURSOR_STORAGE_PREFIX}.${deviceId}`, cursor);
  },
};

export class NativeBridgeClient implements CodeverClient {
  readonly runtime = "native" as const;
  readonly ready: Promise<void>;
  #deviceId = "";
  #deviceName = "Codever native device";
  #subscriptionId: string | null = null;
  #disposed = false;
  #detachEventListener: (() => void) | null = null;
  #eventChain: Promise<void> = Promise.resolve();
  readonly #historyBefore = new Map<string, string>();
  readonly #commandOperations = new Map<string, string>();
  readonly #reviewCommands = new Map<string, string>();
  readonly #acknowledgements = new Map<string, Acknowledgement>();
  readonly #acknowledgementWaiters = new Map<string, AcknowledgementWaiter>();
  readonly #completions = new Map<string, CommandCompletion>();
  readonly #completionWaiters = new Map<string, Set<CompletionWaiter>>();
  readonly #loadedHistoryEventIds = new Map<string, Set<string>>();

  constructor(
    private readonly bridge: NativeRpcBridge,
    private readonly helloResult: HelloResult,
    private readonly handlers: CodeverClientHandlers,
    private readonly cursorStore: NativeCursorStore = defaultCursorStore,
  ) {
    assertFullNativeCapabilities(helloResult);
    this.ready = this.#initialize().catch((error) => {
      this.#detachEventListener?.();
      this.#detachEventListener = null;
      this.bridge.close();
      throw error;
    });
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  get deviceName(): string {
    return this.#deviceName;
  }

  async pair(
    pairingLink: string,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<CodeverPublicTrust> {
    await this.ready;
    throwIfAborted(signal);
    const preview = await this.bridge.request("codever.pairing.inspect", {
      context: this.bridge.context(),
      link: pairingLink,
    });
    throwIfAborted(signal);
    const completion = this.bridge.request("codever.pairing.complete", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      pairingId: preview.pairingId,
      deviceName,
    });
    const result = await withPairingAbort(
      completion,
      signal,
    );
    this.#applySnapshot(result.snapshot);
    this.#deviceName = deviceName;
    return result.trust;
  }

  async send(payload: CommandPayload): Promise<CodeverCommandSendResult> {
    await this.ready;
    const idempotencyKey = crypto.randomUUID();
    const receipt = await this.#sendWhenOutboxAvailable(payload, idempotencyKey);
    return this.#sendResult(receipt);
  }

  async requestMatrixLoginToken(
    invitationId: string,
    password?: string,
  ): Promise<MatrixLoginTokenResult> {
    await this.ready;
    if (this.helloResult.capabilities["matrix.login-token"]?.version !== 1) {
      throw new BridgeProtocolError(
        "CAPABILITY_UNAVAILABLE",
        "The installed native app cannot create another-device Matrix sign-ins. Update the native app and retry.",
        { userAction: "update_native" },
      );
    }
    try {
      return await this.bridge.request(
        "codever.matrix.loginToken",
        {
          context: this.bridge.context(),
          idempotencyKey: crypto.randomUUID(),
          invitationId,
          ...(password === undefined ? {} : { password }),
        },
        45_000,
      );
    } catch (error) {
      if (error instanceof BridgeProtocolError && error.errorCode === "RATE_LIMITED") {
        throw new MatrixRateLimitError(error.data.retryAfterMs ?? 60_000);
      }
      throw error;
    }
  }

  async recoverCommand(commandId: string): Promise<CodeverCommandSendResult> {
    await this.ready;
    const receipt = await this.bridge.request("codever.command.recover", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      commandId,
    });
    // A terminal command may have completed while the WebView was stopped or
    // while an APK update replaced it. Its command.changed notification is not
    // replayed forever, so the recovery receipt alone is insufficient: a
    // receipt intentionally omits the persisted completion payload. Hydrate
    // the current durable view before installing a new completion waiter.
    //
    // The native outbox may also re-key an unacknowledged command when the
    // Gateway revision epoch changes. In that case `receipt.commandId` is the
    // current identity, while `commandId` is a retired alias retained only for
    // exact recovery.
    if (receipt.commandId) {
      const current = await this.bridge.request("codever.command.get", {
        context: this.bridge.context(),
        commandId: receipt.commandId,
      });
      this.#recordCommand(current);
    }
    return this.#sendResult(receipt);
  }

  async confirmRevisionRetry(commandId: string): Promise<CodeverCommandSendResult> {
    await this.ready;
    const receipt = await this.bridge.request("codever.command.resolveConflict", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      commandId,
      action: "retry",
    });
    return this.#sendResult(receipt);
  }

  async discardRevisionConflict(commandId: string): Promise<void> {
    await this.ready;
    const receipt = await this.bridge.request("codever.command.resolveConflict", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      commandId,
      action: "discard",
    });
    await this.releaseCommand(receipt.commandId ?? commandId);
  }

  async uploadAttachment(file: File): Promise<CodeverAttachment> {
    await this.ready;
    if (file.size > NATIVE_BRIDGE_LIMITS.maxAttachmentBytes) {
      throw new BridgeProtocolError(
        "ATTACHMENT_TOO_LARGE",
        "Attachment exceeds the native bridge limit.",
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await sha256Base64Url(bytes);
    const opened = await this.bridge.request("codever.attachment.upload.open", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: bytes.byteLength,
      sha256: digest,
    });
    try {
      let index = opened.nextIndex;
      while (index * opened.chunkBytes < bytes.byteLength) {
        const start = index * opened.chunkBytes;
        const chunk = bytes.subarray(start, start + opened.chunkBytes);
        const acknowledged = await this.bridge.request(
          "codever.attachment.upload.chunk",
          {
            context: this.bridge.context(),
            transferId: opened.transferId,
            index,
            dataBase64Url: base64UrlEncode(chunk),
            chunkSha256: await sha256Base64Url(chunk),
          },
          30_000,
        );
        if (
          acknowledged.transferId !== opened.transferId ||
          acknowledged.index !== index ||
          acknowledged.nextIndex <= index
        ) {
          throw new BridgeProtocolError(
            "CHUNK_CONFLICT",
            "The native attachment upload acknowledged a different chunk.",
          );
        }
        index = acknowledged.nextIndex;
      }
      const finished = await this.bridge.request(
        "codever.attachment.upload.finish",
        {
          context: this.bridge.context(),
          idempotencyKey: crypto.randomUUID(),
          transferId: opened.transferId,
        },
        60_000,
      );
      return finished.attachment;
    } catch (error) {
      void this.bridge.request("codever.attachment.upload.abort", {
        context: this.bridge.context(),
        idempotencyKey: crypto.randomUUID(),
        transferId: opened.transferId,
      }).catch(() => {});
      throw error;
    }
  }

  async downloadAttachment(attachment: CodeverAttachment): Promise<Blob> {
    await this.ready;
    const opened = await this.bridge.request("codever.attachment.download.open", {
      context: this.bridge.context(),
      attachment,
    });
    const chunks: Uint8Array[] = [];
    try {
      for (let index = 0; index < opened.chunkCount; index += 1) {
        const part = await this.bridge.request(
          "codever.attachment.download.read",
          {
            context: this.bridge.context(),
            transferId: opened.transferId,
            index,
          },
          30_000,
        );
        if (part.transferId !== opened.transferId || part.index !== index) {
          throw new BridgeProtocolError(
            "CHUNK_CONFLICT",
            "The native attachment download returned a different chunk.",
          );
        }
        const chunk = base64UrlDecode(part.dataBase64Url);
        if ((await sha256Base64Url(chunk)) !== part.chunkSha256) {
          throw new BridgeProtocolError("HASH_MISMATCH", "Attachment chunk hash mismatch.");
        }
        if (part.eof !== (index === opened.chunkCount - 1)) {
          throw new BridgeProtocolError("CHUNK_CONFLICT", "Attachment EOF marker is invalid.");
        }
        chunks.push(chunk);
      }
      const bytes = concatenate(chunks, opened.size);
      if ((await sha256Base64Url(bytes)) !== opened.sha256) {
        throw new BridgeProtocolError("HASH_MISMATCH", "Attachment hash mismatch.");
      }
      return new Blob([toArrayBuffer(bytes)], { type: attachment.mimeType });
    } finally {
      void this.bridge.request("codever.attachment.download.close", {
        context: this.bridge.context(),
        transferId: opened.transferId,
      }).catch(() => {});
    }
  }

  markHistoryLoaded(sessionId: string, eventIds: readonly string[]): void {
    const loaded = this.#loadedHistoryEventIds.get(sessionId) ?? new Set<string>();
    eventIds.forEach((eventId) => loaded.add(eventId));
    this.#loadedHistoryEventIds.set(sessionId, loaded);
  }

  async loadLocalHistory(
    sessionId: string,
  ): Promise<CodeverHistoryPage> {
    this.#historyBefore.delete(sessionId);
    const loaded = this.#loadedHistoryEventIds.get(sessionId) ?? new Set<string>();
    const recovered = new Map<string, CodeverHistoryPage["messages"][number]>();
    let hasMore = false;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await this.#loadHistory(sessionId, 100, this.#historyBefore.get(sessionId), "local");
      let reachedLoadedWindow = false;
      for (const message of page.messages) {
        if (loaded.has(message.eventId)) {
          reachedLoadedWindow = true;
          continue;
        }
        recovered.set(message.eventId, message);
      }
      hasMore = page.hasMore;
      if (
        reachedLoadedWindow ||
        !page.hasMore ||
        !this.#historyBefore.has(sessionId)
      ) break;
    }
    return {
      messages: [...recovered.values()].sort(
        (left, right) =>
          left.timestamp - right.timestamp ||
          left.eventId.localeCompare(right.eventId),
      ),
      hasMore,
    };
  }

  async loadHistoryPage(
    sessionId: string,
    limit = 30,
  ): Promise<CodeverHistoryPage> {
    return this.#loadHistory(
      sessionId,
      limit,
      this.#historyBefore.get(sessionId),
      "matrix",
    );
  }

  async observeCommandCompletion(
    commandId: string,
    timeoutMs: number,
  ): Promise<CommandCompletion> {
    await this.ready;
    const current = await this.bridge.request("codever.command.get", {
      context: this.bridge.context(),
      commandId,
    });
    this.#recordCommand(current);
    const completed = this.#completions.get(commandId);
    if (completed) return completed;
    return this.#waitForCompletion(
      commandId,
      timeoutMs,
      () => new CommandCompletionTimeoutError(),
    );
  }

  async releaseCommand(commandId: string): Promise<void> {
    await this.ready;
    await this.bridge.request("codever.command.release", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      commandId,
    });
    this.#completions.delete(commandId);
    const operationId = this.#commandOperations.get(commandId);
    if (operationId) {
      this.#acknowledgements.delete(operationId);
      for (const [knownCommandId, knownOperationId] of this.#commandOperations) {
        if (knownOperationId === operationId) {
          this.#commandOperations.delete(knownCommandId);
        }
      }
    } else {
      this.#commandOperations.delete(commandId);
    }
    this.#rejectCompletion(commandId, new CommandCompletionExpiredError(commandId));
  }

  async disconnect(): Promise<void> {
    await this.ready;
    if (this.#disposed) return;
    this.#disposed = true;
    this.#detachEventListener?.();
    this.#detachEventListener = null;
    this.#subscriptionId = null;
    this.#rejectAcknowledgements(
      new BridgeProtocolError("INVALID_STATE", "The native bridge is closed."),
    );
    await this.bridge.request("codever.client.disconnect", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      mode: "stop",
    });
    this.bridge.close();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rejectAcknowledgements(
      new BridgeProtocolError("INVALID_STATE", "The native bridge is closed."),
    );
    this.#detachEventListener?.();
    this.#detachEventListener = null;
    const subscriptionId = this.#subscriptionId;
    this.#subscriptionId = null;
    if (!subscriptionId) {
      this.bridge.close();
      return;
    }
    // Posting the unsubscribe is synchronous. Release the injected port
    // immediately afterwards so a bootstrap/reconnect can acquire it without
    // racing the asynchronous native acknowledgement.
    void this.bridge.request("codever.events.unsubscribe", {
      context: this.bridge.context(),
      subscriptionId,
    })
      .catch(() => undefined);
    this.bridge.close();
  }

  async #initialize(): Promise<void> {
    this.#detachEventListener = this.bridge.onEvents((notification) => {
      if (notification.params.subscriptionId !== this.#subscriptionId) return;
      this.#eventChain = this.#eventChain
        .then(() => this.#acceptEvents(notification.params.events, true))
        .catch((error) => {
          this.handlers.onStatus("error", formatError(error));
        });
    });
    const started = await this.bridge.request("codever.client.start", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
    });
    this.#deviceId = started.deviceId;
    this.#applySnapshot(started.snapshot);
    const subscribed = await this.bridge.request("codever.events.subscribe", {
      context: this.bridge.context(),
      afterCursor: this.cursorStore.load(this.#deviceId),
      maxReplayEvents: NATIVE_BRIDGE_LIMITS.maxReplayEvents,
    });
    this.#subscriptionId = subscribed.subscriptionId;
    if (subscribed.mode === "snapshot") {
      this.#applySnapshot(subscribed.snapshot);
    } else {
      await this.#acceptEvents(subscribed.events, false);
    }
    await this.bridge.request("codever.events.activate", {
      context: this.bridge.context(),
      subscriptionId: subscribed.subscriptionId,
      throughCursor: subscribed.barrierCursor,
    });
    this.cursorStore.save(this.#deviceId, subscribed.barrierCursor);
  }

  async #acceptEvents(events: ClientEvent[], acknowledge: boolean): Promise<void> {
    for (const event of events) this.#acceptEvent(event);
    const throughCursor = events.at(-1)?.cursor;
    if (!throughCursor || !this.#subscriptionId) return;
    if (acknowledge) {
      await this.bridge.request("codever.events.ack", {
        context: this.bridge.context(),
        subscriptionId: this.#subscriptionId,
        throughCursor,
      });
    }
    if (acknowledge) this.cursorStore.save(this.#deviceId, throughCursor);
  }

  #acceptEvent(event: ClientEvent): void {
    switch (event.type) {
      case "message.upserted":
        this.handlers.onMessage(parseClientMessage(event.payload));
        break;
      case "command.changed":
        this.#recordCommand(parseCommandView(event.payload));
        break;
      case "trust.changed": {
        const trust = parsePublicTrustState(event.payload);
        this.handlers.onTrustUpdated?.(trust.state === "trusted" ? trust : null);
        break;
      }
      case "client.status.changed": {
        const status = parseStatusPayload(event.payload);
        this.handlers.onStatus(status.status, status.detail);
        break;
      }
      case "gateway.state.changed":
        this.#applyGatewayState(event.payload);
        break;
      case "message.removed":
      case "attachment.changed":
      case "pairing.changed":
        break;
    }
  }

  #applySnapshot(snapshot: ClientSnapshot): void {
    this.#deviceId = snapshot.deviceId;
    this.handlers.onStatus(
      matrixStatus(snapshot.lifecycle.phase),
      snapshot.lifecycle.detailCode,
    );
    this.handlers.onTrustUpdated?.(
      snapshot.trust.state === "trusted" ? snapshot.trust : null,
    );
    snapshot.commands.forEach((command) => this.#recordCommand(command));
    if (snapshot.gatewayState) this.#applyGatewayState(snapshot.gatewayState);
  }

  #applyGatewayState(input: unknown): void {
    const gatewayState = parseGatewayStateExtension(input);
    if (!gatewayState) return;
    this.handlers.onCollaborationState?.({
      activeDeviceCount: gatewayState.activeDeviceCount,
      revision: gatewayState.revision,
      gatewayState,
    });
  }

  #recordCommand(command: CommandView): void {
    if (command.commandId) {
      this.#commandOperations.set(command.commandId, command.operationId);
    }
    if (command.commandId && command.state === "needs_review") {
      const review: CodeverCommandReview = { commandId: command.commandId };
      this.#reviewCommands.set(command.operationId, command.commandId);
      const waiter = this.#acknowledgementWaiters.get(command.operationId);
      if (waiter) {
        this.#acknowledgementWaiters.delete(command.operationId);
        waiter.reject(new CommandReviewRequiredError(review));
      }
      this.handlers.onCommandReviewRequired?.(review);
    } else if (this.#reviewCommands.delete(command.operationId)) {
      this.handlers.onCommandReviewRequired?.(null);
    }
    if (
      command.commandId &&
      command.sequence !== undefined &&
      command.revision !== undefined
    ) {
      this.#recordAcknowledgement(
        command.operationId,
        command.commandId,
        command.sequence,
        command.revision,
      );
    }
    const completion = command.completion;
    if (!completion) return;
    const normalized: CommandCompletion = {
      commandId: completion.commandId,
      sequence: completion.sequence,
      revision: completion.revision,
      outcome: completion.outcome,
      ...(completion.sessionId === undefined
        ? {}
        : { sessionId: completion.sessionId }),
      ...(completion.result === undefined ? {} : { result: completion.result }),
      ...(completion.error === undefined ? {} : { error: completion.error }),
    };
    this.#completions.set(completion.commandId, normalized);
    this.handlers.onCommandResult?.(normalized);
    const waiters = this.#completionWaiters.get(completion.commandId);
    if (!waiters) return;
    this.#completionWaiters.delete(completion.commandId);
    waiters.forEach((waiter) => waiter.resolve(normalized));
  }

  async #sendWhenOutboxAvailable(
    payload: CommandPayload,
    idempotencyKey: string,
  ): Promise<CommandReceipt> {
    const deadline = Date.now() + DEFAULT_BLOCKED_COMMAND_RETRY_WINDOW_MS;
    while (true) {
      try {
        return await this.bridge.request("codever.command.send", {
          context: this.bridge.context(),
          idempotencyKey,
          payload: { ...jsonObject(payload), operation: payload.operation },
        });
      } catch (error) {
        const blocking = parseBlockingCommand(error);
        if (!blocking) throw error;
        if (blocking.state === "needs_review") {
          this.handlers.onCommandReviewRequired?.(blocking);
          throw new CommandReviewRequiredError(blocking);
        }
        if (
          !(error instanceof BridgeProtocolError) ||
          !error.data.retryable ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        const retryAfterMs = Math.max(
          250,
          Math.min(error.data.retryAfterMs ?? 1_000, 5_000),
        );
        await delay(retryAfterMs);
      }
    }
  }

  async #sendResult(receipt: CommandReceipt): Promise<CodeverCommandSendResult> {
    if (!receipt.commandId || receipt.sequence === undefined) {
      throw new BridgeProtocolError(
        "INVALID_REQUEST",
        "Native command receipt omitted its durable command identity.",
      );
    }
    const commandId = receipt.commandId;
    const sequence = receipt.sequence;
    this.#commandOperations.set(commandId, receipt.operationId);
    if (receipt.state === "needs_review") {
      const review: CodeverCommandReview = { commandId };
      this.#reviewCommands.set(receipt.operationId, commandId);
      this.handlers.onCommandReviewRequired?.(review);
      throw new CommandReviewRequiredError(review);
    }
    const acknowledgement = receipt.revision === undefined
      ? await this.#waitForAcknowledgement(
          receipt.operationId,
          commandId,
          sequence,
        )
      : { commandId, sequence, revision: receipt.revision };
    const completion = this.#waitForCompletion(
      acknowledgement.commandId,
      DEFAULT_COMMAND_TIMEOUT_MS,
      () => new CommandCompletionExpiredError(acknowledgement.commandId),
    );
    return {
      operationId: receipt.operationId,
      commandId: acknowledgement.commandId,
      sequence: acknowledgement.sequence,
      revision: acknowledgement.revision,
      completion,
    };
  }

  #recordAcknowledgement(
    operationId: string,
    commandId: string,
    sequence: number,
    revision: number,
  ): void {
    this.#commandOperations.set(commandId, operationId);
    const current = this.#acknowledgements.get(operationId);
    if (
      !current ||
      current.commandId !== commandId ||
      sequence > current.sequence ||
      (sequence === current.sequence && revision > current.revision)
    ) {
      this.#acknowledgements.set(operationId, { commandId, sequence, revision });
    }
    const waiter = this.#acknowledgementWaiters.get(operationId);
    if (!waiter) return;
    // A Gateway revision-epoch migration preserves the stable native
    // operation while issuing a fresh command id and sequence. The receipt
    // may already be in JavaScript when that migration happens, so match the
    // replacement by operation id instead of waiting forever for the retired
    // sequence. Events for one operation are delivered in native cursor order.
    if (waiter.commandId === commandId && waiter.sequence !== sequence) return;
    this.#acknowledgementWaiters.delete(operationId);
    waiter.resolve({ commandId, sequence, revision });
  }

  #waitForAcknowledgement(
    operationId: string,
    commandId: string,
    sequence: number,
  ): Promise<Acknowledgement> {
    const acknowledged = this.#acknowledgements.get(operationId);
    if (
      acknowledged &&
      (acknowledged.commandId !== commandId || acknowledged.sequence === sequence)
    ) {
      return Promise.resolve(acknowledged);
    }
    return new Promise((resolve, reject) => {
      const accept = (acknowledgement: Acknowledgement) => {
        globalThis.clearTimeout(timeout);
        resolve(acknowledgement);
      };
      const timeout = globalThis.setTimeout(() => {
        const current = this.#acknowledgementWaiters.get(operationId);
        if (current?.resolve === accept) {
          this.#acknowledgementWaiters.delete(operationId);
        }
        reject(new CommandAcknowledgementTimeoutError(
          current?.commandId ?? commandId,
          sequence,
        ));
      }, DEFAULT_COMMAND_ACKNOWLEDGEMENT_TIMEOUT_MS);
      this.#acknowledgementWaiters.set(operationId, {
        commandId,
        sequence,
        resolve: accept,
        reject: (error) => {
          globalThis.clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  #rejectAcknowledgements(error: Error): void {
    const waiters = [...this.#acknowledgementWaiters.values()];
    this.#acknowledgementWaiters.clear();
    waiters.forEach((waiter) => waiter.reject(error));
  }

  #waitForCompletion(
    commandId: string,
    timeoutMs: number,
    timeoutError: () => Error,
  ): Promise<CommandCompletion> {
    const completed = this.#completions.get(commandId);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve, reject) => {
      const waiters = this.#completionWaiters.get(commandId) ?? new Set();
      const remove = () => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.#completionWaiters.delete(commandId);
      };
      const timer = globalThis.setTimeout(() => {
        remove();
        reject(timeoutError());
      }, Math.max(1, timeoutMs));
      const waiter: CompletionWaiter = {
        resolve: (completion) => {
          globalThis.clearTimeout(timer);
          remove();
          resolve(completion);
        },
        reject: (error) => {
          globalThis.clearTimeout(timer);
          remove();
          reject(error);
        },
      };
      waiters.add(waiter);
      this.#completionWaiters.set(commandId, waiters);
    });
  }

  #rejectCompletion(commandId: string, error: Error): void {
    const waiters = this.#completionWaiters.get(commandId);
    if (!waiters) return;
    this.#completionWaiters.delete(commandId);
    waiters.forEach((waiter) => waiter.reject(error));
  }

  async #loadHistory(
    sessionId: string,
    limit: number,
    before: string | undefined,
    source: "local" | "matrix",
  ): Promise<CodeverHistoryPage> {
    await this.ready;
    const page = await this.bridge.request("codever.history.page", {
      context: this.bridge.context(),
      sessionId,
      ...(before === undefined ? {} : { before }),
      limit: Math.max(1, Math.min(limit, 100)),
      source,
    });
    if (page.sessionId !== sessionId) {
      throw new BridgeProtocolError(
        "HISTORY_CURSOR_INVALID",
        "Native history returned a different session.",
      );
    }
    if (page.nextBefore) this.#historyBefore.set(sessionId, page.nextBefore);
    else this.#historyBefore.delete(sessionId);
    return { messages: page.messages, hasMore: page.hasMore };
  }
}

export async function createNativeBridgeClient(
  bridge: NativeRpcBridge,
  hello: HelloResult,
  handlers: CodeverClientHandlers,
  cursorStore?: NativeCursorStore,
): Promise<NativeBridgeClient> {
  const client = new NativeBridgeClient(bridge, hello, handlers, cursorStore);
  await client.ready;
  return client;
}

export async function bootstrapNativeSession(
  bridge: NativeRpcBridge,
  input: NativeBootstrapInput,
): Promise<ClientBootstrapResult> {
  return bridge.request("codever.client.bootstrap", {
    context: bridge.context(),
    idempotencyKey: crypto.randomUUID(),
    ...input,
  });
}

export function assertFullNativeCapabilities(hello: HelloResult): void {
  const missing = REQUIRED_NATIVE_CAPABILITIES.find(
    (name) => !hasCurrentNativeCapability(hello, name),
  );
  if (missing) {
    throw new BridgeProtocolError(
      "CAPABILITY_UNAVAILABLE",
      `Native runtime is missing required capability: ${missing}.`,
      { userAction: "update_native" },
    );
  }
}

function matrixStatus(
  phase: ClientSnapshot["lifecycle"]["phase"],
): Parameters<CodeverClientHandlers["onStatus"]>[0] {
  switch (phase) {
    case "ready": return "connected";
    case "securing": return "securing";
    case "reconnecting": return "reconnecting";
    case "offline":
    case "stopped": return "offline";
    case "blocked": return "error";
    case "starting":
    case "unpaired":
    case "connecting": return "connecting";
  }
}

function parseStatusPayload(input: unknown): {
  status: Parameters<CodeverClientHandlers["onStatus"]>[0];
  detail?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status payload is invalid.");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "phase" && key !== "detail")) {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status payload has unknown fields.");
  }
  if (typeof value.phase !== "string") {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status phase is invalid.");
  }
  const allowed = new Set([
    "stopped", "starting", "unpaired", "connecting", "securing",
    "ready", "reconnecting", "offline", "blocked",
  ]);
  if (!allowed.has(value.phase)) {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status phase is unsupported.");
  }
  if (value.detail !== undefined && typeof value.detail !== "string") {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status detail is invalid.");
  }
  return {
    status: matrixStatus(value.phase as ClientSnapshot["lifecycle"]["phase"]),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}

function jsonObject(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeProtocolError("INVALID_PARAMS", "Value must be a JSON object.");
  }
  return parsed as JsonObject;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

async function withPairingAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      // Detaching or reloading the hosted UI must not revoke a transaction
      // that the user already confirmed in native UI. The service owns that
      // durable request and continues it independently of this waiter.
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes))),
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.byteLength > size) {
      throw new BridgeProtocolError("HASH_MISMATCH", "Attachment size is invalid.");
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== size) {
    throw new BridgeProtocolError("HASH_MISMATCH", "Attachment size is invalid.");
  }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBlockingCommand(error: unknown): BlockingCommand | null {
  if (!(error instanceof BridgeProtocolError)) return null;
  const details = error.data.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  if (details.kind !== "command_blocked" || typeof details.commandId !== "string") {
    return null;
  }
  if (
    details.state !== "queued" &&
    details.state !== "transmitting" &&
    details.state !== "recovery_required" &&
    details.state !== "needs_review"
  ) {
    return null;
  }
  const operation = parseCommandOperation(details.operation);
  const expectedRevision = typeof details.expectedRevision === "number" &&
      Number.isSafeInteger(details.expectedRevision) && details.expectedRevision >= 0
    ? details.expectedRevision
    : undefined;
  return {
    commandId: details.commandId,
    state: details.state,
    ...(operation === undefined ? {} : { operation }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function parseCommandOperation(input: unknown): CommandPayload["operation"] | undefined {
  switch (input) {
    case "session.create":
    case "project.settings":
    case "provider.sessions.list":
    case "provider.session.inspect":
    case "session.settings":
    case "session.archive":
    case "session.restore":
    case "session.delete":
    case "prompt":
    case "cancel":
    case "decision":
    case "device.invite":
      return input;
    default:
      return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
