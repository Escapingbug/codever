export const MATRIX_DECRYPTION_RETRY_TIMEOUT_MS = 5 * 60_000;

type DecryptionEventListener<T> = (event: T, error?: Error) => void;

export type RetriableMatrixEvent<T> = {
  isDecryptionFailure(): boolean;
  on(eventName: string, listener: DecryptionEventListener<T>): void;
  off(eventName: string, listener: DecryptionEventListener<T>): void;
};

/**
 * Keeps a live Matrix event retryable while Rust crypto is waiting for its
 * Megolm room key. Matrix emits Event.decrypted again after the missing key
 * arrives, so a temporary decryption failure must not become a permanent
 * application-level drop.
 */
export async function processMatrixEventWithDecryptionRetry<
  T extends RetriableMatrixEvent<T>,
>(
  event: T,
  decryptedEventName: string,
  process: (candidate: T) => Promise<void>,
  onRetryError: (error: unknown) => void,
  timeoutMs = MATRIX_DECRYPTION_RETRY_TIMEOUT_MS,
): Promise<void> {
  let initialAttempt = true;
  let decryptedDuringInitialAttempt = false;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    globalThis.clearTimeout(timeout);
    event.off(decryptedEventName, onDecrypted);
  };
  const onDecrypted: DecryptionEventListener<T> = (candidate, error) => {
    if (disposed || error || candidate.isDecryptionFailure()) return;
    if (initialAttempt) {
      decryptedDuringInitialAttempt = true;
      return;
    }
    cleanup();
    void process(candidate).catch(onRetryError);
  };
  const timeout = globalThis.setTimeout(cleanup, timeoutMs);
  event.on(decryptedEventName, onDecrypted);

  try {
    await process(event);
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    initialAttempt = false;
  }

  if (!event.isDecryptionFailure()) {
    cleanup();
    // A successful decrypt can race with the completion of the initial
    // processor. Re-running is safe because the caller's event-id set makes
    // processing idempotent, and closes the otherwise tiny missed-event gap.
    if (decryptedDuringInitialAttempt) {
      await process(event);
    }
  }
}
