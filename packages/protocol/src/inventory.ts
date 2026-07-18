import { z } from 'zod'
import { IsoDateTimeSchema, NonNegativeIntegerSchema } from './common'
import { CodeverSessionSchema, ProjectSchema } from './domain'

export const InventorySnapshotSchema = z.object({
    generatedAt: IsoDateTimeSchema,
    revision: NonNegativeIntegerSchema,
    projects: z.array(ProjectSchema),
    sessions: z.array(CodeverSessionSchema),
}).strict()

export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>
