import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OBJECT_BLOB_CHUNK_BYTES, type AttachmentDownloadChunkDto, type AttachmentUploadDto, type ObjectBlobManifest, type SessionAttachmentDto } from '@codever/protocol'
import type { RichUserInputPart } from '@/runtime/semantic'

export type { ObjectBlobManifest } from '@codever/protocol'

export const ATTACHMENT_TRANSFER_CHUNK_BYTES = 192 * 1024
const OBJECT_PLAINTEXT_CHUNK_BYTES = OBJECT_BLOB_CHUNK_BYTES - 28
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000

export interface ObjectBlobTransport {
    begin(blobId: string, totalSize: number, chunkSize: number): Promise<ObjectBlobManifest>
    putChunk(blobId: string, index: number, encryptedData: string): Promise<void>
    complete(blobId: string): Promise<void>
    manifest(blobId: string): Promise<ObjectBlobManifest>
    getChunk(blobId: string, index: number): Promise<string>
    delete(blobId: string): Promise<void>
}

interface AttachmentRecord {
    attachmentId: string
    sessionId: string
    credentialId: string
    filename: string
    mimeType: string
    sizeBytes: number
    receivedBytes: number
    status: 'uploading' | 'ready'
    blobId: string
    dataKey: string
    path: string
    createdAt: string
    updatedAt: string
}

interface PersistedAttachments { version: 2; records: AttachmentRecord[] }

export class GatewayAttachmentStore {
    private readonly records = new Map<string, AttachmentRecord>()
    private readonly leases = new Map<string, number>()
    private readonly pendingLocalDeletes = new Map<string, string>()
    private mutationQueue = Promise.resolve()

    private constructor(
        private readonly root: string,
        private readonly metadataPath: string,
        private readonly blobs: ObjectBlobTransport,
    ) {}

