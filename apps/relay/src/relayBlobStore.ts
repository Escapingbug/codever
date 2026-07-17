import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
    BlobIdSchema,
    RELAY_BLOB_CHUNK_BYTES,
    RelayBlobManifestSchema,
    type RelayBlobErrorCode,
    type RelayBlobManifest,
} from '@codever/protocol'

interface BlobMetadata {
    formatVersion: 1
    blobId: string
    totalSize: number
    chunkSize: number
    receivedChunkCount: number
    complete: boolean
}

class SerialExecutor {
    private tail: Promise<void> = Promise.resolve()

    run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.tail.then(operation, operation)
        this.tail = result.then(() => undefined, () => undefined)
        return result
    }
}

export class RelayBlobStoreError extends Error {
    constructor(readonly code: RelayBlobErrorCode, message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'RelayBlobStoreError'
    }
}

export class RelayBlobStore {
    private readonly root: string
    private readonly executors = new Map<string, SerialExecutor>()

    constructor(directory: string) {
        this.root = resolve(directory)
    }

    begin(gatewayId: string, input: { blobId: string; totalSize: number; chunkSize: number }): Promise<RelayBlobManifest> {
        const blobId = parseBlobId(input.blobId)
        requireSafeSize(input.totalSize, 'totalSize')
        if (!Number.isSafeInteger(input.chunkSize) || input.chunkSize < 1 || input.chunkSize > RELAY_BLOB_CHUNK_BYTES) {
            throw new RelayBlobStoreError('invalid_chunk', `chunkSize must be from 1 to ${RELAY_BLOB_CHUNK_BYTES}`)
        }
        return this.serial(gatewayId, blobId, async () => {
            const directory = this.blobDirectory(gatewayId, blobId)
            const existing = await this.readMetadata(directory, false)
            if (existing) {
                if (existing.totalSize !== input.totalSize || existing.chunkSize !== input.chunkSize) {
                    throw new RelayBlobStoreError('conflict', 'Blob already exists with different properties')
                }
                return this.manifestFrom(existing)
            }
            await mkdir(directory, { recursive: true, mode: 0o700 })
            const metadata: BlobMetadata = {
                formatVersion: 1,
                blobId,
                totalSize: input.totalSize,
                chunkSize: input.chunkSize,
                receivedChunkCount: 0,
                complete: false,
            }
            await atomicWriteJson(this.metadataPath(directory), metadata)
            return this.manifestFrom(metadata)
        })
    }

