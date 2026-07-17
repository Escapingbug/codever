import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type InventorySnapshot } from '@codever/protocol'
import { GATEWAY_FEATURES, handleClientRequest, type ClientRequestContext } from '../gatewayApplication'
import { ProjectRegistry } from '../projects'
import { GatewayAttachmentStore } from '../attachments'
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
    })
})

describe('Gateway attachment requests', () => {
    it('uploads encrypted-request chunks and delivers the resolved input to the session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-attachment-'))
        temporaryDirectories.push(directory)
        const attachments = await GatewayAttachmentStore.open(directory)
        let received: RichUserInput | undefined
        const context = {
            credentialId: 'credential-1', gatewayId: 'gateway-1', attachments,
            sessions: {
                get: async () => ({ id: 'session-1' }),
                sendMessage: async (_sessionId: string, input: RichUserInput) => {
                    received = input
                    const file = input.parts.find(part => part.type === 'file')
                    if (file?.type === 'file') expect(await readFile(file.path, 'utf8')).toBe('attachment body')
                },
            } as never,
            inventory: undefined as never, projects: undefined as never, events: undefined as never,
            inventoryChanged: () => undefined,
        } satisfies ClientRequestContext
        const bytes = Buffer.from('attachment body')
        const begin = await handleClientRequest(frame('begin', {
            kind: 'attachment.upload.begin', sessionId: 'session-1', filename: 'notes.txt',
            mimeType: 'text/plain', sizeBytes: bytes.length,
        }), context)
        if (begin.status !== 'completed' || !('attachmentId' in begin.payload)) throw new Error('Upload did not begin')
        const attachmentId = begin.payload.attachmentId
        const chunk = await handleClientRequest(frame('chunk', {
            kind: 'attachment.upload.chunk', attachmentId, offset: 0, data: bytes.toString('base64'),
        }), context)
        expect(chunk.status).toBe('completed')
        const complete = await handleClientRequest(frame('complete', {
            kind: 'attachment.upload.complete', attachmentId,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        }), context)
        expect(complete.status).toBe('completed')
        const message = await handleClientRequest(frame('message', {
            kind: 'session.message', sessionId: 'session-1',
            input: { text: 'Please review this.', attachmentIds: [attachmentId] },
        }), context)
        expect(message.status).toBe('completed')
        expect(received?.parts).toMatchObject([
            { type: 'text', text: 'Please review this.' },
            { type: 'file', filename: 'notes.txt', source: `attachment:${attachmentId}` },
        ])
        await expect(attachments.resolveParts('session-1', 'credential-1', [attachmentId])).rejects.toThrow('Unknown attachment')
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
