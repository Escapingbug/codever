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
  let unsubscribeStatus: (() => void) | undefined
  let reconnectPromise: Promise<void> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempt = 0
  let destroyed = false

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
      unsubscribeStatus = native.subscribeStatus(status => {
        initializationError.value = status.message
        if (!identity.value || destroyed) return
        api.markSuspended()
        connectionState.value = 'reconnecting'
        scheduleReconnect()
      })
      if (identity.value) {
        try {
          await reconnect('connecting')
        } catch { /* reconnect keeps the actionable error and schedules another attempt */ }
      }
      initialized.value = true
    })()
    return initializePromise
  }

  async function logout(): Promise<void> {
    clearReconnectTimer()
    await api.disconnect()
    identity.value = undefined
    initializationError.value = ''
    persist()
  }
  function suspend(): void { api.markSuspended() }
  async function resume(): Promise<void> {
    if (identity.value && initializationError.value) {
      await reconnect('reconnecting')
      return
    }
    api.resume()
    if (identity.value && api.connectionState !== 'connected') await reconnect('reconnecting')
  }

  async function reconnect(phase: 'connecting' | 'reconnecting' = 'reconnecting'): Promise<void> {
    if (!identity.value) return
    if (reconnectPromise) return reconnectPromise
    clearReconnectTimer()
    reconnectPromise = (async () => {
      try {
        await api.disconnect()
        connectionState.value = phase
        const current = identity.value
        if (!current) return
        await native.restore(current.session, MATRIX_SECRET_ACCOUNT)
        api.connect({
          session: current.session,
          controlRoomId: current.controlRoomId,
          executionAccount: EXECUTION_SECRET_ACCOUNT,
          executionKeyId: current.executionKeyId,
        })
        initializationError.value = ''
        reconnectAttempt = 0
        clearReconnectTimer()
      } catch (error) {
        initializationError.value = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unable to restore Matrix session'
        connectionState.value = 'disconnected'
        scheduleReconnect()
        throw error
      } finally {
        reconnectPromise = undefined
      }
    })()
    return reconnectPromise
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || !identity.value || destroyed) return
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5))
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void reconnect('reconnecting').catch(() => undefined)
    }, delay)
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

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
    initialize, configureServer, login, logout, suspend, resume, reconnect,
    listMatrixDevices: () => native.listDevices(),
    listVerifications: () => native.listVerifications(),
    requestVerification: (deviceId: string) => native.requestVerification(deviceId),
    advanceVerification: (flowId: string) => native.advanceVerification(flowId),
    confirmVerification: (flowId: string, matches: boolean) => native.confirmVerification(flowId, matches),
    cancelVerification: (flowId: string) => native.cancelVerification(flowId),
    destroy() {
      destroyed = true
      clearReconnectTimer()
      unsubscribeConnection?.()
      unsubscribeStatus?.()
    },
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
