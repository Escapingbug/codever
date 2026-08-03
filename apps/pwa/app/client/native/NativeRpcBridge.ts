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

/** Shape injected by AndroidX WebKit, WebView2, or WKWebView adapters. */
export type NativeBridgePort = {
  postMessage(message: string): void;
  onmessage?: ((event: NativeBridgeMessageEvent) => void) | null;
};

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
    timeoutMs = 15_000,
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
