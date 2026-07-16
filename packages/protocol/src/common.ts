import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const
export const SCHEMA_VERSION = 1 as const

export const OpaqueIdSchema = z.string().trim().min(1)
export const IsoDateTimeSchema = z.iso.datetime({ offset: true })
export const NonNegativeIntegerSchema = z.number().int().nonnegative()
export const PositiveIntegerSchema = z.number().int().positive()
export const JsonValueSchema = z.json()
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema)

export type JsonValue = z.infer<typeof JsonValueSchema>
export type JsonObject = z.infer<typeof JsonObjectSchema>

export function parseWithSchema<TSchema extends z.ZodType>(
    schema: TSchema,
    value: unknown,
): z.output<TSchema> {
    return schema.parse(value)
}
