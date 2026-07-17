import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayBlobStore, RelayBlobStoreError } from '../src/relayBlobStore'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

async function store(): Promise<{ store: RelayBlobStore; path: string }> {
    const path = await mkdtemp(join(tmpdir(), 'codever-relay-blobs-'))
    directories.push(path)
    return { store: new RelayBlobStore(path), path }
}

describe('RelayBlobStore', () => {
    it('persists opaque chunks, resumes, and accepts byte-identical retries', async () => {
        const { store: blobs, path } = await store()
        expect(await blobs.begin('gateway-1', { blobId: 'blob-1', totalSize: 5, chunkSize: 3 })).toMatchObject({
            chunkCount: 2, receivedChunks: [], complete: false,
        })
        await blobs.putChunk('gateway-1', 'blob-1', 0, Buffer.from('abc').toString('base64url'))
        await blobs.putChunk('gateway-1', 'blob-1', 0, Buffer.from('abc').toString('base64url'))
        const reopened = new RelayBlobStore(path)
        expect(await reopened.manifest('gateway-1', 'blob-1')).toMatchObject({ receivedChunks: [0], complete: false })
        await reopened.putChunk('gateway-1', 'blob-1', 1, Buffer.from('de').toString('base64url'))
        expect(await reopened.complete('gateway-1', 'blob-1')).toMatchObject({ receivedChunks: [0, 1], complete: true })
        expect(Buffer.from(await reopened.getChunk('gateway-1', 'blob-1', 1), 'base64url').toString()).toBe('de')
    })

    it('rejects gaps, conflicting retries, invalid lengths, and traversal ids', async () => {
        const { store: blobs } = await store()
        await blobs.begin('gateway-1', { blobId: 'blob', totalSize: 5, chunkSize: 3 })
        await expect(blobs.complete('gateway-1', 'blob')).rejects.toMatchObject({ code: 'incomplete' })
        await expect(blobs.putChunk('gateway-1', 'blob', 0, Buffer.from('ab').toString('base64url')))
            .rejects.toMatchObject({ code: 'invalid_chunk' })
        await blobs.putChunk('gateway-1', 'blob', 0, Buffer.from('abc').toString('base64url'))
        await expect(blobs.putChunk('gateway-1', 'blob', 0, Buffer.from('xyz').toString('base64url')))
            .rejects.toMatchObject({ code: 'conflict' })
        expect(() => blobs.begin('gateway-1', { blobId: '../escape', totalSize: 0, chunkSize: 1 }))
            .toThrow(RelayBlobStoreError)
    })

    it('isolates Gateways and handles empty Blobs and repeated deletes', async () => {
        const { store: blobs } = await store()
        await blobs.begin('gateway-1', { blobId: 'same', totalSize: 0, chunkSize: 1 })
        await blobs.begin('gateway-2', { blobId: 'same', totalSize: 3, chunkSize: 3 })
        expect(await blobs.complete('gateway-1', 'same')).toMatchObject({ complete: true, chunkCount: 0 })
        expect(await blobs.manifest('gateway-2', 'same')).toMatchObject({ complete: false, totalSize: 3 })
        await blobs.delete('gateway-1', 'same')
        await blobs.delete('gateway-1', 'same')
        await expect(blobs.manifest('gateway-1', 'same')).rejects.toMatchObject({ code: 'not_found' })
        expect(await blobs.manifest('gateway-2', 'same')).toMatchObject({ totalSize: 3 })
    })
})
