import type { ObjectBlobManifest } from '@codever/protocol'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObjectBlobTransport } from './attachmentStore'

/** Durable Gateway-local blob storage. Matrix commands stream chunks to and from this store. */
export class FileObjectBlobTransport implements ObjectBlobTransport {
    private constructor(private readonly root: string) {}

    static async open(root: string): Promise<FileObjectBlobTransport> {
        await mkdir(root, { recursive: true, mode: 0o700 })
        return new FileObjectBlobTransport(root)
    }

    async begin(blobId: string, totalSize: number, chunkSize: number): Promise<ObjectBlobManifest> {
        const existing = await this.readManifest(blobId)
        if (existing) {
            if (existing.totalSize !== totalSize || existing.chunkSize !== chunkSize) {
                throw new Error('Blob resume metadata does not match')
            }
            return existing
        }
        const manifest: ObjectBlobManifest = {
            blobId, totalSize, chunkSize, chunkCount: Math.ceil(totalSize / chunkSize),
            receivedChunkCount: 0, complete: false,
        }
        await this.writeManifest(manifest)
        return manifest
    }

    async putChunk(blobId: string, index: number, encryptedData: string): Promise<void> {
        const manifest = await this.manifest(blobId)
        if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount) {
            throw new Error('Blob chunk index is invalid')
        }
        const path = this.chunkPath(blobId, index)
        try {
            const existing = await readFile(path, 'utf8')
            if (existing !== encryptedData) throw new Error('Blob chunk retry does not match stored data')
            return
        } catch (error) {
            if (!isNotFound(error)) throw error
        }
        await writeFile(path, encryptedData, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        manifest.receivedChunkCount += 1
        await this.writeManifest(manifest)
    }

    async complete(blobId: string): Promise<void> {
        const manifest = await this.manifest(blobId)
        let received = 0
        for (let index = 0; index < manifest.chunkCount; index += 1) {
            try { await readFile(this.chunkPath(blobId, index)); received += 1 } catch (error) {
                if (!isNotFound(error)) throw error
            }
        }
        if (received !== manifest.chunkCount) throw new Error('Blob is incomplete')
        manifest.receivedChunkCount = received
        manifest.complete = true
        await this.writeManifest(manifest)
    }

    async manifest(blobId: string): Promise<ObjectBlobManifest> {
        const manifest = await this.readManifest(blobId)
        if (!manifest) throw new Error('Unknown blob')
        return manifest
    }

    async getChunk(blobId: string, index: number): Promise<string> {
        return readFile(this.chunkPath(blobId, index), 'utf8')
    }

    async delete(blobId: string): Promise<void> {
        const manifest = await this.readManifest(blobId)
        if (!manifest) return
        await Promise.all(Array.from({ length: manifest.chunkCount }, (_, index) =>
            rm(this.chunkPath(blobId, index), { force: true })))
        await rm(this.manifestPath(blobId), { force: true })
    }

    private async readManifest(blobId: string): Promise<ObjectBlobManifest | undefined> {
        try { return JSON.parse(await readFile(this.manifestPath(blobId), 'utf8')) as ObjectBlobManifest }
        catch (error) { if (isNotFound(error)) return undefined; throw error }
    }

    private writeManifest(manifest: ObjectBlobManifest): Promise<void> {
        return writeFile(this.manifestPath(manifest.blobId), `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 })
    }

    private manifestPath(blobId: string): string { return join(this.root, `${safe(blobId)}.manifest.json`) }
    private chunkPath(blobId: string, index: number): string { return join(this.root, `${safe(blobId)}.${index}.chunk`) }
}

function safe(value: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Blob ID is unsafe')
    return value
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
