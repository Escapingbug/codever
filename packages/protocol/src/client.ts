import { z } from 'zod'
import { IsoDateTimeSchema, JsonObjectSchema, JsonValueSchema, NonNegativeIntegerSchema, OpaqueIdSchema, PositiveIntegerSchema, parseWithSchema } from './common'
import { CommandTerminalStatusSchema, ProtocolErrorSchema } from './commands'
import { CodeverSessionSchema, GatewaySchema, ProjectSchema, ProviderModelSchema, ProviderSessionSchema } from './domain'
import { SessionEventEnvelopeSchema } from './events'

export const GatewayListDtoSchema = z.object({ gateways: z.array(GatewaySchema) }).strict()
export const ProjectListDtoSchema = z.object({ gatewayId: OpaqueIdSchema, projects: z.array(ProjectSchema) }).strict()
export const ProjectDtoSchema = z.object({ project: ProjectSchema }).strict()
export const SessionListDtoSchema = z.object({ projectId: OpaqueIdSchema, sessions: z.array(CodeverSessionSchema) }).strict()
export const SessionDtoSchema = z.object({ session: CodeverSessionSchema }).strict()
export const ProviderSessionControlDtoSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('toggle'), id: z.string().min(1), label: z.string().min(1),
        configKey: z.string().min(1), description: z.string().optional(),
    }).strict(),
    z.object({
        kind: z.literal('select'), id: z.string().min(1), label: z.string().min(1),
        configKey: z.string().min(1), description: z.string().optional(),
        options: z.array(z.object({ value: z.string(), label: z.string().min(1) }).strict()).min(1),
    }).strict(),
])
export const ProviderSessionListDtoSchema = z.object({
    projectId: OpaqueIdSchema,
    provider: z.string().min(1),
    discoverySupported: z.boolean(),
    models: z.array(ProviderModelSchema),
    permissionModes: z.array(z.string().min(1)),
    controls: z.array(ProviderSessionControlDtoSchema),
    capabilities: z.object({
        resume: z.boolean(),
        cancel: z.boolean(),
        changeModel: z.boolean(),
        changeMode: z.boolean(),
        fork: z.boolean(),
        retry: z.boolean(),
        editHistory: z.boolean(),
        listBranches: z.boolean(),
        attachFiles: z.boolean(),
    }).strict(),
    sessions: z.array(ProviderSessionSchema),
}).strict()
export const SessionEventsDtoSchema = z.object({
    sessionId: OpaqueIdSchema,
    events: z.array(SessionEventEnvelopeSchema),
    nextAfter: NonNegativeIntegerSchema.nullable(),
    previousBefore: PositiveIntegerSchema.nullable(),
}).strict()

export const CreateSessionDtoSchema = z.object({
    provider: z.string().min(1),
    title: z.string().trim().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    providerSessionId: z.string().min(1).optional(),
    config: JsonObjectSchema,
}).strict()

export const CreateProjectDtoSchema = z.object({
    name: z.string().trim().min(1),
    rootPath: z.string().min(1),
    defaultProvider: z.string().min(1).optional(),
}).strict()

export const SendMessageDtoSchema = z.object({
    text: z.string(),
    clientMessageId: OpaqueIdSchema.optional(),
    attachmentIds: z.array(OpaqueIdSchema).optional(),
    sendWhenOnline: z.boolean().optional(),
    expiresAt: IsoDateTimeSchema.optional(),
}).strict().refine(value => value.text.trim().length > 0 || Boolean(value.attachmentIds?.length), {
    message: 'Message text or at least one attachment is required',
})

export const AttachmentUploadDtoSchema = z.object({
    attachmentId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: NonNegativeIntegerSchema.max(Number.MAX_SAFE_INTEGER),
    receivedBytes: NonNegativeIntegerSchema.max(Number.MAX_SAFE_INTEGER),
    status: z.enum(['uploading', 'ready', 'cancelled']),
}).strict()
export const SessionAttachmentDtoSchema = z.object({
    attachmentId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: NonNegativeIntegerSchema.max(Number.MAX_SAFE_INTEGER),
    createdAt: IsoDateTimeSchema,
    status: z.literal('ready'),
}).strict()
export const SessionAttachmentListDtoSchema = z.object({
    sessionId: OpaqueIdSchema,
    attachments: z.array(SessionAttachmentDtoSchema),
}).strict()
export const AttachmentDownloadChunkDtoSchema = z.object({
    attachmentId: OpaqueIdSchema,
    offset: NonNegativeIntegerSchema,
    data: z.string(),
    nextOffset: NonNegativeIntegerSchema.nullable(),
}).strict()
export const ToolOutputListItemDtoSchema = z.object({
    outputId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    toolCallId: OpaqueIdSchema,
    toolName: z.string().min(1),
    sizeBytes: NonNegativeIntegerSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.literal('application/json'),
    createdAt: IsoDateTimeSchema,
}).strict()
export const ToolOutputListDtoSchema = z.object({
    sessionId: OpaqueIdSchema,
    outputs: z.array(ToolOutputListItemDtoSchema),
}).strict()
export const ToolOutputDownloadChunkDtoSchema = z.object({
    outputId: OpaqueIdSchema,
    offset: NonNegativeIntegerSchema,
    data: z.string(),
    nextOffset: NonNegativeIntegerSchema.nullable(),
}).strict()
export const CancelSessionDtoSchema = z.object({ reason: z.string().min(1).optional() }).strict()
export const RenameSessionDtoSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict()
export const PatchSessionConfigDtoSchema = z.object({
    config: JsonObjectSchema,
    model: z.string().min(1).nullable().optional(),
    mode: z.string().min(1).nullable().optional(),
}).strict()
export const ResolveDecisionDtoSchema = z.object({ value: JsonValueSchema }).strict()