    static async open(dataDirectory: string, blobs: ObjectBlobTransport): Promise<GatewayAttachmentStore> {
        const root = join(dataDirectory, 'attachments')
        await mkdir(root, { recursive: true })
        const store = new GatewayAttachmentStore(root, join(root, 'metadata.json'), blobs)
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
            await this.pruneStaleUploads()
            if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
                throw new Error('Attachment size must be a non-negative safe integer')
            }
            const filename = safeFilename(input.filename)
            const attachmentId = `attachment_${randomUUID()}`
            const path = join(this.root, `${attachmentId}.part`)
            await writeFile(path, new Uint8Array(), { flag: 'wx' })
            const now = new Date().toISOString()
            const record: AttachmentRecord = {
                attachmentId,
                sessionId: input.sessionId,
                credentialId: input.credentialId,
                filename,
                mimeType: input.mimeType.trim() || 'application/octet-stream',
                sizeBytes: input.sizeBytes,
                receivedBytes: 0,
                status: 'uploading',
                blobId: `blob_${randomUUID()}`,
                dataKey: randomBytes(32).toString('base64'),
                path,
                createdAt: now,
                updatedAt: now,
            }
            this.records.set(attachmentId, record)
            await this.persist()
            return uploadDto(record)
        })
    }

    appendChunk(input: {
        attachmentId: string
        credentialId: string
        offset: number
        data: string
    }): Promise<AttachmentUploadDto> {
        return this.serialize(async () => {
            const record = this.requireUploadOwner(input.attachmentId, input.credentialId)
            if (record.status !== 'uploading') throw new Error('Attachment upload is not open')
            const bytes = decodeBase64(input.data)
            if (bytes.length < 1 || bytes.length > ATTACHMENT_TRANSFER_CHUNK_BYTES) {
                throw new Error(`Attachment chunk must be between 1 and ${ATTACHMENT_TRANSFER_CHUNK_BYTES} bytes`)
            }
            if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('Attachment offset is invalid')
            const handle = await open(record.path, 'r+')
            try {
                if (input.offset < record.receivedBytes) {
                    if (input.offset + bytes.length > record.receivedBytes) throw new Error('Attachment chunk overlaps the received boundary')
                    const existing = Buffer.allocUnsafe(bytes.length)
                    await handle.read(existing, 0, existing.length, input.offset)
                    if (!existing.equals(bytes)) throw new Error('Attachment chunk retry does not match stored bytes')
                    return uploadDto(record)
                }
                if (input.offset !== record.receivedBytes) {
                    throw new Error(`Attachment chunk offset mismatch: expected ${record.receivedBytes}, received ${input.offset}`)
                }
                if (record.receivedBytes + bytes.length > record.sizeBytes) throw new Error('Attachment exceeds declared size')
                await handle.write(bytes, 0, bytes.length, input.offset)
            } finally {
                await handle.close()
            }
            record.receivedBytes += bytes.length
            record.updatedAt = new Date().toISOString()
            await this.persist()
            return uploadDto(record)
        })
    }

    complete(attachmentId: string, credentialId: string): Promise<AttachmentUploadDto> {
        return this.serialize(async () => {
            const record = this.requireUploadOwner(attachmentId, credentialId)
            if (record.status === 'ready') return uploadDto(record)
            if (record.receivedBytes !== record.sizeBytes) {
                throw new Error(`Attachment upload is incomplete: ${record.receivedBytes}/${record.sizeBytes} bytes`)
            }
            await this.persistEncryptedBlob(record)
            record.status = 'ready'
            record.updatedAt = new Date().toISOString()
            await this.persist()
            return uploadDto(record)
        })
    }

    cancel(attachmentId: string, credentialId: string): Promise<AttachmentUploadDto> {
        return this.serialize(async () => {
            const record = this.requireUploadOwner(attachmentId, credentialId)
            if (record.status === 'ready') throw new Error('Ready Session files must be deleted, not cancelled')
            await rm(record.path, { force: true })
            await this.blobs.delete(record.blobId).catch(() => undefined)
            this.records.delete(attachmentId)
            await this.persist()
            return { ...uploadDto(record), status: 'cancelled' }
        })
    }

    list(sessionId: string): SessionAttachmentDto[] {
        return [...this.records.values()]
            .filter(record => record.sessionId === sessionId && record.status === 'ready')
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .map(sessionDto)
    }

    importLocalFile(input: {
        sessionId: string
        credentialId: string
        path: string
        filename: string
        mimeType: string
    }): Promise<SessionAttachmentDto> {
        return this.serialize(async () => {
            const source = await stat(input.path)
            if (!source.isFile()) throw new Error('Only regular files can be exported')
            if (!Number.isSafeInteger(source.size)) throw new Error('File size is not supported')
            const attachmentId = `attachment_${randomUUID()}`
            const path = join(this.root, `${attachmentId}.part`)
            const now = new Date().toISOString()
            const record: AttachmentRecord = {
                attachmentId,
                sessionId: input.sessionId,
                credentialId: input.credentialId,
                filename: safeFilename(input.filename),
                mimeType: input.mimeType.trim() || 'application/octet-stream',
                sizeBytes: source.size,
                receivedBytes: source.size,
                status: 'uploading',
                blobId: `blob_${randomUUID()}`,
                dataKey: randomBytes(32).toString('base64'),
                path,
                createdAt: now,
                updatedAt: now,
            }
            await copyFile(input.path, path)
            this.records.set(attachmentId, record)
            try {
                await this.persistEncryptedBlob(record)
                record.status = 'ready'
                record.updatedAt = new Date().toISOString()
                await this.persist()
                return sessionDto(record)
            } catch (error) {
                this.records.delete(attachmentId)
                await rm(path, { force: true })
                await this.blobs.delete(record.blobId).catch(() => undefined)
                throw error
            }
        })
    }

    downloadChunk(
        sessionId: string,
        attachmentId: string,
        offset: number,
        limit = ATTACHMENT_TRANSFER_CHUNK_BYTES,
    ): Promise<AttachmentDownloadChunkDto> {
        return this.serialize(async () => {
            const record = this.requireSessionAttachment(sessionId, attachmentId)
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.sizeBytes) {
                throw new Error('Attachment download offset is invalid')
            }
            const chunkSize = Math.min(Math.max(1, limit), ATTACHMENT_TRANSFER_CHUNK_BYTES, record.sizeBytes - offset)
            await this.ensureMaterialized(record)
            const bytes = Buffer.alloc(chunkSize)
            const handle = await open(record.path, 'r')
            let bytesRead = 0
            try {
                bytesRead = (await handle.read(bytes, 0, chunkSize, offset)).bytesRead
            } finally {
                await handle.close()
            }
            const nextOffset = offset + bytesRead
            return {
                attachmentId,
                offset,
                data: bytes.subarray(0, bytesRead).toString('base64'),
                nextOffset: nextOffset < record.sizeBytes ? nextOffset : null,
            }
        })
    }

    delete(sessionId: string, attachmentIds: string[]): Promise<void> {
        return this.serialize(async () => {
            for (const attachmentId of new Set(attachmentIds)) {
                const record = this.requireSessionAttachment(sessionId, attachmentId)
                await this.blobs.delete(record.blobId)
                this.records.delete(attachmentId)
                if ((this.leases.get(attachmentId) ?? 0) > 0) this.pendingLocalDeletes.set(attachmentId, record.path)
                else await rm(record.path, { force: true })
            }
            await this.persist()
        })
    }

    resolveParts(sessionId: string, attachmentIds: string[]): Promise<RichUserInputPart[]> {
        return this.serialize(async () => {
            const parts: RichUserInputPart[] = []
            const acquired: AttachmentRecord[] = []
            try {
                for (const attachmentId of new Set(attachmentIds)) {
                    const record = this.requireSessionAttachment(sessionId, attachmentId)
                    await this.ensureMaterialized(record)
                    this.leases.set(attachmentId, (this.leases.get(attachmentId) ?? 0) + 1)
                    acquired.push(record)
                    parts.push({
                        type: 'file',
                        path: record.path,
                        mimeType: record.mimeType,
                        filename: record.filename,
                        sizeBytes: record.sizeBytes,
                        source: `attachment:${record.attachmentId}`,
                    })
                }
                return parts
            } catch (error) {
                for (const record of acquired) {
                    const remaining = Math.max(0, (this.leases.get(record.attachmentId) ?? 0) - 1)
                    if (remaining) this.leases.set(record.attachmentId, remaining)
                    else {
                        this.leases.delete(record.attachmentId)
                        await rm(record.path, { force: true })
                    }
                }
                throw error
            }
        })
    }

    releaseParts(attachmentIds: string[]): Promise<void> {
        return this.serialize(async () => {
            for (const attachmentId of new Set(attachmentIds)) {
                const remaining = Math.max(0, (this.leases.get(attachmentId) ?? 0) - 1)
                if (remaining > 0) {
                    this.leases.set(attachmentId, remaining)
                    continue
                }
                this.leases.delete(attachmentId)
                const record = this.records.get(attachmentId)
                const path = record?.path ?? this.pendingLocalDeletes.get(attachmentId)
                this.pendingLocalDeletes.delete(attachmentId)
                if (path) await rm(path, { force: true })
            }
        })
    }

    private async persistEncryptedBlob(record: AttachmentRecord): Promise<void> {
        const key = Buffer.from(record.dataKey, 'base64')
        const chunkCount = Math.ceil(record.sizeBytes / OBJECT_PLAINTEXT_CHUNK_BYTES)
        const manifest = await this.blobs.begin(
            record.blobId,
            record.sizeBytes + chunkCount * 28,
            OBJECT_BLOB_CHUNK_BYTES,
        )
        if (manifest.chunkCount !== chunkCount || manifest.receivedChunkCount > chunkCount) {
            throw new Error('Relay Blob resume state does not match the attachment')
        }
        let index = 0
        for await (const value of createReadStream(record.path, { highWaterMark: OBJECT_PLAINTEXT_CHUNK_BYTES })) {
            const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
            if (index >= manifest.receivedChunkCount) {
                await this.blobs.putChunk(record.blobId, index, encryptChunk(key, record.blobId, index, bytes))
            }
            index += 1
        }
        await this.blobs.complete(record.blobId)
    }

    private async ensureMaterialized(record: AttachmentRecord): Promise<void> {
        if (await exists(record.path)) return
        const manifest = await this.blobs.manifest(record.blobId)
        const expectedChunks = Math.ceil(record.sizeBytes / OBJECT_PLAINTEXT_CHUNK_BYTES)
        if (!manifest.complete || manifest.chunkCount !== expectedChunks) {
            throw new Error(`Relay file is unavailable or incomplete: ${record.filename}`)
        }
        const temporary = `${record.path}.materializing`
        await rm(temporary, { force: true })
        await writeFile(temporary, new Uint8Array(), { flag: 'wx' })
        const key = Buffer.from(record.dataKey, 'base64')
        let received = 0
        const handle = await open(temporary, 'r+')
        try {
            for (let index = 0; index < manifest.chunkCount; index += 1) {
                const plaintext = decryptChunk(key, record.blobId, index, await this.blobs.getChunk(record.blobId, index))
                await handle.write(plaintext, 0, plaintext.length, received)
                received += plaintext.length
            }
        } catch (error) {
            await handle.close()
            await rm(temporary, { force: true })
            throw error
        }
        await handle.close()
        if (received !== record.sizeBytes) {
            await rm(temporary, { force: true })
            throw new Error(`Relay file size mismatch: expected ${record.sizeBytes}, received ${received}`)
        }
        await rename(temporary, record.path)
    }

    private requireUploadOwner(attachmentId: string, credentialId: string): AttachmentRecord {
        const record = this.records.get(attachmentId)
        if (!record || record.credentialId !== credentialId) throw new Error('Unknown attachment upload')
        return record
    }

    private requireSessionAttachment(sessionId: string, attachmentId: string): AttachmentRecord {
        const record = this.records.get(attachmentId)
        if (!record || record.sessionId !== sessionId || record.status !== 'ready') throw new Error('Unknown Session file')
        return record
    }

    private async pruneStaleUploads(): Promise<void> {
        const threshold = Date.now() - STALE_UPLOAD_MS
        for (const [attachmentId, record] of this.records) {
            if (record.status !== 'uploading' || Date.parse(record.updatedAt) >= threshold) continue
            await rm(record.path, { force: true })
            await this.blobs.delete(record.blobId).catch(() => undefined)
            this.records.delete(attachmentId)
        }
    }

    private async load(): Promise<void> {
        try {
            const value = JSON.parse(await readFile(this.metadataPath, 'utf8')) as PersistedAttachments
            if (value.version !== 2 || !Array.isArray(value.records)) throw new Error('Invalid attachment metadata')
            for (const record of value.records) this.records.set(record.attachmentId, record)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
    }

    private persist(): Promise<void> {
        const temporary = `${this.metadataPath}.tmp`
        const value: PersistedAttachments = { version: 2, records: [...this.records.values()] }
        return writeFile(temporary, JSON.stringify(value, null, 2), 'utf8').then(() => rename(temporary, this.metadataPath))
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation)
        this.mutationQueue = result.then(() => undefined, () => undefined)
        return result
    }
}

