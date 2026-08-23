import { z } from 'zod'
import {
  nativeClientReleaseSchema,
  type NativeClientRelease,
} from '@codever/protocol'
import {
  privilegedExecutionInputSchema,
  type PrivilegedExecutionResult,
} from '@/privilege'

export const createInvitationRequestSchema = z
  .object({
    lifetimeMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
    matrixLogin: z.enum(['required', 'preferred', 'disabled']).optional(),
    appUrl: z
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol
        return protocol === 'https:' || protocol === 'http:'
      }, 'appUrl must use http or https')
      .optional(),
    privilegeApproval: z.boolean().optional(),
  })
  .strict()

export type CreateInvitationRequest = z.infer<
  typeof createInvitationRequestSchema
>

export const revokeDeviceRequestSchema = z
  .object({
    reason: z.string().min(1).max(1024).optional(),
  })
  .strict()

export type RevokeDeviceRequest = z.infer<typeof revokeDeviceRequestSchema>

export const receiveWorkspaceFileRequestSchema = z
  .object({
    path: z.string().min(1).max(8_192),
    filename: z.string().min(1).max(512).optional(),
    caption: z.string().max(8_192).optional(),
    sourceLabel: z.string().min(1).max(256).optional(),
  })
  .strict()

export type ReceiveWorkspaceFileRequest = z.infer<
  typeof receiveWorkspaceFileRequestSchema
>

export interface ReceiveWorkspaceFileResponse {
  fileId: string
  eventId: string
  delivery: 'delivered' | 'queued'
}

export const gatewayPrivilegedExecutionRequestSchema = privilegedExecutionInputSchema
  .extend({ sessionId: z.string().min(1).max(256) })
  .strict()

export type GatewayPrivilegedExecutionRequest = z.infer<
  typeof gatewayPrivilegedExecutionRequestSchema
>

export type GatewayPrivilegedExecutionResponse = PrivilegedExecutionResult

export const publishNativeClientReleaseRequestSchema = nativeClientReleaseSchema

export type PublishNativeClientReleaseRequest = NativeClientRelease

export interface PublishNativeClientReleaseResponse {
  changed: boolean
  release: NativeClientRelease
  projectCount: number
}

export interface GatewayAdminStatus {
  version: 1
  gatewayId: string
  state: string
  pid: number
  startedAt: number
  activeDeviceCount: number
  openInvitationCount: number
}

export interface GatewayAdminDevice {
  deviceId: string
  deviceName: string
  status: 'active' | 'revoked' | 'expired'
  matrixUserId: string
  matrixDeviceId: string
  activatedAt: number
  expiresAt: number
  revokedAt?: number
  revocationReason?: string
}

export interface GatewayAdminInvitation {
  invitationId: string
  url: string
  pairingLink: string
  expiresAt: number
  verificationCode: string
  includesMatrixLogin: boolean
  matrixLoginStatus:
    | 'included'
    | 'disabled'
    | 'reauth-required'
    | 'unsupported'
    | 'unavailable'
}

export interface GatewayAdminErrorBody {
  error: {
    code: string
    message: string
  }
}
