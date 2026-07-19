import { computed, ref } from 'vue'
import { CodeverApi, CodeverApiError, type ConnectionState } from '../api/codeverApi'
import {
  NativeMatrixClient, type ExecutionIdentity, type MatrixPublicSession,
} from '../api/nativeMatrixClient'

export interface MatrixServerProfile { homeserver: string; domain: string }
export interface ClientIdentity {
  session: MatrixPublicSession
  controlRoomId: string
  executionKeyId: string
  executionPublicKey: Record<string, unknown>
}

interface PersistedState {
  version: 4
  server?: MatrixServerProfile
  identity?: ClientIdentity
}

const STORAGE_KEY = 'codever.client.matrix.v1'
const MATRIX_SECRET_ACCOUNT = 'matrix-primary'
const EXECUTION_SECRET_ACCOUNT = 'execution-primary'

export function normalizeHomeserver(value: string): MatrixServerProfile {
  const domain = value.trim()
  if (!domain) throw new Error('Server domain is required')
  if (domain.includes('://') || /[/?#@]/.test(domain)) throw new Error('Enter only the server domain')
  const url = new URL(`https://${domain}`)
  if (url.port) throw new Error('Codever uses the standard HTTPS port')
  return { domain: url.hostname, homeserver: url.origin }
}

export function createClientSession(storage: Storage = localStorage, native = new NativeMatrixClient()) {
  const server = ref<MatrixServerProfile>()
  const identity = ref<ClientIdentity>()
  const initialized = ref(false)
  const initializationError = ref('')
  const connectionState = ref<ConnectionState>('disconnected')
  const api = new CodeverApi(native)
  let initializePromise: Promise<void> | undefined
  let unsubscribeConnection: (() => void) | undefined

  function persist(): void {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 4, server: server.value, identity: identity.value } satisfies PersistedState))
  }

  function configureServer(domain: string): MatrixServerProfile {
    const next = normalizeHomeserver(domain)
    if (server.value?.homeserver !== next.homeserver) identity.value = undefined
    server.value = next
    persist()
    return next
  }

  async function login(username: string, password: string): Promise<void> {
    if (!server.value) throw new Error('Configure the Codever server first')
    connectionState.value = 'connecting'
    try {
      const session = await native.login({
        homeserver: server.value.homeserver,
        username: required(username, 'Username'),
        password: required(password, 'Password'),
        deviceDisplayName: deviceDisplayName(),
        secretAccount: MATRIX_SECRET_ACCOUNT,
      })
      const controlRoomId = await native.ensureControlRoom()
      const execution = await native.createExecutionIdentity(EXECUTION_SECRET_ACCOUNT)
      identity.value = toIdentity(session, controlRoomId, execution)
      api.connect({
        session, controlRoomId,
        executionAccount: EXECUTION_SECRET_ACCOUNT,
        executionKeyId: execution.keyId,
      })
      connectionState.value = 'connected'
      initializationError.value = ''
      persist()
    } catch (error) {
      connectionState.value = 'disconnected'
      throw error
    }
  }

  async function initialize(): Promise<void> {
    if (initialized.value) return
    if (initializePromise) return initializePromise
    initializePromise = (async () => {
      restoreSnapshot()
      unsubscribeConnection = api.subscribeConnection(value => { connectionState.value = value })
      if (identity.value) {
        try {
          await native.restore(identity.value.session, MATRIX_SECRET_ACCOUNT)
          api.connect({
            session: identity.value.session,
            controlRoomId: identity.value.controlRoomId,
            executionAccount: EXECUTION_SECRET_ACCOUNT,
            executionKeyId: identity.value.executionKeyId,
          })
        } catch (error) {
          initializationError.value = error instanceof Error ? error.message : 'Unable to restore Matrix session'
        }
      }
      initialized.value = true
    })()
    return initializePromise
  }

  async function logout(): Promise<void> {
    await api.disconnect()
    identity.value = undefined
    initializationError.value = ''
    persist()
  }
  function suspend(): void { api.markSuspended() }
  async function resume(): Promise<void> { api.resume() }

  function restoreSnapshot(): void {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return
    try {
      const value = JSON.parse(raw) as Partial<PersistedState>
      if (value.version !== 4) return
      if (isServer(value.server)) server.value = value.server
      if (isIdentity(value.identity)) identity.value = value.identity
    } catch (error) {
      initializationError.value = error instanceof Error ? error.message : 'Unable to read client state'
    }
  }

  return {
    server, identity, initialized, initializationError, connectionState, api,
    hasServer: computed(() => Boolean(server.value)),
    isAuthenticated: computed(() => Boolean(identity.value)),
    initialize, configureServer, login, logout, suspend, resume,
    listMatrixDevices: () => native.listDevices(),
    listVerifications: () => native.listVerifications(),
    requestVerification: (deviceId: string) => native.requestVerification(deviceId),
    advanceVerification: (flowId: string) => native.advanceVerification(flowId),
    confirmVerification: (flowId: string, matches: boolean) => native.confirmVerification(flowId, matches),
    cancelVerification: (flowId: string) => native.cancelVerification(flowId),
    destroy() { unsubscribeConnection?.() },
  }
}

function toIdentity(session: MatrixPublicSession, controlRoomId: string, execution: ExecutionIdentity): ClientIdentity {
  return { session, controlRoomId, executionKeyId: execution.keyId, executionPublicKey: execution.publicKey }
}
function required(value: string, name: string): string { const text = value.trim(); if (!text) throw new Error(`${name} is required`); return text }
function deviceDisplayName(): string { return /Android/i.test(navigator.userAgent) ? 'Codever Android' : 'Codever Desktop' }
function isServer(value: unknown): value is MatrixServerProfile {
  return !!value && typeof value === 'object' && typeof (value as MatrixServerProfile).homeserver === 'string' && typeof (value as MatrixServerProfile).domain === 'string'
}
function isIdentity(value: unknown): value is ClientIdentity {
  if (!value || typeof value !== 'object') return false
  const item = value as ClientIdentity
  return typeof item.controlRoomId === 'string' && typeof item.executionKeyId === 'string'
    && !!item.session && typeof item.session.userId === 'string' && typeof item.session.deviceId === 'string'
}

export function friendlyCodeverError(error: unknown): string {
  if (error instanceof CodeverApiError) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return error instanceof Error ? error.message : 'Unable to connect to Codever'
}

export const clientSession = createClientSession()
export type ClientSession = ReturnType<typeof createClientSession>
