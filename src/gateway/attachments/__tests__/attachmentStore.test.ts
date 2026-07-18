import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    GatewayAttachmentStore,
    type ObjectBlobManifest,
    type ObjectBlobTransport,
} from '../attachmentStore'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('GatewayAttachmentStore Relay persistence', () => {
    it('streams encrypted chunks to Relay, releases local data, and materializes it on demand', async () => {
        const relay = new FakeRelayBlobs()
        const store = await createStore(relay)
        const bytes = Buffer.from('hello persistent encrypted attachment')
        const upload = await store.begin({
            sessionId: 'session-1', credentialId: 'client-1', filename: '../notes.txt',
            mimeType: 'text/plain', sizeBytes: bytes.length,
        })
        await store.appendChunk({
            attachmentId: upload.attachmentId, credentialId: 'client-1', offset: 0,
            data: bytes.toString('base64'),
        })
        relay.failCompletes = 1
        await expect(store.complete(upload.attachmentId, 'client-1')).rejects.toThrow('simulated disconnect')
        const completed = await store.complete(upload.attachmentId, 'client-1')
        expect(completed).toMatchObject({ status: 'ready', filename: 'notes.txt' })
        expect(relay.putCalls).toBe(1)
        expect(relay.allEncryptedText()).not.toContain('hello persistent encrypted attachment')
        expect(store.list('session-1')).toMatchObject([{ attachmentId: upload.attachmentId, filename: 'notes.txt' }])

        const [first] = await store.resolveParts('session-1', [upload.attachmentId])
        if (first?.type !== 'file') throw new Error('Expected a file part')
        expect(await readFile(first.path, 'utf8')).toBe(bytes.toString())
        await store.releaseParts([upload.attachmentId])
        await expect(readFile(first.path)).rejects.toMatchObject({ code: 'ENOENT' })

        const [restored] = await store.resolveParts('session-1', [upload.attachmentId])
        if (restored?.type !== 'file') throw new Error('Expected a restored file part')
        expect(await readFile(restored.path, 'utf8')).toBe(bytes.toString())
        await store.releaseParts([upload.attachmentId])
    })

    it('supports zero-byte files and removes selected Session files from Relay', async () => {
        const relay = new FakeRelayBlobs()
        const store = await createStore(relay)
        const upload = await store.begin({
            sessionId: 'session-1', credentialId: 'client-1', filename: 'empty.txt',
            mimeType: 'text/plain', sizeBytes: 0,
        })
        await store.complete(upload.attachmentId, 'client-1')
        expect(store.list('session-1')).toHaveLength(1)
        await store.delete('session-1', [upload.attachmentId])
        expect(store.list('session-1')).toEqual([])
        expect(relay.size).toBe(0)
    })

    it('keeps unfinished uploads credential-bound while ready files are Session-scoped', async () => {
        const relay = new FakeRelayBlobs()
        const store = await createStore(relay)
        const upload = await store.begin({
            sessionId: 'session-1', credentialId: 'client-1', filename: 'shared.bin',
            mimeType: 'application/octet-stream', sizeBytes: 3,
        })
        await expect(store.appendChunk({
            attachmentId: upload.attachmentId, credentialId: 'client-2', offset: 0, data: 'YWJj',
        })).rejects.toThrow('Unknown attachment')
        await store.appendChunk({ attachmentId: upload.attachmentId, credentialId: 'client-1', offset: 0, data: 'YWJj' })
        await store.complete(upload.attachmentId, 'client-1')
        await expect(store.resolveParts('session-2', [upload.attachmentId])).rejects.toThrow('Unknown Session file')
        expect((await store.resolveParts('session-1', [upload.attachmentId]))[0]).toMatchObject({ filename: 'shared.bin' })
        await store.releaseParts([upload.attachmentId])
    })

    it('imports a Gateway-local file into encrypted Relay storage and downloads it in chunks', async () => {
        const relay = new FakeRelayBlobs()
        const store = await createStore(relay)
        const sourceDirectory = await mkdtemp(join(tmpdir(), 'codever-export-source-'))
        directories.push(sourceDirectory)
        const sourcePath = join(sourceDirectory, 'client.apk')
        const bytes = Buffer.from('a complete apk payload')
        await writeFile(sourcePath, bytes)

        const attachment = await store.importLocalFile({
            sessionId: 'session-1', credentialId: 'client-1', path: sourcePath,
            filename: 'client.apk', mimeType: 'application/vnd.android.package-archive',
        })

        expect(attachment).toMatchObject({
            sessionId: 'session-1', filename: 'client.apk', sizeBytes: bytes.length,
            mimeType: 'application/vnd.android.package-archive', status: 'ready',
        })
        expect(relay.allEncryptedText()).not.toContain(bytes.toString())

        const chunks = []
        let offset = 0
        do {
            const chunk = await store.downloadChunk('session-1', attachment.attachmentId, offset, 5)
            chunks.push(Buffer.from(chunk.data, 'base64'))
            if (chunk.nextOffset === null) break
            offset = chunk.nextOffset
        } while (true)
        expect(Buffer.concat(chunks)).toEqual(bytes)
        await expect(store.downloadChunk('session-2', attachment.attachmentId, 0)).rejects.toThrow('Unknown Session file')
    })
})

class FakeRelayBlobs implements ObjectBlobTransport {
    private readonly blobs = new Map<string, { chunks: Map<number, string>; manifest: ObjectBlobManifest }>()
    failCompletes = 0
    putCalls = 0
    get size(): number { return this.blobs.size }
    async begin(blobId: string, totalSize: number, chunkSize: number): Promise<ObjectBlobManifest> {
        if (!this.blobs.has(blobId)) this.blobs.set(blobId, {
            chunks: new Map(), manifest: {
                blobId, totalSize, chunkSize, chunkCount: Math.ceil(totalSize / chunkSize),
                receivedChunkCount: 0, complete: false,
            },
        })
        return { ...this.require(blobId).manifest }
    }
    async putChunk(blobId: string, index: number, encryptedData: string): Promise<void> {
        this.putCalls += 1
        const blob = this.require(blobId)
        const previous = blob.chunks.get(index)
        if (previous && previous !== encryptedData) throw new Error('Chunk mismatch')
        blob.chunks.set(index, encryptedData)
        blob.manifest.receivedChunkCount = blob.chunks.size
    }
    async complete(blobId: string): Promise<void> {
        if (this.failCompletes > 0) {
            this.failCompletes -= 1
            throw new Error('simulated disconnect')
        }
        const blob = this.require(blobId)
        for (let index = 0; index < blob.manifest.chunkCount; index += 1) if (!blob.chunks.has(index)) throw new Error('Missing chunk')
        blob.manifest.complete = true
    }
    async manifest(blobId: string): Promise<ObjectBlobManifest> { return { ...this.require(blobId).manifest } }
    async getChunk(blobId: string, index: number): Promise<string> {
        const value = this.require(blobId).chunks.get(index)
        if (!value) throw new Error('Unknown chunk')
        return value
    }
    async delete(blobId: string): Promise<void> { this.blobs.delete(blobId) }
    allEncryptedText(): string { return [...this.blobs.values()].flatMap(blob => [...blob.chunks.values()]).join('') }
    private require(blobId: string) {
        const blob = this.blobs.get(blobId)
        if (!blob) throw new Error('Unknown blob')
        return blob
    }
}

async function createStore(relay: ObjectBlobTransport): Promise<GatewayAttachmentStore> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-attachments-'))
    directories.push(directory)
    return GatewayAttachmentStore.open(directory, relay)
}
