import type { ObjectBlobManifest } from '@codever/protocol'
import { gatewayObjectBucketName } from '@codever/protocol'
import { Objm, type ObjectStore } from '@nats-io/obj'
import type { NatsConnection } from '@nats-io/transport-node'
import type { ObjectBlobTransport } from './attachmentStore'

export class NatsObjectBlobTransport implements ObjectBlobTransport {
    constructor(private readonly store: ObjectStore) {}

    static async open(connection: NatsConnection, gatewayId: string): Promise<NatsObjectBlobTransport> {
        const store = await new Objm(connection).open(gatewayObjectBucketName(gatewayId))
        return new NatsObjectBlobTransport(store)
    }

    async begin(blobId: string, totalSize: number, chunkSize: number): Promise<ObjectBlobManifest> {
        const existing = await this.readManifest(blobId)
        if (existing) {
            if (existing.totalSize !== totalSize || existing.chunkSize !== chunkSize) {
                throw new Error('NATS Object Store Blob resume metadata does not match')
            }
            return existing
        }
        const manifest: ObjectBlobManifest = {
            blobId,
            totalSize,
            chunkSize,
            chunkCount: Math.ceil(totalSize / chunkSize),
            receivedChunkCount: 0,
            complete: false,
        }
        await this.writeManifest(manifest)
        return manifest
    }

    async putChunk(blobId: string, index: number, encryptedData: string): Promise<void> {
        const manifest = await this.manifest(blobId)
        if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount) throw new Error('Blob chunk index is invalid')
        const name = chunkName(blobId, index)
        const bytes = new TextEncoder().encode(encryptedData)
        const existing = await this.store.getBlob(name)
        if (existing) {
            if (!equal(existing, bytes)) throw new Error('Blob chunk retry does not match the stored object')
            return
        }
        await this.store.putBlob({ name }, bytes)
        manifest.receivedChunkCount = Math.min(manifest.chunkCount, manifest.receivedChunkCount + 1)
        await this.writeManifest(manifest)
    }

    async complete(blobId: string): Promise<void> {
        const manifest = await this.manifest(blobId)
        manifest.receivedChunkCount = await this.receivedChunks(manifest)
        if (manifest.receivedChunkCount !== manifest.chunkCount) throw new Error('NATS Object Store Blob is incomplete')
        manifest.complete = true
        await this.writeManifest(manifest)
    }

    async manifest(blobId: string): Promise<ObjectBlobManifest> {
        const value = await this.readManifest(blobId)
        if (!value) throw new Error('Unknown NATS Object Store Blob')
        return value
    }

    async getChunk(blobId: string, index: number): Promise<string> {
        const value = await this.store.getBlob(chunkName(blobId, index))
        if (!value) throw new Error('Unknown NATS Object Store Blob chunk')
        return new TextDecoder().decode(value)
    }

    async delete(blobId: string): Promise<void> {
        const manifest = await this.readManifest(blobId)
        if (!manifest) return
        await Promise.all(Array.from({ length: manifest.chunkCount }, (_, index) =>
            this.store.delete(chunkName(blobId, index)).catch(() => undefined)))
        await this.store.delete(manifestName(blobId)).catch(() => undefined)
    }

    private async receivedChunks(manifest: ObjectBlobManifest): Promise<number> {
        const values = await Promise.all(Array.from({ length: manifest.chunkCount }, (_, index) =>
            this.store.info(chunkName(manifest.blobId, index))))
        return values.filter(Boolean).length
    }

    private async readManifest(blobId: string): Promise<ObjectBlobManifest | undefined> {
        const value = await this.store.getBlob(manifestName(blobId))
        if (!value) return undefined
        const manifest = JSON.parse(new TextDecoder().decode(value)) as ObjectBlobManifest
        if (manifest.blobId !== blobId || !Number.isSafeInteger(manifest.chunkCount)) {
            throw new Error('Invalid NATS Object Store Blob manifest')
        }
        return manifest
    }

    private async writeManifest(manifest: ObjectBlobManifest): Promise<void> {
        await this.store.putBlob(
            { name: manifestName(manifest.blobId) },
            new TextEncoder().encode(JSON.stringify(manifest)),
        )
    }
}

export class SwitchableBlobTransport implements ObjectBlobTransport {
    private delegate?: ObjectBlobTransport
    use(delegate: ObjectBlobTransport): void { this.delegate = delegate }
    begin(...args: Parameters<ObjectBlobTransport['begin']>) { return this.require().begin(...args) }
    putChunk(...args: Parameters<ObjectBlobTransport['putChunk']>) { return this.require().putChunk(...args) }
    complete(...args: Parameters<ObjectBlobTransport['complete']>) { return this.require().complete(...args) }
    manifest(...args: Parameters<ObjectBlobTransport['manifest']>) { return this.require().manifest(...args) }
    getChunk(...args: Parameters<ObjectBlobTransport['getChunk']>) { return this.require().getChunk(...args) }
    delete(...args: Parameters<ObjectBlobTransport['delete']>) { return this.require().delete(...args) }
    private require(): ObjectBlobTransport {
        if (!this.delegate) throw new Error('Durable Relay file storage is not connected')
        return this.delegate
    }
}

function manifestName(blobId: string): string { return `${blobId}.manifest` }
function chunkName(blobId: string, index: number): string { return `${blobId}.chunk.${index}` }
function equal(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}