export const MutationReceiptDtoSchema = z.object({
    commandId: OpaqueIdSchema,
    status: z.union([z.literal('gateway_accepted'), CommandTerminalStatusSchema]),
    acceptedAt: IsoDateTimeSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
    error: ProtocolErrorSchema.optional(),
}).strict()

export type GatewayListDto = z.infer<typeof GatewayListDtoSchema>
export type ProjectListDto = z.infer<typeof ProjectListDtoSchema>
export type ProjectDto = z.infer<typeof ProjectDtoSchema>
export type SessionListDto = z.infer<typeof SessionListDtoSchema>
export type SessionDto = z.infer<typeof SessionDtoSchema>
export type ProviderSessionListDto = z.infer<typeof ProviderSessionListDtoSchema>
export type ProviderSessionControlDto = z.infer<typeof ProviderSessionControlDtoSchema>
export type SessionEventsDto = z.infer<typeof SessionEventsDtoSchema>
export type CreateSessionDto = z.infer<typeof CreateSessionDtoSchema>
export type CreateProjectDto = z.infer<typeof CreateProjectDtoSchema>
export type SendMessageDto = z.infer<typeof SendMessageDtoSchema>
export type AttachmentUploadDto = z.infer<typeof AttachmentUploadDtoSchema>
export type SessionAttachmentDto = z.infer<typeof SessionAttachmentDtoSchema>
export type SessionAttachmentListDto = z.infer<typeof SessionAttachmentListDtoSchema>
export type AttachmentDownloadChunkDto = z.infer<typeof AttachmentDownloadChunkDtoSchema>
export type ToolOutputListItemDto = z.infer<typeof ToolOutputListItemDtoSchema>
export type ToolOutputListDto = z.infer<typeof ToolOutputListDtoSchema>
export type ToolOutputDownloadChunkDto = z.infer<typeof ToolOutputDownloadChunkDtoSchema>
export type CancelSessionDto = z.infer<typeof CancelSessionDtoSchema>
export type RenameSessionDto = z.infer<typeof RenameSessionDtoSchema>
export type PatchSessionConfigDto = z.infer<typeof PatchSessionConfigDtoSchema>
export type ResolveDecisionDto = z.infer<typeof ResolveDecisionDtoSchema>
export type MutationReceiptDto = z.infer<typeof MutationReceiptDtoSchema>

export const parseGatewayListDto = (value: unknown): GatewayListDto => parseWithSchema(GatewayListDtoSchema, value)
export const parseProjectListDto = (value: unknown): ProjectListDto => parseWithSchema(ProjectListDtoSchema, value)
export const parseProjectDto = (value: unknown): ProjectDto => parseWithSchema(ProjectDtoSchema, value)
export const parseSessionListDto = (value: unknown): SessionListDto => parseWithSchema(SessionListDtoSchema, value)
export const parseSessionDto = (value: unknown): SessionDto => parseWithSchema(SessionDtoSchema, value)
export const parseProviderSessionListDto = (value: unknown): ProviderSessionListDto => parseWithSchema(ProviderSessionListDtoSchema, value)
export const parseSessionEventsDto = (value: unknown): SessionEventsDto => parseWithSchema(SessionEventsDtoSchema, value)
export const parseCreateSessionDto = (value: unknown): CreateSessionDto => parseWithSchema(CreateSessionDtoSchema, value)
export const parseCreateProjectDto = (value: unknown): CreateProjectDto => parseWithSchema(CreateProjectDtoSchema, value)
export const parseSendMessageDto = (value: unknown): SendMessageDto => parseWithSchema(SendMessageDtoSchema, value)
export const parseAttachmentUploadDto = (value: unknown): AttachmentUploadDto => parseWithSchema(AttachmentUploadDtoSchema, value)
export const parseSessionAttachmentDto = (value: unknown): SessionAttachmentDto => parseWithSchema(SessionAttachmentDtoSchema, value)
export const parseSessionAttachmentListDto = (value: unknown): SessionAttachmentListDto => parseWithSchema(SessionAttachmentListDtoSchema, value)
export const parseAttachmentDownloadChunkDto = (value: unknown): AttachmentDownloadChunkDto => parseWithSchema(AttachmentDownloadChunkDtoSchema, value)
export const parseCancelSessionDto = (value: unknown): CancelSessionDto => parseWithSchema(CancelSessionDtoSchema, value)
export const parseRenameSessionDto = (value: unknown): RenameSessionDto => parseWithSchema(RenameSessionDtoSchema, value)
export const parsePatchSessionConfigDto = (value: unknown): PatchSessionConfigDto => parseWithSchema(PatchSessionConfigDtoSchema, value)
export const parseResolveDecisionDto = (value: unknown): ResolveDecisionDto => parseWithSchema(ResolveDecisionDtoSchema, value)
export const parseMutationReceiptDto = (value: unknown): MutationReceiptDto => parseWithSchema(MutationReceiptDtoSchema, value)
