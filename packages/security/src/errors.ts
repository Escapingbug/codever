export type SecurityErrorCode =
  | 'invalid_signature'
  | 'key_mismatch'
  | 'binding_mismatch'
  | 'expired'
  | 'issued_in_future'
  | 'lifetime_exceeded'
  | 'replay'
  | 'sequence'
  | 'idempotency_conflict'
  | 'idempotency_state'

export class SecurityError extends Error {
  constructor(
    readonly code: SecurityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SecurityError'
  }
}
