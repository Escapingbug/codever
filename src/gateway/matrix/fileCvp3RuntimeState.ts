import { AtomicJsonFile } from '@codever/security/node'
import {
  matrixGatewayCapabilitiesSchema,
  type MatrixGatewayCapabilities,
  type SessionExtensionBinding,
} from '@codever/protocol'
import type { MatrixGatewayRoomConfig } from './config'
import { gatewayProjectIdentity } from './project'

export type Cvp3SessionLifecycle = 'active' | 'archived' | 'deleted'

export interface PersistedCvp3Session {
  id: string
  sourceCommandId: string
  threadRootEventId: string
  title: string
  createdAt: number
  updatedAt: number
  stateVersion: number
  lifecycle: Cvp3SessionLifecycle
  provider: string
  model: string | null
  reasoningEffort: string | null
  permissionMode: string
  providerSessionId: string | null
  extensions: SessionExtensionBinding[]
  extensionRevision: number
  inheritedFromProjectExtensionRevision: number | null
}

export interface PersistedCvp3Project {
  roomId: string
  projectId: string
  name: string
  cwd: string
  provider: string
  model: string | null
  reasoningEffort: string | null
  permissionMode: string
  snapshotVersion: number
  capabilitySnapshotVersion: number
  capabilities: MatrixGatewayCapabilities | null
  defaultExtensions: SessionExtensionBinding[]
  extensionDefaultsRevision: number
  sessions: PersistedCvp3Session[]
}

interface V3RuntimeState {
  version: 3
  workspaceId: string
  projects: Record<string, PersistedCvp3Project>
}

/**
 * Authoritative Gateway metadata for CVP/3. It deliberately contains no
 * revision epoch, command sequence, current session or directory generation.
 */
export class FileCvp3RuntimeStateStore {
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
        validateStateHeader(state, this.workspaceId)
        let changed = false
        // The first CVP/3 release omitted these fields. Migrate every retained
        // project, not only currently configured rooms, so skipped-version
        // upgrades cannot preserve an empty capability cache indefinitely.
        for (const existing of Object.values(state.projects)) {
          if (!Number.isSafeInteger(existing.capabilitySnapshotVersion)) {
            existing.capabilitySnapshotVersion = 0
            changed = true
          }
          if (existing.capabilities === undefined) {
            existing.capabilities = null
            changed = true
          }
          if (!Array.isArray(existing.defaultExtensions)) {
            existing.defaultExtensions = []
            changed = true
          }
          if (!Number.isSafeInteger(existing.extensionDefaultsRevision)) {
            existing.extensionDefaultsRevision = 1
            changed = true
          }
          if (Array.isArray(existing.sessions)) {
            for (const session of existing.sessions) {
              if (!Number.isSafeInteger(session.extensionRevision)) {
                session.extensionRevision = 1
                changed = true
              }
              if (session.inheritedFromProjectExtensionRevision === undefined) {
                session.inheritedFromProjectExtensionRevision = null
                changed = true
              }
            }
          }
        }
        for (const room of rooms) {
          const existing = state.projects[room.roomId]
          if (!existing) {
            state.projects[room.roomId] = defaultProject(room)
            changed = true
            continue
          }
        }
        validateState(state, this.workspaceId)
        return { result: undefined, changed }
      },
    )
  }

  project(roomId: string): Promise<PersistedCvp3Project> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const project = state.projects[roomId]
        if (!project) throw new Error(`CVP/3 project ${roomId} is not initialized`)
        return { result: structuredClone(project), changed: false }
      },
    )
  }

  updateProject<TResult>(
    roomId: string,
    update: (project: PersistedCvp3Project) => TResult,
  ): Promise<TResult> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const project = state.projects[roomId]
        if (!project) throw new Error(`CVP/3 project ${roomId} is not initialized`)
        const result = update(project)
        validateProject(project, roomId)
        return { result, changed: true }
      },
    )
  }

  saveProject(projectInput: PersistedCvp3Project): Promise<void> {
    const project = structuredClone(projectInput)
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        if (!state.projects[project.roomId]) {
          throw new Error(`CVP/3 project ${project.roomId} is not initialized`)
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

function defaultProject(room: MatrixGatewayRoomConfig): PersistedCvp3Project {
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
    capabilitySnapshotVersion: 0,
    capabilities: null,
    defaultExtensions: [],
    extensionDefaultsRevision: 1,
    sessions: [],
  }
}

function validateStateHeader(value: V3RuntimeState, workspaceId: string): void {
  if (
    value.version !== 3
    || value.workspaceId !== workspaceId
    || !value.projects
    || typeof value.projects !== 'object'
    || Array.isArray(value.projects)
  ) {
    throw new Error('Invalid CVP/3 Gateway runtime state')
  }
}

function validateState(value: V3RuntimeState, workspaceId: string): void {
  validateStateHeader(value, workspaceId)
  for (const [roomId, project] of Object.entries(value.projects)) {
    validateProject(project, roomId)
  }
}

function validateProject(project: PersistedCvp3Project, roomId: string): void {
  if (
    project.roomId !== roomId
    || !project.projectId
    || !project.name
    || !project.cwd
    || !project.provider
    || !Number.isSafeInteger(project.snapshotVersion)
    || project.snapshotVersion < 1
    || !Number.isSafeInteger(project.capabilitySnapshotVersion)
    || project.capabilitySnapshotVersion < 0
    || !(project.capabilities === null || typeof project.capabilities === 'object')
    || !Array.isArray(project.defaultExtensions)
    || !Number.isSafeInteger(project.extensionDefaultsRevision)
    || project.extensionDefaultsRevision < 1
    || !Array.isArray(project.sessions)
  ) {
    throw new Error(`Invalid CVP/3 project state for ${roomId}`)
  }
  if (project.capabilities !== null) {
    matrixGatewayCapabilitiesSchema.parse(project.capabilities)
  }
  const expected = gatewayProjectIdentity(project.cwd, project.name)
  if (expected.id !== project.projectId) {
    throw new Error(`CVP/3 project identity changed for ${roomId}`)
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
      || !Number.isSafeInteger(session.extensionRevision)
      || session.extensionRevision < 1
      || (
        session.inheritedFromProjectExtensionRevision !== null
        && (
          !Number.isSafeInteger(session.inheritedFromProjectExtensionRevision)
          || session.inheritedFromProjectExtensionRevision < 1
        )
      )
    ) {
      throw new Error(`Invalid CVP/3 session ${session.id || '<missing>'} in ${roomId}`)
    }
    ids.add(session.id)
  }
}
