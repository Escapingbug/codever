import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentUploadDto } from '@codever/protocol'
import type { RichUserInputPart } from '@/runtime/semantic'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_CHUNK_BYTES = 192 * 1024
const MAX_ATTACHMENTS_PER_CREDENTIAL = 20
const STALE_ATTACHMENT_MS = 24 * 60 * 60 * 1000

interface AttachmentRecord extends AttachmentUploadDto {
    credentialId: string
    path: string
    createdAt: string
    updatedAt: string
}

interface PersistedAttachments { version: 1; records: AttachmentRecord[] }

export class GatewayAttachmentStore {
    private readonly records = new Map<string, AttachmentRecord>()
    private mutationQueue = Promise.resolve()

    private constructor(
        private readonly root: string,
        private readonly metadataPath: string,
    ) {}

    static async open(dataDirectory: string): Promise<GatewayAttachmentStore> {
        const root = join(dataDirectory, 'attachments')
        await mkdir(root, { recursive: true })
        const store = new GatewayAttachmentStore(root, join(root, 'metadata.json'))
        await store.load()
        return store
    }

    begin(input: {
        sessionId: string
        credentialId: string
        filename: string
        mimeType: string
        sizeBytes: number
    }): Promise<AttachmentUploadDto> {
        return this.serialize(async () => {
            await this.pruneStale()
            if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_ATTACHMENT_BYTES) {
                throw new Error(`Attachment size must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes`)
            }
            const ownedCount = [...this.records.values()].filter(record => record.credentialId === input.credentialId).length
            if (ownedCount >= MAX_ATTACHMENTS_PER_CREDENTIAL) {
                throw new Error(`A client can retain at most ${MAX_ATTACHMENTS_PER_CREDENTIAL} attachments`)
            }
            const filename = safeFilename(input.filename)
            const mimeType = input.mimeType.trim() || 'application/octet-stream'
            const attachmentId = `attachment_${randomUUID()}`
            const path = join(this.root, `${attachmentId}.part`)
            await writeFile(path, new Uint8Array(), { flag: 'wx' })
            const now = new Date().toISOString()
            const record: AttachmentRecord = {
                attachmentId,
                sessionId: input.sessionId,
                credentialId: input.credentialId,
                filename,
                mimeType,
                sizeBytes: input.sizeBytes,
                receivedBytes: 0,
                status: 'uploading',
                path,
                createdAt: now,
                updatedAt: now,
            }
            this.records.set(attachmentId, record)
            await this.persist()
            return dto(record)
        })
    }

    appendChunk(input: {
        attachmentId: string
        credentialId: string
        offset: number
        data: string
    }): Promise<AttachmentUploadDto> {
        return this.serialize(async () => {
            const record = this.requireOwned(input.attachmentId, input.credentialId)
            if (record.status !== 'uploading') throw new Error('Attachment upload is not open')
            const bytes = decodeBase64(input.data)
            if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_CHUNK_BYTES) {
                throw new Error(`Attachment chunk must be between 1 and ${MAX_ATTACHMENT_CHUNK_BYTES} bytes`)
            }
            if (input.offset < record.receivedBytes) {
                if (input.offset + bytes.length > record.receivedBytes) throw new Error('Attachment chunk overlaps the received boundary')
                const existing = (await readFile(record.path)).subarray(input.offset, input.offset + bytes.length)
                if (!existing.equals(bytes)) throw new Error('Attachment chunk retry does not match stored bytes')
                return dto(record)
            }
            if (input.offset !== record.receivedBytes) {
                throw new Error(`Attachment chunk offset mismatch: expected ${record.receivedBytes}, received ${input.offset}`)
            }
            if (record.receivedBytes + bytes.length > record.sizeBytes) throw new Error('Attachment exceeds declared size')
            await writeFile(record.path, bytes, { flag: 'a' })
            record.receivedBytes += bytes.length
            record.updatedAt = new Date().toISOString()
            await this.persist()
            return dto(record)
        })
    }

    complete(attachmentId: string, credentialId: string, expectedSha256: string): Promise<AttachmentUploadDto> {
        return this.serialize(async () => {
            const record = this.requireOwned(attachmentId, credentialId)
            if (record.status === 'ready') return dto(record)
            if (record.status !== 'uploading' || record.receivedBytes !== record.sizeBytes) {
                throw new Error(`Attachment upload is incomplete: ${record.receivedBytes}/${record.sizeBytes} bytes`)
            }
            const actual = await sha256(record.path)
            if (actual !== expectedSha256) throw new Error('Attachment SHA-256 mismatch')
            const completedPath = join(this.root, `${attachmentId}.bin`)
            await rename(record.path, completedPath)
            record.path = completedPath
            record.status = 'ready'
            record.updatedAt = new Date().toISOString()
            await this.persist()
            return dto(record)
        })
    }

    cancel(attachmentId: string, credentialId: string): Promise<AttachmentUploadDto> {
        return this.serialize(async () => {
            const record = this.requireOwned(attachmentId, credentialId)
            await rm(record.path, { force: true })
            record.status = 'cancelled'
            record.updatedAt = new Date().toISOString()
            const result = dto(record)
            this.records.delete(attachmentId)
            await this.persist()
            return result
        })
    }

    async resolveParts(sessionId: string, credentialId: string, attachmentIds: string[]): Promise<RichUserInputPart[]> {
        if (attachmentIds.length > 5) throw new Error('A message can contain at most 5 attachments')
        const parts: RichUserInputPart[] = []
        for (const attachmentId of attachmentIds) {
            const record = this.requireOwned(attachmentId, credentialId)
            if (record.sessionId !== sessionId) throw new Error('Attachment belongs to a different session')
            if (record.status !== 'ready') throw new Error(`Attachment is not ready: ${record.filename}`)
            const common = {
                mimeType: record.mimeType,
                filename: record.filename,
                sizeBytes: record.sizeBytes,
                source: `attachment:${record.attachmentId}`,
            }
            if (record.mimeType.startsWith('image/')) {
                parts.push({ type: 'image', data: (await readFile(record.path)).toString('base64'), ...common })
            } else if (record.mimeType.startsWith('audio/')) {
                parts.push({ type: 'audio', data: (await readFile(record.path)).toString('base64'), ...common })
            } else {
                parts.push({ type: 'file', path: record.path, ...common })
            }
        }
        return parts
    }

    discardReady(attachmentIds: string[], credentialId: string): Promise<void> {
        return this.serialize(async () => {
            for (const attachmentId of attachmentIds) {
                const record = this.requireOwned(attachmentId, credentialId)
                if (record.status !== 'ready') continue
                await rm(record.path, { force: true })
                this.records.delete(attachmentId)
            }
            await this.persist()
        })
    }

    private requireOwned(attachmentId: string, credentialId: string): AttachmentRecord {
        const record = this.records.get(attachmentId)
        if (!record || record.credentialId !== credentialId) throw new Error('Unknown attachment upload')
        return record
    }

    private async pruneStale(): Promise<void> {
        const threshold = Date.now() - STALE_ATTACHMENT_MS
        for (const [attachmentId, record] of this.records) {
            if (Date.parse(record.updatedAt) >= threshold) continue
            await rm(record.path, { force: true })
            this.records.delete(attachmentId)
        }
    }

    private async load(): Promise<void> {
        try {
            const value = JSON.parse(await readFile(this.metadataPath, 'utf8')) as PersistedAttachments
            if (value.version !== 1 || !Array.isArray(value.records)) throw new Error('Invalid attachment metadata')
            for (const record of value.records) this.records.set(record.attachmentId, record)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
    }

    private persist(): Promise<void> {
        const temporary = `${this.metadataPath}.tmp`
        const value: PersistedAttachments = { version: 1, records: [...this.records.values()] }
        return writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
            .then(() => rename(temporary, this.metadataPath))
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation)
        this.mutationQueue = result.then(() => undefined, () => undefined)
        return result
    }
}

function dto(record: AttachmentRecord): AttachmentUploadDto {
    return {
        attachmentId: record.attachmentId,
        sessionId: record.sessionId,
        filename: record.filename,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        receivedBytes: record.receivedBytes,
        status: record.status,
    }
}

function safeFilename(value: string): string {
    const filename = value.trim().split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f]/g, '').trim()
    if (!filename || filename === '.' || filename === '..') throw new Error('Attachment filename is invalid')
    return filename.slice(0, 255)
}

function decodeBase64(value: string): Buffer {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('Attachment chunk is not valid base64')
    return Buffer.from(value, 'base64')
}

async function sha256(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return hash.digest('hex')
}