function uploadDto(record: AttachmentRecord): AttachmentUploadDto {
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

function sessionDto(record: AttachmentRecord): SessionAttachmentDto {
    return {
        attachmentId: record.attachmentId,
        sessionId: record.sessionId,
        filename: record.filename,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        createdAt: record.createdAt,
        status: 'ready',
    }
}

function safeFilename(value: string): string {
    const filename = value.trim().split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f]/g, '').trim()
    if (!filename || filename === '.' || filename === '..') throw new Error('Attachment filename is invalid')
    return filename.slice(0, 255)
}

function decodeBase64(value: string): Buffer {
    if (value === '') return Buffer.alloc(0)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('Attachment chunk is not valid base64')
    return Buffer.from(value, 'base64')
}

function encryptChunk(key: Buffer, blobId: string, index: number, plaintext: Buffer): string {
    const iv = createHmac('sha256', key).update(chunkAad(blobId, index)).digest().subarray(0, 12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(chunkAad(blobId, index))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

function decryptChunk(key: Buffer, blobId: string, index: number, value: string): Buffer {
    const encrypted = Buffer.from(value, 'base64url')
    if (encrypted.length < 28) throw new Error('Relay file chunk is truncated')
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
    decipher.setAAD(chunkAad(blobId, index))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()])
}

function chunkAad(blobId: string, index: number): Buffer {
    return Buffer.from(`codever-relay-blob-v1\0${blobId}\0${index}`, 'utf8')
}

async function exists(path: string): Promise<boolean> {
    try { await access(path); return true } catch { return false }
}
