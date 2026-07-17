import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayAttachmentStore } from '../attachmentStore'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('GatewayAttachmentStore', () => {
    it('accepts retry-safe chunks, verifies the digest, and resolves a provider file part', async () => {
        const store = await createStore()
        const bytes = Buffer.from('hello attachment')
        const upload = await store.begin({
            sessionId: 'session-1', credentialId: 'client-1', filename: '../notes.txt',
            mimeType: 'text/plain', sizeBytes: bytes.length,
        })
        const first = bytes.subarray(0, 5).toString('base64')
        await store.appendChunk({ attachmentId: upload.attachmentId, credentialId: 'client-1', offset: 0, data: first })
        const retry = await store.appendChunk({ attachmentId: upload.attachmentId, credentialId: 'client-1', offset: 0, data: first })
        expect(retry.receivedBytes).toBe(5)
        await store.appendChunk({
            attachmentId: upload.attachmentId, credentialId: 'client-1', offset: 5,
            data: bytes.subarray(5).toString('base64'),
        })
        const completed = await store.complete(upload.attachmentId, 'client-1', digest(bytes))
        expect(completed).toMatchObject({ status: 'ready', filename: 'notes.txt', receivedBytes: bytes.length })
        const [part] = await store.resolveParts('session-1', 'client-1', [upload.attachmentId])
        expect(part).toMatchObject({ type: 'file', filename: 'notes.txt', source: `attachment:${upload.attachmentId}` })
        if (part?.type !== 'file') throw new Error('Expected a file part')
        expect(await readFile(part.path, 'utf8')).toBe('hello attachment')
        await store.discardReady([upload.attachmentId], 'client-1')
        await expect(readFile(part.path)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('isolates credentials and sessions and rejects a bad digest', async () => {
        const store = await createStore()
        const upload = await store.begin({
            sessionId: 'session-1', credentialId: 'client-1', filename: 'secret.bin',
            mimeType: 'application/octet-stream', sizeBytes: 3,
        })
        await expect(store.appendChunk({
            attachmentId: upload.attachmentId, credentialId: 'client-2', offset: 0, data: 'YWJj',
        })).rejects.toThrow('Unknown attachment')
        await store.appendChunk({ attachmentId: upload.attachmentId, credentialId: 'client-1', offset: 0, data: 'YWJj' })
        await expect(store.complete(upload.attachmentId, 'client-1', '0'.repeat(64))).rejects.toThrow('SHA-256')
        await store.complete(upload.attachmentId, 'client-1', digest(Buffer.from('abc')))
        await expect(store.resolveParts('session-2', 'client-1', [upload.attachmentId])).rejects.toThrow('different session')
    })

    it('removes cancelled upload data', async () => {
        const directory = await temporaryDirectory()
        const store = await GatewayAttachmentStore.open(directory)
        const upload = await store.begin({
            sessionId: 'session-1', credentialId: 'client-1', filename: 'draft.txt',
            mimeType: 'text/plain', sizeBytes: 3,
        })
        await store.cancel(upload.attachmentId, 'client-1')
        await expect(store.resolveParts('session-1', 'client-1', [upload.attachmentId])).rejects.toThrow('Unknown attachment')
        const files = await import('node:fs/promises').then(fs => fs.readdir(join(directory, 'attachments')))
        expect(files.some(file => file.endsWith('.part') || file.endsWith('.bin'))).toBe(false)
    })
})

async function createStore(): Promise<GatewayAttachmentStore> {
    return GatewayAttachmentStore.open(await temporaryDirectory())
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-attachments-'))
    directories.push(directory)
    return directory
}

function digest(value: Buffer): string {
    return createHash('sha256').update(value).digest('hex')
}
