import { AtomicJsonFile } from '@codever/security/node'
import type { SessionExtensionBinding } from '@codever/protocol'
import type { MatrixGatewayRoomConfig } from './config'
import { gatewayProjectIdentity } from './project'

export type V3SessionLifecycle = 'active' | 'archived' | 'deleted'

export interface PersistedV3Session {
  id: string
  sourceCommandId: string
  threadRootEventId: string
  title: string
  createdAt: number
  updatedAt: number
  stateVersion: number
  lifecycle: V3SessionLifecycle
  provider: string
  model: string | null
  reasoningEffort: string | null
  permissionMode: string
  providerSessionId: string | null
  extensions: SessionExtensionBinding[]
}

export interface PersistedV3Project {
  roomId: string
  projectId: string
  name: string
  cwd: string
  provider: string
  model: string | null
  reasoningEffort: string | null
  permissionMode: string
  snapshotVersion: number
  sessions: PersistedV3Session[]
}

interface V3RuntimeState {
  version: 3
  workspaceId: string
  projects: Record<string, PersistedV3Project>
}

/**
 * Authoritative Gateway metadata for protocol v3. It deliberately contains no
 * revision epoch, command sequence, current session or directory generation.
 */
export class FileV3RuntimeStateStore {
  private readonly file: AtomicJsonFile<V3RuntimeState>

  constructor(
    path: string,
    private readonly workspaceId: string,
  ) {
    this.file = new AtomicJsonFile(path)
  }

  async initialize(rooms: readonly MatrixGatewayRoomConfig[]): Promise<void> {
    await this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        let changed = false
        for (const room of rooms) {
          if (state.projects[room.roomId]) continue
          state.projects[room.roomId] = defaultProject(room)
          changed = true
        }
        return { result: undefined, changed }
      },
    )
  }

  project(roomId: string): Promise<PersistedV3Project> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const project = state.projects[roomId]
        if (!project) throw new Error(`Codever v3 project ${roomId} is not initialized`)
        return { result: structuredClone(project), changed: false }
      },
    )
  }

  updateProject<TResult>(
    roomId: string,
    update: (project: PersistedV3Project) => TResult,
  ): Promise<TResult> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const project = state.projects[roomId]
        if (!project) throw new Error(`Codever v3 project ${roomId} is not initialized`)
        const result = update(project)
        validateProject(project, roomId)
        return { result, changed: true }
      },
    )
  }

  saveProject(projectInput: PersistedV3Project): Promise<void> {
    const project = structuredClone(projectInput)
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        if (!state.projects[project.roomId]) {
          throw new Error(`Codever v3 project ${project.roomId} is not initialized`)
        }
        validateProject(project, project.roomId)
        state.projects[project.roomId] = project
        return { result: undefined, changed: true }
      },
    )
  }
}

function defaultState(workspaceId: string): V3RuntimeState {
  return { version: 3, workspaceId, projects: {} }
}

function defaultProject(room: MatrixGatewayRoomConfig): PersistedV3Project {
  const project = gatewayProjectIdentity(room.cwd)
  return {
    roomId: room.roomId,
    projectId: project.id,
    name: project.name,
    cwd: project.cwd,
    provider: room.providerName,
    model: room.model ?? null,
    reasoningEffort: typeof room.providerSettings?.reasoningEffort === 'string'
      ? room.providerSettings.reasoningEffort
      : null,
    permissionMode: typeof room.providerSettings?.permissionMode === 'string'
      ? room.providerSettings.permissionMode
      : 'default',
    snapshotVersion: 1,
    sessions: [],
  }
}

function validateState(value: V3RuntimeState, workspaceId: string): void {
  if (
    value.version !== 3
    || value.workspaceId !== workspaceId
    || !value.projects
    || typeof value.projects !== 'object'
    || Array.isArray(value.projects)
  ) {
    throw new Error('Invalid Codever v3 Gateway runtime state')
  }
  for (const [roomId, project] of Object.entries(value.projects)) {
    validateProject(project, roomId)
  }
}

function validateProject(project: PersistedV3Project, roomId: string): void {
  if (
    project.roomId !== roomId
    || !project.projectId
    || !project.name
    || !project.cwd
    || !project.provider
    || !Number.isSafeInteger(project.snapshotVersion)
    || project.snapshotVersion < 1
    || !Array.isArray(project.sessions)
  ) {
    throw new Error(`Invalid Codever v3 project state for ${roomId}`)
  }
  const expected = gatewayProjectIdentity(project.cwd, project.name)
  if (expected.id !== project.projectId) {
    throw new Error(`Codever v3 project identity changed for ${roomId}`)
  }
  const ids = new Set<string>()
  for (const session of project.sessions) {
    if (
      !session.id
      || ids.has(session.id)
      || !session.sourceCommandId
      || !session.threadRootEventId
      || !session.title
      || !Number.isSafeInteger(session.createdAt)
      || !Number.isSafeInteger(session.updatedAt)
      || !Number.isSafeInteger(session.stateVersion)
      || session.stateVersion < 1
      || !['active', 'archived', 'deleted'].includes(session.lifecycle)
      || !session.provider
      || !session.permissionMode
      || !Array.isArray(session.extensions)
    ) {
      throw new Error(`Invalid Codever v3 session ${session.id || '<missing>'} in ${roomId}`)
    }
    ids.add(session.id)
  }
}
