import { describe, expect, it } from 'vitest'
import { SessionCredentialBarrier } from '../sessionCredentialBarrier'

describe('SessionCredentialBarrier', () => {
    it('does not report flushed until the durable writer completes', async () => {
        let release!: () => void
        const written: string[] = []
        const barrier = new SessionCredentialBarrier<string>(value => new Promise<void>(resolve => {
            release = () => { written.push(value); resolve() }
        }))
        barrier.enqueue('rotated-token')
        let flushed = false
        const flushing = barrier.flush().then(() => { flushed = true })
        await Promise.resolve()
        await Promise.resolve()
        expect(flushed).toBe(false)
        release()
        await flushing
        expect(written).toEqual(['rotated-token'])
    })

    it('surfaces a failed durable write at the lifecycle boundary', async () => {
        const barrier = new SessionCredentialBarrier<string>(async () => {
            throw new Error('disk unavailable')
        })
        barrier.enqueue('rotated-token')
        await expect(barrier.flush()).rejects.toThrow('disk unavailable')
    })

    it('serializes generations and allows a later successful checkpoint to recover', async () => {
        const written: string[] = []
        let fail = true
        const barrier = new SessionCredentialBarrier<string>(async value => {
            if (fail) { fail = false; throw new Error('temporary failure') }
            written.push(value)
        })
        barrier.enqueue('generation-1')
        await expect(barrier.flush()).rejects.toThrow('temporary failure')
        barrier.enqueue('generation-2')
        await barrier.flush()
        expect(written).toEqual(['generation-2'])
    })

    it('keeps flushing when a newer generation is queued during the flush', async () => {
        let releaseFirst!: () => void
        const written: string[] = []
        const barrier = new SessionCredentialBarrier<string>(value => {
            if (value === 'generation-1') {
                return new Promise<void>(resolve => {
                    releaseFirst = () => { written.push(value); resolve() }
                })
            }
            written.push(value)
            return Promise.resolve()
        })
        barrier.enqueue('generation-1')
        let flushed = false
        const flushing = barrier.flush().then(() => { flushed = true })
        await Promise.resolve()
        await Promise.resolve()
        barrier.enqueue('generation-2')
        releaseFirst()
        await Promise.resolve()
        await Promise.resolve()
        expect(flushed).toBe(false)
        await flushing
        expect(written).toEqual(['generation-1', 'generation-2'])
    })
})