    putChunk(gatewayId: string, blobIdInput: string, index: number, opaqueChunk: string): Promise<RelayBlobManifest> {
        const blobId = parseBlobId(blobIdInput)
        if (!Number.isSafeInteger(index) || index < 0) throw new RelayBlobStoreError('invalid_chunk', 'Chunk index must be a non-negative safe integer')
        const bytes = decodeOpaqueChunk(opaqueChunk)
        return this.serial(gatewayId, blobId, async () => {
            const directory = this.blobDirectory(gatewayId, blobId)
            const metadata = await this.readMetadata(directory, true)
            if (metadata.complete) throw new RelayBlobStoreError('conflict', 'Completed Blob cannot be modified')
            if (index > metadata.receivedChunkCount) {
                throw new RelayBlobStoreError('invalid_chunk', `Expected chunk ${metadata.receivedChunkCount}, received ${index}`)
            }
            const expectedLength = expectedChunkLength(metadata, index)
            if (expectedLength === undefined || bytes.length !== expectedLength) {
                throw new RelayBlobStoreError('invalid_chunk', 'Chunk index or byte length does not match the Blob manifest')
            }
            const path = this.chunkPath(directory, index)
            const existing = await readFile(path).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
                throw storageError(`Unable to read Blob chunk ${index}`, error)
            })
            if (existing) {
                if (!existing.equals(bytes)) throw new RelayBlobStoreError('conflict', `Chunk ${index} already contains different bytes`)
            } else {
                if (index < metadata.receivedChunkCount) throw new RelayBlobStoreError('storage_error', `Committed chunk ${index} is missing`)
                await atomicWrite(path, bytes)
            }
            if (index < metadata.receivedChunkCount) return this.manifestFrom(metadata)
            const advanced = { ...metadata, receivedChunkCount: metadata.receivedChunkCount + 1 }
            await atomicWriteJson(this.metadataPath(directory), advanced)
            return this.manifestFrom(advanced)
        })
    }

    complete(gatewayId: string, blobIdInput: string): Promise<RelayBlobManifest> {
        const blobId = parseBlobId(blobIdInput)
        return this.serial(gatewayId, blobId, async () => {
            const directory = this.blobDirectory(gatewayId, blobId)
            const metadata = await this.readMetadata(directory, true)
            const count = chunkCount(metadata)
            if (metadata.receivedChunkCount !== count) {
                throw new RelayBlobStoreError('incomplete', 'Blob chunks are not a complete contiguous sequence')
            }
            for (let index = 0; index < count; index += 1) {
                const expected = expectedChunkLength(metadata, index)!
                const actual = await stat(this.chunkPath(directory, index)).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
                    throw storageError(`Unable to inspect Blob chunk ${index}`, error)
                })
                if (!actual || !actual.isFile() || actual.size !== expected) {
                    throw new RelayBlobStoreError('incomplete', `Blob is missing valid chunk ${index}`)
                }
            }
            if (metadata.complete) return this.manifestFrom(metadata)
            const completed = { ...metadata, complete: true }
            await atomicWriteJson(this.metadataPath(directory), completed)
            return this.manifestFrom(completed)
        })
    }

    manifest(gatewayId: string, blobIdInput: string): Promise<RelayBlobManifest> {
        const blobId = parseBlobId(blobIdInput)
        return this.serial(gatewayId, blobId, async () => {
            const directory = this.blobDirectory(gatewayId, blobId)
            return this.manifestFrom(await this.readMetadata(directory, true))
        })
    }

    getChunk(gatewayId: string, blobIdInput: string, index: number): Promise<string> {
        const blobId = parseBlobId(blobIdInput)
        if (!Number.isSafeInteger(index) || index < 0) throw new RelayBlobStoreError('invalid_chunk', 'Chunk index must be a non-negative safe integer')
        return this.serial(gatewayId, blobId, async () => {
            const directory = this.blobDirectory(gatewayId, blobId)
            const metadata = await this.readMetadata(directory, true)
            if (expectedChunkLength(metadata, index) === undefined) throw new RelayBlobStoreError('invalid_chunk', 'Chunk index is outside the Blob manifest')
            try {
                const bytes = await readFile(this.chunkPath(directory, index))
                if (bytes.length !== expectedChunkLength(metadata, index)) {
                    throw new RelayBlobStoreError('storage_error', `Stored Blob chunk ${index} has an invalid length`)
                }
                return bytes.toString('base64url')
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RelayBlobStoreError('not_found', `Blob chunk ${index} was not found`)
                throw storageError(`Unable to read Blob chunk ${index}`, error)
            }
        })
    }

    delete(gatewayId: string, blobIdInput: string): Promise<void> {
        const blobId = parseBlobId(blobIdInput)
        return this.serial(gatewayId, blobId, async () => {
            try {
                await rm(this.blobDirectory(gatewayId, blobId), { recursive: true, force: true })
            } catch (error) {
                throw storageError('Unable to delete Blob', error)
            }
        })
    }

    private serial<T>(gatewayId: string, blobId: string, operation: () => Promise<T>): Promise<T> {
        const key = `${gatewayStorageKey(gatewayId)}:${blobId}`
        let executor = this.executors.get(key)
        if (!executor) {
            executor = new SerialExecutor()
            this.executors.set(key, executor)
        }
        return executor.run(operation)
    }

    private blobDirectory(gatewayId: string, blobId: string): string {
        return join(this.root, gatewayStorageKey(gatewayId), blobId)
    }

    private metadataPath(directory: string): string { return join(directory, 'manifest.json') }
    private chunkPath(directory: string, index: number): string { return join(directory, `${index}.chunk`) }

    private readMetadata(directory: string, required: true): Promise<BlobMetadata>
    private readMetadata(directory: string, required: false): Promise<BlobMetadata | undefined>
    private async readMetadata(directory: string, required: boolean): Promise<BlobMetadata | undefined> {
        let value: unknown
        try {
            value = JSON.parse(await readFile(this.metadataPath(directory), 'utf8'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return undefined
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RelayBlobStoreError('not_found', 'Blob was not found')
            throw storageError('Unable to read Blob manifest', error)
        }
        return parseMetadata(value)
    }

    private manifestFrom(metadata: BlobMetadata): RelayBlobManifest {
        return RelayBlobManifestSchema.parse({
            blobId: metadata.blobId,
            totalSize: metadata.totalSize,
            chunkSize: metadata.chunkSize,
            chunkCount: chunkCount(metadata),
            receivedChunkCount: metadata.receivedChunkCount,
            complete: metadata.complete,
        })
    }
}

function parseBlobId(value: string): string {
    const result = BlobIdSchema.safeParse(value)
    if (!result.success) throw new RelayBlobStoreError('conflict', 'blobId must be path-safe')
    return result.data
}

function requireSafeSize(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RelayBlobStoreError('conflict', `${label} must be a non-negative safe integer`)
}

function gatewayStorageKey(gatewayId: string): string {
    return createHash('sha256').update(gatewayId).digest('hex')
}

function chunkCount(metadata: BlobMetadata): number {
    return Math.ceil(metadata.totalSize / metadata.chunkSize)
}

function expectedChunkLength(metadata: BlobMetadata, index: number): number | undefined {
    const count = chunkCount(metadata)
    if (index >= count) return undefined
    return index === count - 1 ? metadata.totalSize - metadata.chunkSize * index : metadata.chunkSize
}

function decodeOpaqueChunk(value: string): Buffer {
    if (!value || value.length > Math.ceil(RELAY_BLOB_CHUNK_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new RelayBlobStoreError('invalid_chunk', 'opaqueChunk is not valid bounded base64url')
    }
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.length > RELAY_BLOB_CHUNK_BYTES || bytes.toString('base64url') !== value) {
        throw new RelayBlobStoreError('invalid_chunk', 'opaqueChunk is not canonical bounded base64url')
    }
    return bytes
}

function parseMetadata(value: unknown): BlobMetadata {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw storageError('Invalid Blob manifest')
    const record = value as Record<string, unknown>
    const allowed = new Set(['formatVersion', 'blobId', 'totalSize', 'chunkSize', 'receivedChunkCount', 'complete'])
    if (Object.keys(record).some(key => !allowed.has(key)) || record.formatVersion !== 1
        || typeof record.blobId !== 'string' || typeof record.complete !== 'boolean') throw storageError('Invalid Blob manifest')
    const blobId = parseBlobId(record.blobId)
    if (typeof record.totalSize !== 'number' || typeof record.chunkSize !== 'number'
        || typeof record.receivedChunkCount !== 'number') throw storageError('Invalid Blob manifest')
    requireSafeSize(record.totalSize, 'totalSize')
    if (!Number.isSafeInteger(record.chunkSize) || record.chunkSize < 1 || record.chunkSize > RELAY_BLOB_CHUNK_BYTES) {
        throw storageError('Invalid Blob manifest')
    }
    requireSafeSize(record.receivedChunkCount, 'receivedChunkCount')
    return {
        formatVersion: 1, blobId, totalSize: record.totalSize, chunkSize: record.chunkSize,
        receivedChunkCount: record.receivedChunkCount, complete: record.complete,
    }
}

function storageError(message: string, cause?: unknown): RelayBlobStoreError {
    return new RelayBlobStoreError('storage_error', message, cause === undefined ? undefined : { cause })
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    await atomicWrite(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

async function atomicWrite(path: string, value: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
        await writeFile(temporary, value, { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw storageError('Unable to persist Blob data', error)
    }
}
