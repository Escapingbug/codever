import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type InventorySnapshot } from '@codever/protocol'
import { GATEWAY_FEATURES, handleClientRequest, type ClientRequestContext } from '../gatewayApplication'
import { ProjectRegistry } from '../projects'
import { GatewayAttachmentStore, type ObjectBlobManifest, type ObjectBlobTransport } from '../attachments'
import type { RichUserInput } from '@/runtime/semantic'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Gateway project.create request', () => {
    it('creates a registry project, returns its wire representation, and advances inventory revision', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-application-'))
        temporaryDirectories.push(directory)
        const root = join(directory, 'workspace')
        await mkdir(root)
        const projects = await ProjectRegistry.open({
            storagePath: join(directory, 'projects.json'),
        })
        let revision = 1
        const inventory = async (): Promise<InventorySnapshot> => ({
            generatedAt: new Date().toISOString(),
            revision,
            projects: [],
            sessions: [],
        })
        const context = {
            credentialId: 'credential-1',
            gatewayId: 'gateway-1',
            inventory,
            projects,
            inventoryChanged: () => { revision += 1 },
            sessions: undefined as never,
            events: undefined as never,
            attachments: undefined as never,
            executionTrust: undefined as never,
        } satisfies ClientRequestContext

        const response = await handleClientRequest({
            version: PROTOCOL_VERSION,
            type: 'client.gateway.request',
            requestId: 'request-1',
            idempotencyKey: 'create-project-1',
            payload: {
                kind: 'project.create',
                input: { name: 'Workspace', rootPath: root, defaultProvider: 'codex' },
            },
        }, context)

        expect(response.status).toBe('completed')
        if (response.status !== 'completed' || !('project' in response.payload)) {
            throw new Error('Expected a completed project response')
        }
        expect(response.payload.project).toMatchObject({
            gatewayId: 'gateway-1',
            name: 'Workspace',
            rootPath: root,
            canonicalRoot: root,
            defaultProvider: 'codex',
        })
        expect(await projects.list()).toHaveLength(1)
        expect((await context.inventory()).revision).toBe(2)

        const duplicate = await handleClientRequest({
            version: PROTOCOL_VERSION,
            type: 'client.gateway.request',
            requestId: 'request-2',
            idempotencyKey: 'create-project-2',
            payload: {
                kind: 'project.create',
                input: { name: 'Duplicate', rootPath: root },
            },
        }, context)

        expect(duplicate.status).toBe('failed')
        expect(await projects.list()).toHaveLength(1)
        expect((await context.inventory()).revision).toBe(2)
    })

    it('advertises project creation as a Gateway capability', () => {
        expect(GATEWAY_FEATURES).toContain('project.create')
        expect(GATEWAY_FEATURES).toEqual(expect.arrayContaining([
            'attachment.media',
            'attachment.manage',
            'matrix-e2ee',
            'matrix-durable-sync',
            'cose-cwt-authorization',
            'matrix-encrypted-media',
        ]))
    })
})

