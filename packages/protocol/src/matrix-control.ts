/**
 * Matrix room event used for Codever application-layer encrypted control data.
 *
 * The event payload must be a signed Codever secure envelope. It deliberately
 * bypasses room Megolm so acknowledgements and command results do not depend
 * on recovery of the Gateway's current outbound Megolm session.
 */
export const CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE =
  'io.codever.secure_control.v1' as const
