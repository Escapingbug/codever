import type { JsonValue } from "@codever/protocol";

export type CommandCompletion = {
  commandId: string;
  sequence: number;
  revision: number;
  outcome: "succeeded" | "failed";
  sessionId?: string;
  result?: JsonValue;
};

export const COMMAND_COMPLETION_TIMEOUT_MS = 60_000;

export function waitForCommandCompletion(
  completion: Promise<CommandCompletion>,
  timeoutMs = COMMAND_COMPLETION_TIMEOUT_MS,
): Promise<CommandCompletion> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(
        new Error(
          "The Gateway accepted this command but did not confirm its final result. Reconnect to recover the command before retrying.",
        ),
      );
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
    (completion: CommandCompletion) => void
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

  recordResult(result: CommandCompletion): void {
    this.recordAcknowledgement(
      result.commandId,
      result.sequence,
      result.revision,
    );
    if (this.#completions.has(result.commandId)) return;
    this.#completions.set(result.commandId, result);
    const resolve = this.#completionWaiters.get(result.commandId);
    if (resolve) {
      this.#completionWaiters.delete(result.commandId);
      resolve(result);
    }
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
        reject(
          new Error(
            "The Gateway did not confirm this command. It remains queued for a safe retry.",
          ),
        );
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

  waitForCompletion(commandId: string): Promise<CommandCompletion> {
    const completion = this.#completions.get(commandId);
    if (completion) return Promise.resolve(completion);
    return new Promise((resolve) => {
      this.#completionWaiters.set(commandId, resolve);
    });
  }
}
