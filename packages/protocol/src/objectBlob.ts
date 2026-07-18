import { z } from 'zod'
import { NonNegativeIntegerSchema } from './common'

export const OBJECT_BLOB_CHUNK_BYTES = 196_608

export const ObjectBlobIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'blobId must be object-safe')

export const ObjectBlobManifestSchema = z.object({
    blobId: ObjectBlobIdSchema,
    totalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    chunkSize: z.number().int().positive().max(OBJECT_BLOB_CHUNK_BYTES),
    chunkCount: NonNegativeIntegerSchema.max(Number.MAX_SAFE_INTEGER),
    receivedChunkCount: NonNegativeIntegerSchema.max(Number.MAX_SAFE_INTEGER),
    complete: z.boolean(),
}).strict()

export type ObjectBlobManifest = z.infer<typeof ObjectBlobManifestSchema>
