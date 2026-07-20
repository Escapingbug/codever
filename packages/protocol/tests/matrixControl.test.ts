import { describe, expect, it } from 'vitest'
import {
    CURRENT_MATRIX_CONTROL_RANGE,
    matrixControlRangesOverlap,
    parseMatrixControlVersionRange,
} from '../src/matrixControl'

describe('Matrix control protocol negotiation', () => {
    it('accepts only overlapping version ranges', () => {
        expect(matrixControlRangesOverlap(CURRENT_MATRIX_CONTROL_RANGE, { minVersion: 2, maxVersion: 2 })).toBe(true)
        expect(matrixControlRangesOverlap(CURRENT_MATRIX_CONTROL_RANGE, { minVersion: 1, maxVersion: 1 })).toBe(false)
        expect(matrixControlRangesOverlap(CURRENT_MATRIX_CONTROL_RANGE, { minVersion: 3, maxVersion: 4 })).toBe(false)
    })

    it('rejects malformed and inverted declarations', () => {
        expect(() => parseMatrixControlVersionRange({ minVersion: 3, maxVersion: 2 })).toThrow()
        expect(() => parseMatrixControlVersionRange({ minVersion: 2, maxVersion: 2, extra: true })).toThrow()
    })
})
