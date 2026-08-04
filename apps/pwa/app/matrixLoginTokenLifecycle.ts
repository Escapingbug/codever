import {
  MatrixRateLimitError,
  type MatrixLoginTokenResult,
} from "./matrixAuth";

type ReadyMatrixLoginToken = Extract<
  MatrixLoginTokenResult,
  { status: "ready" }
>;

type CachedLoginToken = {
  invitationId: string;
  result: ReadyMatrixLoginToken;
};

type MatrixLoginTokenRequest = {
  invitationId: string;
  invitationExpiresAt: number;
  issue: () => Promise<MatrixLoginTokenResult>;
  onRateLimit?: (remainingMs: number) => void;
};

type MatrixLoginTokenLifecycleOptions = {
  minimumRemainingMs?: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
};

export class MatrixLoginTokenRequestCancelledError extends Error {
  constructor() {
    super("The Matrix login-token request was cleared.");
    this.name = "MatrixLoginTokenRequestCancelledError";
  }
}

/**
 * Keeps a one-time Matrix login token attached to its Gateway invitation until
 * the invitation has been relayed successfully. Rate limits wait and retry the
 * same transaction instead of consuming another Gateway invitation.
 */
export class MatrixLoginTokenLifecycle {
  readonly #minimumRemainingMs: number;
  readonly #now: () => number;
  readonly #sleep: (durationMs: number) => Promise<void>;
  #active: {
    invitationId: string;
    operation: Promise<MatrixLoginTokenResult>;
  } | null = null;
  #cached: CachedLoginToken | null = null;
  #generation = 0;

  constructor(options: MatrixLoginTokenLifecycleOptions = {}) {
    this.#minimumRemainingMs = options.minimumRemainingMs ?? 15_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? wait;
  }

  request(input: MatrixLoginTokenRequest): Promise<MatrixLoginTokenResult> {
    const cached = this.#current(input.invitationId);
    if (cached) return Promise.resolve(cached);
    if (this.#active?.invitationId === input.invitationId) {
      return this.#active.operation;
    }
    if (this.#active) this.clear();

    const generation = this.#generation;
    const operation = this.#issueWithRetry(input, generation);
    this.#active = { invitationId: input.invitationId, operation };
    void operation
      .finally(() => {
        if (this.#active?.operation === operation) this.#active = null;
      })
      .catch(() => undefined);
    return operation;
  }

  clear(): void {
    this.#generation += 1;
    this.#active = null;
    this.#cached = null;
  }

  async #issueWithRetry(
    input: MatrixLoginTokenRequest,
    generation: number,
  ): Promise<MatrixLoginTokenResult> {
    for (;;) {
      this.#assertCurrent(generation);
      try {
        const result = await input.issue();
        this.#assertCurrent(generation);
        if (result.status === "ready") {
          if (!this.#isUsable(result.expiresAt)) {
            throw new Error(
              "The Matrix login token arrived too close to expiry.",
            );
          }
          this.#cached = { invitationId: input.invitationId, result };
        }
        return result;
      } catch (error) {
        this.#assertCurrent(generation);
        if (!(error instanceof MatrixRateLimitError)) throw error;
        await this.#waitForRetry(input, error.retryAfterMs, generation);
      }
    }
  }

  async #waitForRetry(
    input: MatrixLoginTokenRequest,
    retryAfterMs: number,
    generation: number,
  ): Promise<void> {
    const retryAt = this.#now() + retryAfterMs;
    if (retryAt + this.#minimumRemainingMs >= input.invitationExpiresAt) {
      throw new Error(
        "Matrix asked Codever to wait longer than this invitation remains valid. Create a new invitation after the limit clears.",
      );
    }

    for (;;) {
      this.#assertCurrent(generation);
      const remainingMs = Math.max(0, retryAt - this.#now());
      input.onRateLimit?.(remainingMs);
      if (remainingMs === 0) return;
      await this.#sleep(Math.min(1_000, remainingMs));
    }
  }

  #current(invitationId: string): ReadyMatrixLoginToken | null {
    if (
      this.#cached?.invitationId === invitationId &&
      this.#isUsable(this.#cached.result.expiresAt)
    ) {
      return this.#cached.result;
    }
    this.#cached = null;
    return null;
  }

  #isUsable(expiresAt: number): boolean {
    return expiresAt > this.#now() + this.#minimumRemainingMs;
  }

  #assertCurrent(generation: number): void {
    if (generation !== this.#generation) {
      throw new MatrixLoginTokenRequestCancelledError();
    }
  }
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, durationMs));
}
