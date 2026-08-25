import {
  BridgeProtocolError,
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  parseEventsDeliverNotification,
  parseMethodRpcResponse,
  parseRpcResponse,
  type BridgeContext,
  type BridgeMethodParams,
  type BridgeMethodResults,
  type CapabilityRequest,
  type EventsDeliverNotification,
  type HelloResult,
  type RequestMethod,
} from "@codever/native-bridge";

export type NativeBridgeMessageEvent = { data: unknown };

export const NATIVE_BRIDGE_DEFAULT_TIMEOUT_MS = 15_000;
export const NATIVE_HISTORY_PAGE_TIMEOUT_MS = 60_000;
export const NATIVE_PAIRING_COMPLETE_TIMEOUT_MS = 10 * 60_000;
export const NATIVE_COMMAND_CONFLICT_TIMEOUT_MS = 60_000;
export const NATIVE_COMMAND_SEND_TIMEOUT_MS = 3 * 60_000;

export function nativeBridgeRequestTimeoutMs(method: RequestMethod): number {
  switch (method) {
    case "codever.history.page":
      // Android bounds the Matrix relations operation at 45 seconds. Keep the
      // Web deadline strictly above it so the native timeout/error response is
      // never discarded by a simultaneous JavaScript timer.
      return NATIVE_HISTORY_PAGE_TIMEOUT_MS;
    case "codever.pairing.complete":
      return NATIVE_PAIRING_COMPLETE_TIMEOUT_MS;
    case "codever.command.resolveConflict":
      // A conflict decision must remain usable even if a Native Matrix send
      // that started just before it is still reaching its 45-second deadline.
      return NATIVE_COMMAND_CONFLICT_TIMEOUT_MS;
    case "codever.command.send":
      // An older certificate may need one authenticated capability-renewal
      // pairing before the native runtime can durably enqueue the command.
      return NATIVE_COMMAND_SEND_TIMEOUT_MS;
    default:
      return NATIVE_BRIDGE_DEFAULT_TIMEOUT_MS;
  }
}

/** Shape injected by AndroidX WebKit, WebView2, or WKWebView adapters. */
export type NativeBridgePort = {
  postMessage(message: string): void;
  onmessage?: ((event: NativeBridgeMessageEvent) => void) | null;
};

type NativeBridgeLeaseState = {
  tail: Promise<void>;
};

const nativeBridgeLeases = new WeakMap<object, NativeBridgeLeaseState>();

