import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileV3RuntimeStateStore } from '@/gateway/matrix/fileV3RuntimeState'
import { gatewayProjectIdentity } from '@/gateway/matrix/project'

describe('FileV3RuntimeStateStore', () => {
  it('persists project/session state without revision epochs or a current-session pointer', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-runtime-')), 'runtime.json')
    const store = new FileV3RuntimeStateStore(path, 'workspace-1')
    const room = {
      roomId: '!project:example.org',
      conversationId: 'legacy-unused',
      cwd: '/repo',
      providerName: 'test',
    }
    await store.initialize([room])
    await store.updateProject(room.roomId, project => {
      project.sessions.push({
        id: 'session-1',
        sourceCommandId: 'command-1',
        threadRootEventId: '$command-root',
        title: 'Session',
        createdAt: 1,
        updatedAt: 1,
        stateVersion: 1,
        lifecycle: 'active',
        provider: 'test',
        model: null,
        reasoningEffort: null,
        permissionMode: 'default',
        providerSessionId: null,
        extensions: [],
      })
    })

    const recovered = new FileV3RuntimeStateStore(path, 'workspace-1')
    await recovered.initialize([room])
    const project = await recovered.project(room.roomId)
    expect(project.sessions).toMatchObject([{
      id: 'session-1',
      stateVersion: 1,
      lifecycle: 'active',
    }])
    expect(project).not.toHaveProperty('revisionEpoch')
    expect(project).not.toHaveProperty('currentSessionId')
  })

  it('migrates the first v3 runtime state so capability publication can converge after an upgrade', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-runtime-upgrade-')), 'runtime.json')
    const room = {
      roomId: '!project:example.org',
      conversationId: 'legacy-unused',
      cwd: '/repo',
      providerName: 'test',
    }
    await writeFile(path, JSON.stringify({
      version: 3,
      workspaceId: 'workspace-1',
      projects: {
        [room.roomId]: {
          roomId: room.roomId,
          projectId: gatewayProjectIdentity('/repo').id,
          name: 'repo',
          cwd: '/repo',
          provider: 'test',
          model: null,
          reasoningEffort: null,
          permissionMode: 'default',
          snapshotVersion: 1,
          sessions: [],
        },
      },
    }), 'utf8')
    const store = new FileV3RuntimeStateStore(path, 'workspace-1')
    await store.initialize([room])
    const project = await store.project(room.roomId)
    expect(project.capabilitySnapshotVersion).toBe(0)
    expect(project.capabilities).toBeNull()
  })
})
