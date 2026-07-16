import { z } from 'zod'
import {
    IsoDateTimeSchema,
    JsonObjectSchema,
    NonNegativeIntegerSchema,
    OpaqueIdSchema,
    PositiveIntegerSchema,
    parseWithSchema,
} from './common'

export const GatewayPlatformSchema = z.enum(['windows', 'macos', 'linux', 'container', 'unknown'])
export const GatewayStatusSchema = z.enum(['online', 'offline', 'disabled', 'revoked'])

export const GatewayCapabilitiesSchema = z.object({
    protocolVersions: z.array(PositiveIntegerSchema).min(1),
    providers: z.array(z.string().min(1)),
    features: z.array(z.string().min(1)),
    metadata: JsonObjectSchema.optional(),
}).strict()

export const GatewaySchema = z.object({
    id: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    name: z.string().trim().min(1),
    platform: GatewayPlatformSchema,
    version: z.string().trim().min(1),
    capabilities: GatewayCapabilitiesSchema,
    status: GatewayStatusSchema,
    connectionEpoch: OpaqueIdSchema.optional(),
    lastSeenAt: IsoDateTimeSchema.optional(),
}).strict()

export const ProjectSchema = z.object({
    id: OpaqueIdSchema,
    gatewayId: OpaqueIdSchema,
    name: z.string().trim().min(1),
    rootPath: z.string().min(1),
    canonicalRoot: z.string().min(1),
    repoIdentity: z.string().min(1).optional(),
    defaultProvider: z.string().min(1).optional(),
    archivedAt: IsoDateTimeSchema.optional(),
}).strict()

export const SessionStateSchema = z.enum(['idle', 'querying', 'canceling', 'offline', 'closed', 'error'])

export const CodeverSessionSchema = z.object({
    id: OpaqueIdSchema,
    gatewayId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
    title: z.string().trim().min(1).optional(),
    state: SessionStateSchema,
    provider: z.string().min(1),
    providerSessionId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    config: JsonObjectSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    lastEventSeq: NonNegativeIntegerSchema,
}).strict()

export const ProviderSessionSchema = z.object({
    provider: z.string().min(1),
    providerSessionId: z.string().min(1),
    title: z.string().trim().min(1),
    updatedAt: IsoDateTimeSchema,
    cwd: z.string().min(1).optional(),
    firstMessage: z.string().optional(),
    codeverSessionId: OpaqueIdSchema.optional(),
    state: SessionStateSchema.optional(),
    active: z.boolean(),
}).strict()

export const ProviderModelSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.string().min(1).optional(),
    defaultReasoningLevel: z.string().min(1).optional(),
    supportedReasoningLevels: z.array(z.object({
        effort: z.string().min(1),
        description: z.string().optional(),
    }).strict()).optional(),
}).strict()

export type GatewayPlatform = z.infer<typeof GatewayPlatformSchema>
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>
export type GatewayCapabilities = z.infer<typeof GatewayCapabilitiesSchema>
export type Gateway = z.infer<typeof GatewaySchema>
export type Project = z.infer<typeof ProjectSchema>
export type SessionState = z.infer<typeof SessionStateSchema>
export type CodeverSession = z.infer<typeof CodeverSessionSchema>
export type ProviderSession = z.infer<typeof ProviderSessionSchema>
export type ProviderModel = z.infer<typeof ProviderModelSchema>

export const parseGateway = (value: unknown): Gateway => parseWithSchema(GatewaySchema, value)
export const parseProject = (value: unknown): Project => parseWithSchema(ProjectSchema, value)
export const parseCodeverSession = (value: unknown): CodeverSession => parseWithSchema(CodeverSessionSchema, value)
export const parseProviderSession = (value: unknown): ProviderSession => parseWithSchema(ProviderSessionSchema, value)
