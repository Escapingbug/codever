type ResponseWaiter<T> = {
  resolve(value: T): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
};

type PendingResponse<T> = {
  id: string;
  key: string;
  expiresAt: number;
  expiry: ReturnType<typeof globalThis.setTimeout>;
  waiters: Set<ResponseWaiter<T>>;
  timedOutWaiters: number;
};

export type ResolvedResponse = {
  activeWaiters: number;
  late: boolean;
};

export function createDetachedSerialDispatcher<T>(
  work: (value: T) => Promise<void>,
  onError: (error: unknown) => void,
): (value: T) => void {
  let chain: Promise<void> = Promise.resolve();
  return (value) => {
    const operation = chain.then(() => work(value));
    chain = operation.catch((error) => {
      onError(error);
    });
  };
}

/**
 * Keeps an outbound request alive after an individual UI wait times out.
 * A retry for the same logical key attaches to the original request, while a
 * response that arrives with no active waiter can still be surfaced as a late
 * recovery. The protocol expiry is the only point that discards the request.
 */
export class LateResponseLifecycle<T> {
  readonly #byId = new Map<string, PendingResponse<T>>();
  readonly #byKey = new Map<string, string>();

  constructor(
    private readonly onExpired: (id: string) => void = () => {},
  ) {}

  register(id: string, key: string, expiresAt: number): void {
    if (this.#byId.has(id) || this.#byKey.has(key)) {
      throw new Error("A matching late-response request is already registered.");
    }
    const entry: PendingResponse<T> = {
      id,
      key,
      expiresAt,
      expiry: globalThis.setTimeout(() => {
        if (this.#byId.get(id) !== entry) return;
        this.onExpired(id);
        this.reject(
          id,
          new Error("The request expired before its response arrived."),
        );
      }, Math.max(0, expiresAt - Date.now())),
      waiters: new Set(),
      timedOutWaiters: 0,
    };
    this.#byId.set(id, entry);
    this.#byKey.set(key, id);
  }

  idForKey(key: string): string | undefined {
    return this.#byKey.get(key);
  }

  wait(
    id: string,
    timeoutMs: number,
    timeoutError: () => Error,
  ): Promise<T> {
    const entry = this.#byId.get(id);
    if (!entry) {
      return Promise.reject(new Error("The request is no longer pending."));
    }
    return new Promise((resolve, reject) => {
      const waiter: ResponseWaiter<T> = {
        resolve,
        reject,
        timeout: globalThis.setTimeout(() => {
          if (!entry.waiters.delete(waiter)) return;
          entry.timedOutWaiters += 1;
          reject(timeoutError());
        }, Math.max(0, timeoutMs)),
      };
      entry.waiters.add(waiter);
    });
  }

  extend(id: string, expiresAt: number): void {
    const entry = this.#byId.get(id);
    if (!entry || expiresAt <= entry.expiresAt) return;
    globalThis.clearTimeout(entry.expiry);
    entry.expiresAt = expiresAt;
    entry.expiry = globalThis.setTimeout(() => {
      if (this.#byId.get(id) !== entry) return;
      this.onExpired(id);
      this.reject(
        id,
        new Error("The response could not be completed before expiry."),
      );
    }, Math.max(0, expiresAt - Date.now()));
  }

  resolve(id: string, value: T): ResolvedResponse | null {
    const entry = this.#take(id);
    if (!entry) return null;
    const activeWaiters = entry.waiters.size;
    for (const waiter of entry.waiters) {
      globalThis.clearTimeout(waiter.timeout);
      waiter.resolve(value);
    }
    return {
      activeWaiters,
      late: entry.timedOutWaiters > 0,
    };
  }

  reject(id: string, error: Error): boolean {
    const entry = this.#take(id);
    if (!entry) return false;
    for (const waiter of entry.waiters) {
      globalThis.clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    return true;
  }

  close(error: Error): void {
    for (const id of [...this.#byId.keys()]) this.reject(id, error);
  }

  get size(): number {
    return this.#byId.size;
  }

  #take(id: string): PendingResponse<T> | null {
    const entry = this.#byId.get(id);
    if (!entry) return null;
    this.#byId.delete(id);
    if (this.#byKey.get(entry.key) === id) this.#byKey.delete(entry.key);
    globalThis.clearTimeout(entry.expiry);
    for (const waiter of entry.waiters) globalThis.clearTimeout(waiter.timeout);
    return entry;
  }
}
