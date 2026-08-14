import { z } from 'zod'
import { pairingOperationSchema } from './pairing.js'
import { PROTOCOL_VERSION } from './schema.js'

/**
 * Matrix room event used for Codever application-layer encrypted control data.
 *
 * The event payload must be a signed Codever secure envelope. It deliberately
 * bypasses room Megolm so acknowledgements and command results do not depend
 * on recovery of the Gateway's current outbound Megolm session.
 */
export const CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE =
  'io.codever.secure_control.v1' as const

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const operationSetSchema = z
  .array(pairingOperationSchema)
  .min(1)
  .max(pairingOperationSchema.options.length)
  .refine((operations) => new Set(operations).size === operations.length, {
    message: 'Capability renewal operations must be unique',
  })

/**
 * An already trusted device uses this control-plane handshake to request a
 * freshly signed pairing certificate when a newer client needs operations
 * absent from its old certificate. The surrounding secure envelope is signed
 * by the device application key, so this request never trusts Matrix identity.
 */
export const capabilityRenewalRequestSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    kind: z.literal('capability_renewal_request'),
    request_id: opaqueId,
    gateway_id: opaqueId,
    device_id: opaqueId,
    certificate_id: opaqueId,
    requested_operations: operationSetSchema,
    issued_at: timestamp,
    expires_at: timestamp,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.expires_at <= request.issued_at) {
      context.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'expires_at must be later than issued_at',
      })
    }
  })

export type CapabilityRenewalRequest = z.infer<
  typeof capabilityRenewalRequestSchema
>

/** Gateway-authenticated response carrying a one-time, signed pairing offer. */
export const capabilityRenewalOfferSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    kind: z.literal('capability_renewal_offer'),
    request_id: opaqueId,
    certificate_id: opaqueId,
    pairing_link: z.string().min(1).max(128 * 1024),
    expires_at: timestamp,
    active_device_count: z.number().int().positive().optional(),
  })
  .strict()

export type CapabilityRenewalOffer = z.infer<
  typeof capabilityRenewalOfferSchema
>
