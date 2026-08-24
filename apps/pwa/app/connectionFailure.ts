export type ConnectionFailureCode =
  | "matrix_connection_bootstrap_failed"
  | "matrix_crypto_lock_contended"
  | "matrix_native_runtime_unavailable"
  | "matrix_native_runtime_outdated"
  | "matrix_web_locks_unavailable";

/**
 * Keeps connection startup failures machine-readable. The visible UI is
 * derived from the code; the original error remains attached for diagnostics.
 */
export class ConnectionFailureError extends Error {
  constructor(
    readonly code: ConnectionFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectionFailureError";
  }
}

export function connectionFailureCode(error: unknown): ConnectionFailureCode {
  return error instanceof ConnectionFailureError
    ? error.code
    : "matrix_connection_bootstrap_failed";
}
