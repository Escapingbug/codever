import type { ObjectStore } from '@nats-io/obj'
import { describe, expect, it, vi } from 'vitest'
import { NatsObjectBlobTransport } from '../natsObjectBlobTransport'

describe('NatsObjectBlobTransport', () => {
    it('resumes encrypted chunks idempotently and removes the complete Blob namespace', async () => {
        const objects = new Map<string, Uint8Array>()
        const store = {
            getBlob: async (name: string) => objects.get(name),
            putBlob: async ({ name }: { name: string }, value: Uint8Array | null) => {
                objects.set(name, value ?? new Uint8Array())
                return {} as never
            },
            info: async (name: string) => objects.has(name) ? ({ name } as never) : null,
            delete: vi.fn(async (name: string) => { objects.delete(name); return {} as never }),
        } as unknown as ObjectStore
        const transport = new NatsObjectBlobTransport(store)

        expect(await transport.begin('blob_1', 6, 3)).toMatchObject({ chunkCount: 2, receivedChunkCount: 0 })
        await transport.putChunk('blob_1', 0, 'encrypted-a')
        await transport.putChunk('blob_1', 0, 'encrypted-a')
        await expect(transport.putChunk('blob_1', 0, 'different')).rejects.toThrow('does not match')
        await expect(transport.complete('blob_1')).rejects.toThrow('incomplete')
        await transport.putChunk('blob_1', 1, 'encrypted-b')
        await transport.complete('blob_1')
        expect(await transport.manifest('blob_1')).toMatchObject({ receivedChunkCount: 2, complete: true })
        expect(await transport.getChunk('blob_1', 1)).toBe('encrypted-b')

        await transport.delete('blob_1')
        expect(objects.size).toBe(0)
    })
})