describe('Gateway attachment requests', () => {
    it('imports Matrix encrypted media and delivers the resolved input to the session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-attachment-'))
        temporaryDirectories.push(directory)
        const attachments = await GatewayAttachmentStore.open(directory, new TestRelayBlobs())
        let received: RichUserInput | undefined
        const context = {
            credentialId: 'credential-1', gatewayId: 'gateway-1', attachments,
            sessions: {
                get: async () => ({ id: 'session-1' }),
                acceptMessage: async (_sessionId: string, input: RichUserInput) => {
                    received = input
                    const file = input.parts.find(part => part.type === 'file')
                    if (file?.type === 'file') expect(await readFile(file.path, 'utf8')).toBe('attachment body')
                    return { completion: Promise.resolve({ turnId: 'turn-1', status: 'success' as const }) }
                },
            } as never,
            inventory: undefined as never, projects: undefined as never, events: undefined as never,
            executionTrust: undefined as never,
            mediaStagingDirectory: join(directory, 'matrix-staging'),
            matrixMedia: {
                download: async (encryptedFile, destination) => {
                    expect(encryptedFile).toEqual({ url: 'mxc://matrix.example/media' })
                    await writeFile(destination, 'attachment body')
                },
            },
            inventoryChanged: () => undefined,
        } satisfies ClientRequestContext
        const bytes = Buffer.from('attachment body')
        const imported = await handleClientRequest(frame('import', {
            kind: 'attachment.media.import', sessionId: 'session-1', filename: 'notes.txt',
            mimeType: 'text/plain', sizeBytes: bytes.length,
            encryptedFile: { url: 'mxc://matrix.example/media' },
        }), context)
        if (imported.status !== 'completed' || !('attachmentId' in imported.payload)) {
            throw new Error('Media was not imported')
        }
        const attachmentId = imported.payload.attachmentId
        const message = await handleClientRequest(frame('message', {
            kind: 'session.message', sessionId: 'session-1',
            input: { text: 'Please review this.', attachmentIds: [attachmentId] },
        }), context)
        expect(message.status).toBe('completed')
        expect(received?.parts).toMatchObject([
            { type: 'text', text: 'Please review this.' },
            { type: 'file', filename: 'notes.txt', source: `attachment:${attachmentId}` },
        ])
        expect(attachments.list('session-1')).toHaveLength(1)
        expect((await attachments.resolveParts('session-1', [attachmentId]))[0]).toMatchObject({ filename: 'notes.txt' })
        await attachments.releaseParts([attachmentId])
    })

    it('rejects a mismatched Matrix media size and removes the staging file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-media-mismatch-'))
        temporaryDirectories.push(directory)
        const staging = join(directory, 'matrix-staging')
        const context = {
            credentialId: 'credential-1', gatewayId: 'gateway-1',
            attachments: await GatewayAttachmentStore.open(join(directory, 'attachments'), new TestRelayBlobs()),
            sessions: { get: async () => ({ id: 'session-1' }) } as never,
            matrixMedia: { download: async (_file, destination) => writeFile(destination, 'short') },
            mediaStagingDirectory: staging,
            inventory: undefined as never, projects: undefined as never, events: undefined as never,
            executionTrust: undefined as never, inventoryChanged: () => undefined,
        } satisfies ClientRequestContext

        const response = await handleClientRequest(frame('mismatch', {
            kind: 'attachment.media.import', sessionId: 'session-1', filename: 'bad.bin',
            mimeType: 'application/octet-stream', sizeBytes: 100,
            encryptedFile: { url: 'mxc://matrix.example/bad' },
        }), context)

        expect(response.status).toBe('failed')
        expect(await readdir(staging)).toEqual([])
    })

    it('exports only files inside the Session Project and returns downloadable chunks', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-file-export-'))
        temporaryDirectories.push(directory)
        const projectRoot = join(directory, 'project')
        await mkdir(projectRoot)
        const apk = Buffer.from('signed apk bytes')
        await writeFile(join(projectRoot, 'codever.apk'), apk)
        await writeFile(join(directory, 'outside.apk'), 'outside')
        const attachments = await GatewayAttachmentStore.open(join(directory, 'attachments'), new TestRelayBlobs())
        const context = {
            credentialId: 'credential-1', gatewayId: 'gateway-1', attachments,
            sessions: { get: async () => ({ id: 'session-1', projectId: 'project-1' }) } as never,
            projects: { get: async () => ({ id: 'project-1', canonicalRoot: projectRoot }) } as never,
            inventory: undefined as never, events: undefined as never,
            executionTrust: undefined as never,
            inventoryChanged: () => undefined,
        } satisfies ClientRequestContext

        const exported = await handleClientRequest(frame('export', {
            kind: 'file.export', sessionId: 'session-1', path: 'codever.apk',
        }), context)
        expect(exported.status).toBe('completed')
        if (exported.status !== 'completed' || !('attachmentId' in exported.payload)) {
            throw new Error('Expected an exported Session attachment')
        }
        expect(exported.payload).toMatchObject({
            filename: 'codever.apk', mimeType: 'application/vnd.android.package-archive', sizeBytes: apk.length,
        })

        const downloaded = await handleClientRequest(frame('download', {
            kind: 'attachment.download', sessionId: 'session-1',
            attachmentId: exported.payload.attachmentId, offset: 0,
        }), context)
        expect(downloaded.status).toBe('completed')
        if (downloaded.status !== 'completed' || !('data' in downloaded.payload)) {
            throw new Error('Expected a downloadable attachment chunk')
        }
        expect(Buffer.from(downloaded.payload.data, 'base64')).toEqual(apk)

        const outside = await handleClientRequest(frame('outside', {
            kind: 'file.export', sessionId: 'session-1', path: join(directory, 'outside.apk'),
        }), context)
        expect(outside.status).toBe('failed')
        if (outside.status === 'failed') expect(outside.error.message).toContain('inside the current Project')
    })
})

