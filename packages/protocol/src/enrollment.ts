import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, parseWithSchema } from './common'
import { GatewayPlatformSchema } from './domain'
import { RelayAuthChallengeSchema } from './frames'

export const GatewayFingerprintSchema = z.string().startsWith('sha256:').min(20)
export const GatewayPublicKeySchema = z.string().min(1).refine(value => !value.includes('PRIVATE KEY'), {
    message: 'Only a public key may be supplied',
})
export const PairingCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/)

export const GatewayEnrollmentIdentitySchema = z.object({
    gatewayId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    name: z.string().trim().min(1).max(120),
    platform: GatewayPlatformSchema,
    algorithm: z.literal('ECDSA-P256-SHA256'),
    fingerprint: GatewayFingerprintSchema,
    publicKeySpkiPem: GatewayPublicKeySchema,
}).strict()

export const GatewayEnrollmentChallengeRequestSchema = GatewayEnrollmentIdentitySchema
export const GatewayEnrollmentChallengeDtoSchema = z.object({
    enrollmentId: OpaqueIdSchema,
    challenge: RelayAuthChallengeSchema,
}).strict()

export const GatewayEnrollmentProofDtoSchema = z.object({
    enrollmentId: OpaqueIdSchema,
    gatewayId: OpaqueIdSchema,
    fingerprint: GatewayFingerprintSchema,
    signature: z.string().min(1),
}).strict()

export const GatewayEnrollmentStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired'])
export const GatewayEnrollmentDtoSchema = z.object({
    enrollmentId: OpaqueIdSchema,
    code: PairingCodeSchema.optional(),
    gatewayId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    name: z.string().trim().min(1),
    platform: GatewayPlatformSchema,
    fingerprint: GatewayFingerprintSchema,
    status: GatewayEnrollmentStatusSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    approvedAt: IsoDateTimeSchema.optional(),
    rejectedAt: IsoDateTimeSchema.optional(),
    rejectionReason: z.string().trim().min(1).optional(),
}).strict()

export const GatewayEnrollmentListDtoSchema = z.object({
    bootstrapComplete: z.boolean(),
    enrollments: z.array(GatewayEnrollmentDtoSchema),
}).strict()

export const ApproveGatewayEnrollmentDtoSchema = z.object({
    fingerprint: GatewayFingerprintSchema,
    name: z.string().trim().min(1).max(120),
    platform: GatewayPlatformSchema,
}).strict()

export const RejectGatewayEnrollmentDtoSchema = z.object({
    reason: z.string().trim().min(1).max(500).optional(),
}).strict()

export const EnrolledGatewayKeyDtoSchema = z.object({
    gatewayId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    name: z.string().trim().min(1),
    platform: GatewayPlatformSchema,
    fingerprint: GatewayFingerprintSchema,
    enabled: z.boolean(),
    enrolledAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.optional(),
}).strict()

export const EnrolledGatewayKeyListDtoSchema = z.object({ gateways: z.array(EnrolledGatewayKeyDtoSchema) }).strict()

export type GatewayEnrollmentIdentity = z.infer<typeof GatewayEnrollmentIdentitySchema>
export type GatewayEnrollmentChallengeRequest = z.infer<typeof GatewayEnrollmentChallengeRequestSchema>
export type GatewayEnrollmentChallengeDto = z.infer<typeof GatewayEnrollmentChallengeDtoSchema>
export type GatewayEnrollmentProofDto = z.infer<typeof GatewayEnrollmentProofDtoSchema>
export type GatewayEnrollmentStatus = z.infer<typeof GatewayEnrollmentStatusSchema>
export type GatewayEnrollmentDto = z.infer<typeof GatewayEnrollmentDtoSchema>
export type GatewayEnrollmentListDto = z.infer<typeof GatewayEnrollmentListDtoSchema>
export type ApproveGatewayEnrollmentDto = z.infer<typeof ApproveGatewayEnrollmentDtoSchema>
export type RejectGatewayEnrollmentDto = z.infer<typeof RejectGatewayEnrollmentDtoSchema>
export type EnrolledGatewayKeyDto = z.infer<typeof EnrolledGatewayKeyDtoSchema>
export type EnrolledGatewayKeyListDto = z.infer<typeof EnrolledGatewayKeyListDtoSchema>

export const parseGatewayEnrollmentChallengeRequest = (value: unknown): GatewayEnrollmentChallengeRequest => parseWithSchema(GatewayEnrollmentChallengeRequestSchema, value)
export const parseGatewayEnrollmentChallengeDto = (value: unknown): GatewayEnrollmentChallengeDto => parseWithSchema(GatewayEnrollmentChallengeDtoSchema, value)
export const parseGatewayEnrollmentProofDto = (value: unknown): GatewayEnrollmentProofDto => parseWithSchema(GatewayEnrollmentProofDtoSchema, value)
export const parseGatewayEnrollmentDto = (value: unknown): GatewayEnrollmentDto => parseWithSchema(GatewayEnrollmentDtoSchema, value)
export const parseGatewayEnrollmentListDto = (value: unknown): GatewayEnrollmentListDto => parseWithSchema(GatewayEnrollmentListDtoSchema, value)
export const parseApproveGatewayEnrollmentDto = (value: unknown): ApproveGatewayEnrollmentDto => parseWithSchema(ApproveGatewayEnrollmentDtoSchema, value)
export const parseRejectGatewayEnrollmentDto = (value: unknown): RejectGatewayEnrollmentDto => parseWithSchema(RejectGatewayEnrollmentDtoSchema, value)
export const parseEnrolledGatewayKeyDto = (value: unknown): EnrolledGatewayKeyDto => parseWithSchema(EnrolledGatewayKeyDtoSchema, value)
export const parseEnrolledGatewayKeyListDto = (value: unknown): EnrolledGatewayKeyListDto => parseWithSchema(EnrolledGatewayKeyListDtoSchema, value)
