export type ExpiringInvitation = {
  expiresAt: number;
};

export class InvitationRequestCancelledError extends Error {
  constructor() {
    super("The device invitation request was cleared.");
    this.name = "InvitationRequestCancelledError";
  }
}

/** Coalesces invitation clicks and reuses a still-valid generated offer. */
export class DeviceInvitationLifecycle<T extends ExpiringInvitation> {
  #active: Promise<T> | null = null;
  #current: T | null = null;
  #generation = 0;

  constructor(private readonly minimumRemainingMs = 15_000) {}

  current(now = Date.now()): T | null {
    if (
      this.#current &&
      this.#current.expiresAt > now + this.minimumRemainingMs
    ) {
      return this.#current;
    }
    this.#current = null;
    return null;
  }

  request(create: () => Promise<T>, now = Date.now()): Promise<T> {
    const current = this.current(now);
    if (current) return Promise.resolve(current);
    if (this.#active) return this.#active;
    const generation = this.#generation;
    const operation = create().then((invitation) => {
      if (generation !== this.#generation) {
        throw new InvitationRequestCancelledError();
      }
      if (invitation.expiresAt <= Date.now() + this.minimumRemainingMs) {
        throw new Error("The device invitation arrived too close to expiry.");
      }
      this.#current = invitation;
      return invitation;
    });
    this.#active = operation;
    void operation.finally(() => {
      if (this.#active === operation) this.#active = null;
    }).catch(() => undefined);
    return operation;
  }

  clear(): void {
    this.#generation += 1;
    this.#active = null;
    this.#current = null;
  }

  get pending(): boolean {
    return this.#active !== null;
  }
}
