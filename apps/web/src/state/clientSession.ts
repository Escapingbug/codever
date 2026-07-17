import type { AccountProfile, AuthSessionDto, LoginDto, LoginResultDto } from '@codever/protocol'
import { computed, ref } from 'vue'
import { RelayApi, RelayApiError } from '../api/relayApi'
import { DEMO_RELAY_URL, isDemoRelayUrl } from '../api/demoRelay'
import { createPlatformSecretStore, type SecretStore } from '../security/secretStore'

export interface RelayProfile {
  id: string
  name: string
  baseUrl: string
}

interface StoredAuth {
  accessToken: string
  expiresAt: string
  user: AccountProfile
}

interface PersistedState {
  version: 2
  profiles: RelayProfile[]
  activeProfileId?: string
  auth: Record<string, Omit<StoredAuth, 'accessToken'>>
}

interface LegacyPersistedState extends Omit<PersistedState, 'version' | 'auth'> {
  version: 1
  auth: Record<string, StoredAuth>
}

const STORAGE_KEY = 'codever.client.v1'

export function normalizeRelayUrl(value: string): string {
  const url = new URL(value.trim())
  if (isDemoRelayUrl(url.toString())) return DEMO_RELAY_URL
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Relay URL must use http:// or https://')
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

export function createClientSession(storage: Storage = localStorage, secrets: SecretStore = createPlatformSecretStore()) {
  const profiles = ref<RelayProfile[]>([])
  const activeProfileId = ref<string>()
  const auth = ref<Record<string, StoredAuth>>({})
  const initialized = ref(false)
  const initializationError = ref('')
  let initializePromise: Promise<void> | undefined
  let unauthorizedHandler: (() => void) | undefined

  const activeProfile = computed(() => profiles.value.find((profile) => profile.id === activeProfileId.value))
  const activeAuth = computed(() => activeProfileId.value ? auth.value[activeProfileId.value] : undefined)
  const api = new RelayApi({
    baseUrl: () => activeProfile.value?.baseUrl,
    getAccessToken: () => activeAuth.value?.accessToken,
    onUnauthorized: () => {
      clearActiveAuth()
      unauthorizedHandler?.()
    },
  })

  function persist(): void {
    const value: PersistedState = {
      version: 2,
      profiles: profiles.value,
      activeProfileId: activeProfileId.value,
      auth: Object.fromEntries(Object.entries(auth.value).map(([id, value]) => [id, { expiresAt: value.expiresAt, user: value.user }])),
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(value))
  }

  async function restore(): Promise<void> {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return
    try {
      const value = JSON.parse(raw) as Partial<PersistedState | LegacyPersistedState>
      if ((value.version !== 1 && value.version !== 2) || !Array.isArray(value.profiles)) return
      profiles.value = value.profiles.filter(isRelayProfile)
      activeProfileId.value = profiles.value.some((item) => item.id === value.activeProfileId)
        ? value.activeProfileId
        : profiles.value[0]?.id
      const restored: Record<string, StoredAuth> = {}
      if (value.auth && typeof value.auth === 'object') {
        for (const [profileId, metadata] of Object.entries(value.auth)) {
          if (!metadata || typeof metadata !== 'object' || !('expiresAt' in metadata) || !('user' in metadata)) continue
          const legacyToken = value.version === 1 && 'accessToken' in metadata && typeof metadata.accessToken === 'string'
            ? metadata.accessToken
            : undefined
          if (legacyToken) await secrets.set(tokenAccount(profileId), legacyToken)
          const accessToken = legacyToken ?? await secrets.get(tokenAccount(profileId))
          if (accessToken) restored[profileId] = {
            accessToken,
            expiresAt: String(metadata.expiresAt),
            user: metadata.user as AccountProfile,
          }
        }
      }
      auth.value = restored
      if (value.version === 1) persist()
    } catch {
      storage.removeItem(STORAGE_KEY)
    }
  }

  async function initialize(): Promise<void> {
    if (initializePromise) return initializePromise
    initializePromise = (async () => {
      await restore()
      if (activeProfile.value && activeAuth.value) {
        try {
          const session = await api.getAuthSession()
          await saveAuthSession(session, activeAuth.value.accessToken)
        } catch (error) {
          if (error instanceof RelayApiError && error.status === 401) clearActiveAuth()
          else initializationError.value = friendlyRelayError(error)
        }
      }
      initialized.value = true
    })()
    return initializePromise
  }

  async function testProfile(profile: Pick<RelayProfile, 'baseUrl'>): Promise<void> {
    const temporary = new RelayApi({ baseUrl: normalizeRelayUrl(profile.baseUrl) })
    await temporary.checkHealth()
  }

  function saveProfile(input: { id?: string; name: string; baseUrl: string }): RelayProfile {
    const profile: RelayProfile = {
      id: input.id ?? globalThis.crypto?.randomUUID?.() ?? `relay-${Date.now()}`,
      name: input.name.trim(),
      baseUrl: normalizeRelayUrl(input.baseUrl),
    }
    if (!profile.name) throw new Error('Relay name is required')
    const index = profiles.value.findIndex((item) => item.id === profile.id)
    if (index >= 0) {
      const relayChanged = profiles.value[index]?.baseUrl !== profile.baseUrl
      profiles.value[index] = profile
      if (relayChanged) {
        const nextAuth = { ...auth.value }
        delete nextAuth[profile.id]
        auth.value = nextAuth
        void secrets.delete(tokenAccount(profile.id))
      }
    }
    else profiles.value.push(profile)
    activeProfileId.value = profile.id
    persist()
    return profile
  }

  function removeProfile(id: string): void {
    profiles.value = profiles.value.filter((profile) => profile.id !== id)
    const nextAuth = { ...auth.value }
    delete nextAuth[id]
    auth.value = nextAuth
    void secrets.delete(tokenAccount(id))
    if (activeProfileId.value === id) activeProfileId.value = profiles.value[0]?.id
    persist()
  }

  function selectProfile(id: string): void {
    if (!profiles.value.some((profile) => profile.id === id)) throw new Error('Relay profile does not exist')
    activeProfileId.value = id
    initializationError.value = ''
    persist()
  }

  async function login(input: LoginDto): Promise<void> {
    const session = await api.login(input)
    await saveAuthSession(session, session.accessToken)
  }

  async function saveAuthSession(session: AuthSessionDto | LoginResultDto, accessToken: string): Promise<void> {
    if (!activeProfileId.value) throw new Error('No Relay profile is selected')
    await secrets.set(tokenAccount(activeProfileId.value), accessToken)
    auth.value = { ...auth.value, [activeProfileId.value]: { accessToken, expiresAt: session.expiresAt, user: session.user } }
    persist()
  }

  function clearActiveAuth(): void {
    if (!activeProfileId.value) return
    const next = { ...auth.value }
    delete next[activeProfileId.value]
    void secrets.delete(tokenAccount(activeProfileId.value))
    auth.value = next
    persist()
  }

  async function logout(): Promise<void> {
    try { await api.logout() } finally { clearActiveAuth() }
  }

  function onUnauthorized(handler: () => void): void {
    unauthorizedHandler = handler
  }

  return {
    profiles, activeProfileId, activeProfile, activeAuth, initialized, initializationError, api,
    hasProfiles: computed(() => profiles.value.length > 0),
    isAuthenticated: computed(() => Boolean(activeAuth.value)),
    initialize, testProfile, saveProfile, removeProfile, selectProfile, login, logout, clearActiveAuth, onUnauthorized,
  }
}

function tokenAccount(profileId: string): string { return `relay-token:${profileId}` }

function isRelayProfile(value: unknown): value is RelayProfile {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.baseUrl === 'string'
}

export function friendlyRelayError(error: unknown): string {
  if (error instanceof RelayApiError) {
    if (error.status === 0) return `Cannot reach Relay. Check the address, network, and TLS certificate. (${error.message})`
    if (error.status === 401) return 'Username or password is incorrect, or the session has expired.'
    return `Relay returned ${error.status}: ${error.message}`
  }
  return error instanceof Error ? error.message : 'Unexpected Relay error'
}

export type ClientSession = ReturnType<typeof createClientSession>
export const clientSession = createClientSession()
