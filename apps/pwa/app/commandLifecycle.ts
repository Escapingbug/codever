import type { JsonValue } from "@codever/protocol";

export type CommandCompletion = {
  commandId: string;
  sequence: number;
  revision: number;
  outcome: "succeeded" | "failed" | "cancelled";
  sessionId?: string;
  result?: JsonValue;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

export const COMMAND_COMPLETION_TIMEOUT_MS = 60_000;

export class CommandAcknowledgementTimeoutError extends Error {
  readonly commandId: string;
  readonly sequence: number;

  constructor(commandId: string, sequence: number) {
    super(
      "Your computer did not acknowledge this command. It is saved for reconciliation; do not submit it again.",
    );
    this.name = "CommandAcknowledgementTimeoutError";
    this.commandId = commandId;
    this.sequence = sequence;
  }
}

export class CommandCompletionExpiredError extends Error {
  readonly commandId: string;

  constructor(commandId: string) {
    super(
      "The pending command expired before its final result arrived.",
    );
    this.name = "CommandCompletionExpiredError";
    this.commandId = commandId;
  }
}

export class CommandCompletionTimeoutError extends Error {
  constructor() {
    super(
      "Your computer accepted this command but did not confirm its final result. Reconnect before retrying.",
    );
    this.name = "CommandCompletionTimeoutError";
  }
}

export function waitForCommandCompletion(
  completion: Promise<CommandCompletion>,
  timeoutMs = COMMAND_COMPLETION_TIMEOUT_MS,
): Promise<CommandCompletion> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new CommandCompletionTimeoutError());
    }, timeoutMs);
    completion.then(
      (result) => {
        globalThis.clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

type Acknowledgement = {
  sequence: number;
  revision: number;
};

type AcknowledgementWaiter = {
  sequence: number;
  resolve(revision: number): void;
  reject(error: Error): void;
};

type CompletionWaiter = {
  resolve(completion: CommandCompletion): void;
  reject(error: Error): void;
};

/**
 * Coordinates authenticated command acknowledgements and terminal results.
 * A result is also an acknowledgement, so either delivery order safely
 * releases the sender while completion remains independently observable.
 */
export class CommandLifecycle {
  readonly #acknowledgements = new Map<string, Acknowledgement>();
  readonly #acknowledgementWaiters = new Map<
    string,
    AcknowledgementWaiter
  >();
  readonly #completions = new Map<string, CommandCompletion>();
  readonly #completionWaiters = new Map<
    string,
    Set<CompletionWaiter>
  >();

  recordAcknowledgement(
    commandId: string,
    sequence: number,
    revision: number,
  ): void {
    const current = this.#acknowledgements.get(commandId);
    if (
      !current ||
      sequence > current.sequence ||
      (sequence === current.sequence && revision > current.revision)
    ) {
      this.#acknowledgements.set(commandId, { sequence, revision });
    }
    const waiter = this.#acknowledgementWaiters.get(commandId);
    if (waiter?.sequence === sequence) {
      this.#acknowledgementWaiters.delete(commandId);
      waiter.resolve(revision);
    }
  }

  recordResult(result: CommandCompletion): boolean {
    this.recordAcknowledgement(
      result.commandId,
      result.sequence,
      result.revision,
    );
    if (this.#completions.has(result.commandId)) return false;
    this.#completions.set(result.commandId, result);
    const waiters = this.#completionWaiters.get(result.commandId);
    if (waiters) {
      this.#completionWaiters.delete(result.commandId);
      for (const waiter of waiters) waiter.resolve(result);
    }
    return true;
  }

  waitForAcknowledgement(
    commandId: string,
    sequence: number,
    timeoutMs = 30_000,
  ): Promise<number> {
    const acknowledged = this.#acknowledgements.get(commandId);
    if (acknowledged?.sequence === sequence) {
      return Promise.resolve(acknowledged.revision);
    }
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        if (
          this.#acknowledgementWaiters.get(commandId)?.resolve === accept
        ) {
          this.#acknowledgementWaiters.delete(commandId);
        }
        reject(new CommandAcknowledgementTimeoutError(commandId, sequence));
      }, timeoutMs);
      const accept = (revision: number) => {
        globalThis.clearTimeout(timeout);
        resolve(revision);
      };
      this.#acknowledgementWaiters.set(commandId, {
        sequence,
        resolve: accept,
        reject: (error) => {
          globalThis.clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  rejectAcknowledgement(commandId: string, error: Error): boolean {
    const waiter = this.#acknowledgementWaiters.get(commandId);
    if (!waiter) return false;
    this.#acknowledgementWaiters.delete(commandId);
    waiter.reject(error);
    return true;
  }

  waitForCompletion(
    commandId: string,
    timeoutMs?: number,
  ): Promise<CommandCompletion> {
    const completion = this.#completions.get(commandId);
    if (completion) return Promise.resolve(completion);
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
      const waiters = this.#completionWaiters.get(commandId) ?? new Set();
      const waiter: CompletionWaiter = {
        resolve: (result) => {
          if (timeout !== undefined) globalThis.clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          if (timeout !== undefined) globalThis.clearTimeout(timeout);
          reject(error);
        },
      };
      waiters.add(waiter);
      this.#completionWaiters.set(commandId, waiters);
      if (timeoutMs !== undefined) {
        timeout = globalThis.setTimeout(() => {
          const active = this.#completionWaiters.get(commandId);
          active?.delete(waiter);
          if (active?.size === 0) this.#completionWaiters.delete(commandId);
          reject(new CommandCompletionExpiredError(commandId));
        }, Math.max(0, timeoutMs));
      }
    });
  }

  release(commandId: string): void {
    this.#acknowledgements.delete(commandId);
    this.#completions.delete(commandId);
    const acknowledgement = this.#acknowledgementWaiters.get(commandId);
    if (acknowledgement) {
      this.#acknowledgementWaiters.delete(commandId);
      acknowledgement.reject(
        new Error("The command observation was released before acknowledgement."),
      );
    }
    const completions = this.#completionWaiters.get(commandId);
    if (completions) {
      this.#completionWaiters.delete(commandId);
      for (const waiter of completions) {
        waiter.reject(new CommandCompletionExpiredError(commandId));
      }
    }
  }
}
