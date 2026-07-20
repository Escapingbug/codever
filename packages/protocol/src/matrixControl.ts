import { z } from 'zod'
import { PositiveIntegerSchema, parseWithSchema } from './common'

// Matrix control evolves independently from the business request schemas.
// Version 2 introduces bilateral device trust and targeted discovery status.
export const MATRIX_CONTROL_MIN_VERSION = 2 as const
export const MATRIX_CONTROL_MAX_VERSION = 2 as const

export const MatrixControlVersionRangeSchema = z.object({
    minVersion: PositiveIntegerSchema,
    maxVersion: PositiveIntegerSchema,
}).strict().refine(value => value.minVersion <= value.maxVersion, 'Invalid Matrix control version range')

export type MatrixControlVersionRange = z.infer<typeof MatrixControlVersionRangeSchema>

export const CURRENT_MATRIX_CONTROL_RANGE: MatrixControlVersionRange = {
    minVersion: MATRIX_CONTROL_MIN_VERSION,
    maxVersion: MATRIX_CONTROL_MAX_VERSION,
}

export function parseMatrixControlVersionRange(value: unknown): MatrixControlVersionRange {
    return parseWithSchema(MatrixControlVersionRangeSchema, value)
}

export function matrixControlRangesOverlap(left: MatrixControlVersionRange, right: MatrixControlVersionRange): boolean {
    return left.minVersion <= right.maxVersion && right.minVersion <= left.maxVersion
}