describe('Gateway command liveness', () => {
    it('routes a Session rename through the authenticated Gateway command handler', async () => {
        const rename = vi.fn(async () => ({ id: 'session-1', title: 'Renamed task' }))
        const context = {
            credentialId: 'credential-1', gatewayId: 'gateway-1',
            sessions: { rename } as never,
            attachments: undefined as never, inventory: undefined as never,
            projects: undefined as never, events: undefined as never,
            executionTrust: undefined as never, inventoryChanged: () => undefined,
        } satisfies ClientRequestContext

        const response = await handleClientRequest(frame('rename-session', {
            kind: 'session.rename', sessionId: 'session-1', input: { title: 'Renamed task' },
        }), context)

        expect(response.status).toBe('completed')
        expect(rename).toHaveBeenCalledWith('session-1', 'Renamed task', 'idempotency-rename-session')
    })

    it('lets an existing COSE principal add and revoke a later client root', async () => {
        const trust = vi.fn(async () => ({ keyId: 'key-2' }))
        const revoke = vi.fn(async () => true)
        const context = {
            credentialId: 'trusted-phone', gatewayId: 'gateway-1',
            executionTrust: { trust, revoke } as never,
            sessions: undefined as never, attachments: undefined as never,
            inventory: undefined as never, projects: undefined as never, events: undefined as never,
            inventoryChanged: () => undefined,
        } satisfies ClientRequestContext
        const publicKey = {
            kty: 'EC' as const, crv: 'P-256' as const, alg: 'ES256' as const, use: 'sig' as const,
            kid: 'key-2', x: 'x-coordinate', y: 'y-coordinate',
        }

        const added = await handleClientRequest(frame('trust-root', {
            kind: 'execution.root.trust', ownerId: 'tablet-device', label: 'Tablet', publicKey,
        }), context)
        const revoked = await handleClientRequest(frame('revoke-root', {
            kind: 'execution.root.revoke', keyId: 'key-2',
        }), context)

        expect(added.status).toBe('completed')
        expect(revoked.status).toBe('completed')
        expect(trust).toHaveBeenCalledWith('tablet-device', publicKey, 'Tablet')
        expect(revoke).toHaveBeenCalledWith('key-2')
    })

    it('acknowledges a message and accepts cancel while the provider turn is still running', async () => {
        const completion = deferred<{ turnId: string; status: 'cancelled' }>()
        let cancelCalls = 0
        const context = {
            credentialId: 'credential-1', gatewayId: 'gateway-1',
            sessions: {
                get: async () => ({ id: 'session-1' }),
                acceptMessage: async () => ({ completion: completion.promise }),
                cancel: async () => { cancelCalls += 1; return true },
            } as never,
            attachments: {
                resolveParts: async () => [],
                releaseParts: async () => undefined,
            } as never,
            inventory: undefined as never, projects: undefined as never, events: undefined as never,
            executionTrust: undefined as never,
            inventoryChanged: () => undefined,
        } satisfies ClientRequestContext

        const accepted = await handleClientRequest(frame('long-message', {
            kind: 'session.message', sessionId: 'session-1', input: { text: 'long task' },
        }), context)
        expect(accepted.status).toBe('completed')

        const cancelled = await handleClientRequest(frame('cancel-long-message', {
            kind: 'session.cancel', sessionId: 'session-1', input: { reason: 'stop' },
        }), context)
        expect(cancelled.status).toBe('completed')
        expect(cancelCalls).toBe(1)
        completion.resolve({ turnId: 'turn-1', status: 'cancelled' })
        await completion.promise
    })
})

function frame(
    suffix: string,
    payload: Parameters<typeof handleClientRequest>[0]['payload'],
): Parameters<typeof handleClientRequest>[0] {
    return {
        version: PROTOCOL_VERSION,
        type: 'client.gateway.request',
        requestId: `request-${suffix}`,
        idempotencyKey: `idempotency-${suffix}`,
        payload,
    }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>(settle => { resolve = settle })
    return { promise, resolve }
}

class TestRelayBlobs implements ObjectBlobTransport {
    private readonly values = new Map<string, { chunks: Map<number, string>; manifest: ObjectBlobManifest }>()
    async begin(blobId: string, totalSize: number, chunkSize: number): Promise<ObjectBlobManifest> {
        if (!this.values.has(blobId)) this.values.set(blobId, {
            chunks: new Map(), manifest: {
                blobId, totalSize, chunkSize, chunkCount: Math.ceil(totalSize / chunkSize),
                receivedChunkCount: 0, complete: false,
            },
        })
        return this.require(blobId).manifest
    }
    async putChunk(blobId: string, index: number, encryptedData: string): Promise<void> {
        const blob = this.require(blobId)
        blob.chunks.set(index, encryptedData)
        blob.manifest.receivedChunkCount = blob.chunks.size
    }
    async complete(blobId: string): Promise<void> {
        this.require(blobId).manifest.complete = true
    }
    async manifest(blobId: string): Promise<ObjectBlobManifest> { return this.require(blobId).manifest }
    async getChunk(blobId: string, index: number): Promise<string> {
        const value = this.require(blobId).chunks.get(index)
        if (!value) throw new Error('Missing test chunk')
        return value
    }
    async delete(blobId: string): Promise<void> { this.values.delete(blobId) }
    private require(blobId: string) {
        const value = this.values.get(blobId)
        if (!value) throw new Error('Missing test blob')
        return value
    }
}