type PendingRequest = {
  complete(input: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
};

export type NativeBridgeHelloOptions = {
  webBuild: string;
  requiredCapabilities: CapabilityRequest[];
  optionalCapabilities?: CapabilityRequest[];
  timeoutMs?: number;
};

export class NativeRpcBridge {
  readonly webInstanceId = crypto.randomUUID();
  #bridgeSessionId: string | null = null;
  #closed = false;
  #nextId = 0;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #eventListeners = new Set<
    (notification: EventsDeliverNotification) => void
  >();
  readonly #onMessage = (event: NativeBridgeMessageEvent) => {
    this.#receive(event.data);
  };

  constructor(
    private readonly port: NativeBridgePort,
    private readonly onProtocolError: (error: unknown) => void = () => {},
    private readonly onClose: () => void = () => {},
  ) {
    if (port.onmessage != null) {
      throw new BridgeProtocolError(
        "INVALID_STATE",
        "The native bridge is already attached to another Web client.",
      );
    }
    port.onmessage = this.#onMessage;
  }

  get bridgeSessionId(): string {
    if (!this.#bridgeSessionId) {
      throw new BridgeProtocolError(
        "BRIDGE_NOT_READY",
        "The native bridge handshake has not completed.",
      );
    }
    return this.#bridgeSessionId;
  }

  async hello(options: NativeBridgeHelloOptions): Promise<HelloResult> {
    return this.request(
      "codever.bridge.hello",
      {
        application: "codever-web",
        webBuild: options.webBuild,
        webInstanceId: this.webInstanceId,
        supportedProtocolVersions: [NATIVE_BRIDGE_PROTOCOL_VERSION],
        requiredCapabilities: options.requiredCapabilities,
        optionalCapabilities: options.optionalCapabilities ?? [],
      },
      options.timeoutMs,
    ).then((result) => {
      this.#bridgeSessionId = result.bridgeSessionId;
      return result;
    });
  }

  request<M extends RequestMethod>(
    method: M,
    params: BridgeMethodParams[M],
    timeoutMs = nativeBridgeRequestTimeoutMs(method),
  ): Promise<BridgeMethodResults[M]> {
    if (this.#closed) {
      return Promise.reject(
        new BridgeProtocolError("INVALID_STATE", "The native bridge is closed."),
      );
    }
    const id = `${this.webInstanceId}:${++this.#nextId}`;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<BridgeMethodResults[M]>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeProtocolError(
          "TIMEOUT",
          `The native bridge did not answer ${method} in time.`,
          { retryable: true },
        ));
      }, Math.max(1, timeoutMs));
      const complete = (input: unknown) => {
        try {
          const methodResponse = parseMethodRpcResponse(method, input, {
            expectedId: id,
          });
          if ("error" in methodResponse) {
            reject(new BridgeProtocolError(
              methodResponse.error.data.errorCode,
              methodResponse.error.message,
              methodResponse.error.data,
            ));
          } else {
            resolve(methodResponse.result);
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          this.onProtocolError(error);
        } finally {
          this.#pending.delete(id);
          globalThis.clearTimeout(timeout);
        }
      };
      this.#pending.set(id, { complete, reject, timeout });
      try {
        this.port.postMessage(message);
      } catch (error) {
        globalThis.clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  context(): BridgeContext {
    return { bridgeSessionId: this.bridgeSessionId };
  }

  onEvents(listener: (notification: EventsDeliverNotification) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.port.onmessage === this.#onMessage) this.port.onmessage = null;
    const error = new BridgeProtocolError(
      "INVALID_STATE",
      "The hosted UI detached from the native bridge.",
      { retryable: true },
    );
    for (const pending of this.#pending.values()) {
      globalThis.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#eventListeners.clear();
    this.onClose();
  }

  #receive(input: unknown): void {
    try {
      const raw = typeof input === "string" ? input : String(input);
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        !Object.hasOwn(parsed, "id")
      ) {
        const notification = parseEventsDeliverNotification(parsed);
        for (const listener of this.#eventListeners) listener(notification);
        return;
      }
      const response = parseRpcResponse(parsed);
      const pending = this.#pending.get(response.id as string);
      if (!pending) return;
      pending.complete(parsed);
    } catch (error) {
      // A malformed or unsolicited message is isolated from valid in-flight
      // requests. Its request cannot be safely correlated, so none are failed.
      this.onProtocolError(error);
    }
  }
}

/**
 * Serializes ownership of an injected native port. A persistent native client
 * holds its lease until dispose(), while short bootstrap operations release it
 * in their finally block. This lets a superseding startup wait for the old Web
 * client to detach instead of misreporting it as a second WebView.
 */
export async function acquireNativeRpcBridge(
  port: NativeBridgePort,
  onProtocolError: (error: unknown) => void = () => {},
): Promise<NativeRpcBridge> {
  const previous = nativeBridgeLeases.get(port)?.tail ?? Promise.resolve();
  let releaseLease = () => {};
  const released = new Promise<void>((resolve) => {
    releaseLease = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => released);
  nativeBridgeLeases.set(port, { tail });

  await previous.catch(() => undefined);

  let active = true;
  const release = () => {
    if (!active) return;
    active = false;
    releaseLease();
    void tail.then(() => {
      if (nativeBridgeLeases.get(port)?.tail === tail) {
        nativeBridgeLeases.delete(port);
      }
    });
  };

  try {
    return new NativeRpcBridge(port, onProtocolError, release);
  } catch (error) {
    release();
    throw error;
  }
}

export function injectedNativeBridgePort(
  value: unknown = typeof window === "undefined"
    ? undefined
    : (window as Window & { codeverNative?: unknown }).codeverNative,
): NativeBridgePort | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NativeBridgePort>;
  if (typeof candidate.postMessage !== "function") return null;
  return candidate as NativeBridgePort;
}
