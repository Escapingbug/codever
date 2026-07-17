import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type InventorySnapshot } from '@codever/protocol'
import { GATEWAY_FEATURES, handleClientRequest, type ClientRequestContext } from '../gatewayApplication'
import { ProjectRegistry } from '../projects'

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
