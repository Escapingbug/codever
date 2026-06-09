import { describe, expect, it, vi } from 'vitest'
import { createSafeStreamMirror } from '@/utils/safeStreamMirror'

describe('createSafeStreamMirror', () => {
    it('disables mirror writes after EPIPE', () => {
        const write = vi.fn(() => {
            const error = new Error('broken pipe') as NodeJS.ErrnoException
            error.code = 'EPIPE'
            throw error
        })
        const mirror = createSafeStreamMirror(write)

        expect(() => mirror.write('first')).not.toThrow()
        expect(mirror.isEnabled()).toBe(false)

        mirror.write('second')
        expect(write).toHaveBeenCalledTimes(1)
    })

    it('disables mirror writes after destroyed stream errors', () => {
        const write = vi.fn(() => {
            const error = new Error('destroyed') as NodeJS.ErrnoException
            error.code = 'ERR_STREAM_DESTROYED'
            throw error
        })
        const mirror = createSafeStreamMirror(write)

        expect(() => mirror.write('first')).not.toThrow()
        expect(mirror.isEnabled()).toBe(false)
    })

    it('rethrows unexpected write errors', () => {
        const error = new Error('unexpected')
        const mirror = createSafeStreamMirror(() => {
            throw error
        })

        expect(() => mirror.write('chunk')).toThrow(error)
        expect(mirror.isEnabled()).toBe(true)
    })
})
