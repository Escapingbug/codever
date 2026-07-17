import { z } from 'zod'
import { NonNegativeIntegerSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'

export const RELAY_BLOB_CHUNK_BYTES = 196_608

export const BlobIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'blobId must be path-safe')

export const BlobSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const BlobChunkIndexSchema = NonNegativeIntegerSchema.max(Number.MAX_SAFE_INTEGER)
export const BlobOpaqueChunkSchema = z.string()
    .min(1)
    .max(Math.ceil(RELAY_BLOB_CHUNK_BYTES * 4 / 3))
    .regex(/^[A-Za-z0-9_-]+$/, 'opaqueChunk must be base64url without padding')

export const RelayBlobManifestSchema = z.object({
    blobId: BlobIdSchema,
    totalSize: BlobSizeSchema,
    chunkSize: z.number().int().positive().max(RELAY_BLOB_CHUNK_BYTES),
    chunkCount: BlobChunkIndexSchema,
    receivedChunkCount: BlobChunkIndexSchema,
    complete: z.boolean(),
}).strict()

const requestPayload = <T extends z.ZodRawShape>(shape: T) => z.object({
    requestId: OpaqueIdSchema,
    ...shape,
}).strict()

const blobFrame = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    gatewayId: OpaqueIdSchema,
    connectionEpoch: OpaqueIdSchema,
    payload,
}).strict()

export const GatewayBlobBeginFrameSchema = blobFrame('gateway.blob.begin', requestPayload({
    blobId: BlobIdSchema,
    totalSize: BlobSizeSchema,
    chunkSize: z.number().int().positive().max(RELAY_BLOB_CHUNK_BYTES),
}))
export const GatewayBlobPutChunkFrameSchema = blobFrame('gateway.blob.put-chunk', requestPayload({
    blobId: BlobIdSchema,
    index: BlobChunkIndexSchema,
    opaqueChunk: BlobOpaqueChunkSchema,
}))
export const GatewayBlobCompleteFrameSchema = blobFrame('gateway.blob.complete', requestPayload({ blobId: BlobIdSchema }))
export const GatewayBlobManifestFrameSchema = blobFrame('gateway.blob.manifest', requestPayload({ blobId: BlobIdSchema }))
export const GatewayBlobGetChunkFrameSchema = blobFrame('gateway.blob.get-chunk', requestPayload({
    blobId: BlobIdSchema,
    index: BlobChunkIndexSchema,
}))
export const GatewayBlobDeleteFrameSchema = blobFrame('gateway.blob.delete', requestPayload({ blobId: BlobIdSchema }))

export const GatewayBlobRequestFrameSchema = z.discriminatedUnion('type', [
    GatewayBlobBeginFrameSchema,
    GatewayBlobPutChunkFrameSchema,
    GatewayBlobCompleteFrameSchema,
    GatewayBlobManifestFrameSchema,
    GatewayBlobGetChunkFrameSchema,
    GatewayBlobDeleteFrameSchema,
])

export const RelayBlobOperationSchema = z.enum(['begin', 'put-chunk', 'complete', 'manifest', 'get-chunk', 'delete'])
export const RelayBlobErrorCodeSchema = z.enum([
    'not_found',
    'conflict',
    'invalid_chunk',
    'incomplete',
    'storage_error',
])

const succeeded = <TOperation extends string, T extends z.ZodRawShape>(operation: TOperation, shape: T) => z.object({
    requestId: OpaqueIdSchema,
    operation: z.literal(operation),
    status: z.literal('succeeded'),
    ...shape,
}).strict()

export const RelayBlobSucceededPayloadSchema = z.discriminatedUnion('operation', [
    succeeded('begin', { manifest: RelayBlobManifestSchema }),
    succeeded('put-chunk', { manifest: RelayBlobManifestSchema }),
    succeeded('complete', { manifest: RelayBlobManifestSchema }),
    succeeded('manifest', { manifest: RelayBlobManifestSchema }),
    succeeded('get-chunk', { blobId: BlobIdSchema, index: BlobChunkIndexSchema, opaqueChunk: BlobOpaqueChunkSchema }),
    succeeded('delete', { blobId: BlobIdSchema, deleted: z.literal(true) }),
])

export const RelayBlobFailedPayloadSchema = z.object({
    requestId: OpaqueIdSchema,
    operation: RelayBlobOperationSchema,
    status: z.literal('failed'),
    code: RelayBlobErrorCodeSchema,
    message: z.string().min(1).max(512),
}).strict()

export const RelayBlobResponsePayloadSchema = z.union([
    RelayBlobSucceededPayloadSchema,
    RelayBlobFailedPayloadSchema,
])
export const RelayBlobResponseFrameSchema = blobFrame('relay.blob.response', RelayBlobResponsePayloadSchema)

export type RelayBlobManifest = z.infer<typeof RelayBlobManifestSchema>
export type GatewayBlobRequestFrame = z.infer<typeof GatewayBlobRequestFrameSchema>
export type RelayBlobResponseFrame = z.infer<typeof RelayBlobResponseFrameSchema>
export type RelayBlobOperation = z.infer<typeof RelayBlobOperationSchema>
export type RelayBlobErrorCode = z.infer<typeof RelayBlobErrorCodeSchema>

export const parseGatewayBlobRequestFrame = (value: unknown): GatewayBlobRequestFrame =>
    parseWithSchema(GatewayBlobRequestFrameSchema, value)
export const parseRelayBlobResponseFrame = (value: unknown): RelayBlobResponseFrame =>
    parseWithSchema(RelayBlobResponseFrameSchema, value)
