import { z } from 'zod'

export const PRIVILEGE_HELPER_PROTOCOL_VERSION = 2 as const
export const PRIVILEGE_APPROVAL_TIMEOUT_MS = 5 * 60_000
export const PRIVILEGE_REQUEST_LIFETIME_MS = 30_000
export const MAX_PRIVILEGED_OUTPUT_BYTES = 512 * 1024

const opaqueId = z.string().min(1).max(256)
const absolutePath = z.string().min(1).max(8_192).refine(
  value => value.startsWith('/'),
  'Path must be absolute',
)

export const privilegedExecutionInputSchema = z
  .object({
    executable: absolutePath,
    args: z.array(z.string().max(8_192)).max(256).default([]),
    reason: z.string().min(1).max(2_048),
    timeoutMs: z.number().int().min(1_000).max(15 * 60_000).default(5 * 60_000),
  })
  .strict()

export type PrivilegedExecutionInput = z.infer<
  typeof privilegedExecutionInputSchema
>

export const privilegedExecutionRequestSchema = privilegedExecutionInputSchema
  .extend({
    version: z.literal(PRIVILEGE_HELPER_PROTOCOL_VERSION),
    totp: z.string().regex(/^\d{6}$/u),
    requestId: opaqueId,
    sessionId: opaqueId,
    cwd: absolutePath,
    requestedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.expiresAt <= request.requestedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Privilege request expiry must be later than its creation time',
      })
    }
    if (request.expiresAt - request.requestedAt > PRIVILEGE_REQUEST_LIFETIME_MS) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: `Privilege request lifetime cannot exceed ${PRIVILEGE_REQUEST_LIFETIME_MS}ms`,
      })
    }
  })

export type PrivilegedExecutionRequest = z.infer<
  typeof privilegedExecutionRequestSchema
>

export const privilegedExecutionResultSchema = z
  .object({
    requestId: opaqueId,
    status: z.enum(['succeeded', 'failed', 'timed_out']),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(128).nullable(),
    stdout: z.string().max(MAX_PRIVILEGED_OUTPUT_BYTES),
    stderr: z.string().max(MAX_PRIVILEGED_OUTPUT_BYTES),
    truncated: z.boolean(),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
  })
  .strict()

export type PrivilegedExecutionResult = z.infer<
  typeof privilegedExecutionResultSchema
>

export const privilegeHelperStatusSchema = z
  .object({
    version: z.literal(PRIVILEGE_HELPER_PROTOCOL_VERSION),
    state: z.literal('ready'),
    totpRequired: z.literal(true),
  })
  .strict()

export type PrivilegeHelperStatus = z.infer<typeof privilegeHelperStatusSchema>

export const privilegeClientCredentialSchema = z
  .object({
    version: z.literal(PRIVILEGE_HELPER_PROTOCOL_VERSION),
    socketPath: absolutePath,
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict()

export type PrivilegeClientCredential = z.infer<
  typeof privilegeClientCredentialSchema
>

export const privilegeHelperConfigSchema = z
  .object({
    version: z.literal(PRIVILEGE_HELPER_PROTOCOL_VERSION),
    socketPath: absolutePath,
    tokenSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    allowedUid: z.number().int().nonnegative(),
    allowedGid: z.number().int().nonnegative(),
    replayDirectory: absolutePath,
    totp: z
      .object({
        secret: z.string().regex(/^[A-Z2-7]{32}$/u),
        algorithm: z.literal('SHA-1'),
        digits: z.literal(6),
        periodSeconds: z.literal(30),
        allowedClockSkewSteps: z.number().int().min(0).max(1),
      })
      .strict(),
    policy: z
      .object({
        allowArbitraryRootExecutables: z.boolean().default(false),
        allowedExecutables: z.array(absolutePath).max(256).default([]),
      })
      .strict(),
  })
  .strict()

export type PrivilegeHelperConfig = z.infer<typeof privilegeHelperConfigSchema>

export interface PrivilegeExecutor {
  execute(request: PrivilegedExecutionRequest): Promise<PrivilegedExecutionResult>
}

export class PrivilegeExecutionDeniedError extends Error {
  constructor(message = 'The privileged operation was denied') {
    super(message)
    this.name = 'PrivilegeExecutionDeniedError'
  }
}

export function formatPrivilegedCommand(
  executable: string,
  args: readonly string[],
): string {
  return [executable, ...args].map(shellQuoteForDisplay).join(' ')
}

function shellQuoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}
