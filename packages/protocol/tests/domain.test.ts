import { describe, expect, it } from 'vitest'
import { parseCodeverSession, parseGateway, parseProject } from '../src/index'

const now = '2026-07-16T10:00:00.000Z'

describe('domain schemas', () => {
    it('parses gateway, project, and session resources', () => {
        const gateway = parseGateway({
            id: 'gateway-1',
            workspaceId: 'workspace-1',
            name: 'workstation',
            platform: 'linux',
            version: '1.0.0',
            capabilities: { protocolVersions: [1], providers: ['cursor'], features: ['events'] },
            status: 'online',
            connectionEpoch: 'epoch-1',
            lastSeenAt: now,
        })
        const project = parseProject({
            id: 'project-1', gatewayId: gateway.id, name: 'codever',
            rootPath: '/workspace/codever', canonicalRoot: '/workspace/codever',
        })
        const session = parseCodeverSession({
            id: 'session-1', gatewayId: gateway.id, projectId: project.id,
            state: 'idle', provider: 'cursor', config: { permissionMode: 'ask' },
            createdAt: now, updatedAt: now, lastEventSeq: 0,
        })

        expect(session.projectId).toBe(project.id)
        expect(gateway.capabilities.protocolVersions).toEqual([1])
    })

    it('rejects invalid states, negative cursors, and non-JSON config', () => {
        const base = {
            id: 'session-1', gatewayId: 'gateway-1', projectId: 'project-1',
            provider: 'cursor', createdAt: now, updatedAt: now,
        }
        expect(() => parseCodeverSession({ ...base, state: 'running', config: {}, lastEventSeq: 0 })).toThrow()
        expect(() => parseCodeverSession({ ...base, state: 'idle', config: {}, lastEventSeq: -1 })).toThrow()
        expect(() => parseCodeverSession({ ...base, state: 'idle', config: { bad: undefined }, lastEventSeq: 0 })).toThrow()
    })
})
