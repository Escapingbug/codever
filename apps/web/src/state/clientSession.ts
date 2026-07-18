import { computed, ref } from 'vue'
import { RelayApi, RelayApiError } from '../api/relayApi'
import { ClientRelayCredentialStore } from '../security/relayCredentialStore'
import { createPlatformSecretStore, type SecretStore } from '../security/secretStore'

export interface RelayProfile { id: string; name: string; baseUrl: string }
export interface RelayIdentity { relayId: string; credentialId: string; createdAt: string }
export const DEFAULT_RELAY_PORT = 8787

interface PersistedState { version: 3; profiles: RelayProfile[]; activeProfileId?: string }
const STORAGE_KEY = 'codever.client.v1'

export function normalizeRelayUrl(value: string, port = DEFAULT_RELAY_PORT): string {
  const address = value.trim()
  if (!address) throw new Error('Relay domain is required')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Relay port must be between 1 and 65535')
  if (address.includes('://')) throw new Error('Enter only the Relay domain, without http:// or https://')
  if (/[/?#@]/.test(address)) throw new Error('Enter only the Relay domain, without a path')
  const parsed = new URL(`http://${address}`)
  if (parsed.port) throw new Error('Change the port in Advanced connection settings')
  parsed.port = String(port)
  return parsed.toString().replace(/\/$/, '')
}

export function relayProfileAddress(baseUrl: string): { domain: string; port: number } {
  const parsed = new URL(baseUrl)
  return { domain: parsed.hostname, port: Number(parsed.port || DEFAULT_RELAY_PORT) }
}

export function createClientSession(storage: Storage = localStorage, secrets: SecretStore = createPlatformSecretStore()) {
  const profiles = ref<RelayProfile[]>([])
  const activeProfileId = ref<string>()
  const identities = ref<Record<string, RelayIdentity>>({})
  const initialized = ref(false)
  const initializationError = ref('')
  let initializePromise: Promise<void> | undefined
  let disconnectedHandler: (() => void) | undefined

  const activeProfile = computed(() => profiles.value.find(profile => profile.id === activeProfileId.value))
  const activeAuth = computed(() => activeProfileId.value ? identities.value[activeProfileId.value] : undefined)
  const api = new RelayApi({
    baseUrl: () => activeProfile.value?.baseUrl,
    relayProfileId: () => activeProfileId.value,
    secrets,
    onDisconnected: () => disconnectedHandler?.(),
  })
  const credentialStore = new ClientRelayCredentialStore(secrets)

  function persist(): void {
    const value: PersistedState = { version: 3, profiles: profiles.value, activeProfileId: activeProfileId.value }
    storage.setItem(STORAGE_KEY, JSON.stringify(value))
  }

  async function restore(): Promise<void> {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return
    try {
      const value = JSON.parse(raw) as Partial<PersistedState>
      if (!Array.isArray(value.profiles)) return
      const restored = value.profiles.filter(isRelayProfile)
      const selected = restored.find(profile => profile.id === value.activeProfileId) ?? restored[0]
      profiles.value = selected ? [selected] : []
      activeProfileId.value = selected?.id
      for (const profile of profiles.value) {
        const credential = await credentialStore.load(profile.id)
        if (credential) identities.value[profile.id] = publicIdentity(credential)
      }
    } catch (error) {
      initializationError.value = error instanceof Error ? error.message : 'Unable to restore client state'
    }
  }

  async function initialize(): Promise<void> {
    if (initialized.value) return
    if (initializePromise) return initializePromise
    initializePromise = (async () => {
      await restore()
      if (activeAuth.value) {
        try { await api.restoreRelay() } catch (error) {
          initializationError.value = error instanceof Error ? error.message : 'Relay is offline'
        }
      }
      initialized.value = true
    })()
    await initializePromise
  }

  function saveProfile(input: { id?: string; name: string; domain: string; port?: number }): RelayProfile {
    const profile: RelayProfile = {
      id: input.id ?? profiles.value[0]?.id ?? `relay_${crypto.randomUUID()}`,
      name: required(input.name, 'Relay name'),
      baseUrl: normalizeRelayUrl(input.domain, input.port),
    }
    const existing = profiles.value[0]
    if (existing) {
      const changed = existing.baseUrl !== profile.baseUrl
      if (changed) {
        void credentialStore.delete(profile.id)
        const next = { ...identities.value }; delete next[profile.id]; identities.value = next
        void api.disconnect()
      }
    }
    profiles.value = [profile]
    activeProfileId.value = profile.id
    persist()
    return profile
  }

  async function selectProfile(id: string): Promise<void> {
    if (!profiles.value.some(profile => profile.id === id)) throw new Error('Unknown Relay profile')
    await api.disconnect()
    activeProfileId.value = id
    persist()
    if (identities.value[id]) await api.restoreRelay()
  }

  function removeProfile(id: string): void {
    profiles.value = profiles.value.filter(profile => profile.id !== id)
    void credentialStore.delete(id)
    const next = { ...identities.value }; delete next[id]; identities.value = next
    if (activeProfileId.value === id) {
      void api.disconnect()
      activeProfileId.value = profiles.value[0]?.id
    }
    persist()
  }

  async function pairRelay(pairingCode: string): Promise<void> {
    const credential = await api.pairRelay(pairingCode)
    identities.value = { ...identities.value, [credential.relayProfileId]: publicIdentity(credential) }
    persist()
  }

  async function logout(): Promise<void> {
    const profileId = activeProfileId.value
    await api.disconnect(true)
    if (profileId) {
      const next = { ...identities.value }; delete next[profileId]; identities.value = next
    }
    persist()
  }

  return {
    profiles,
    activeProfileId,
    activeProfile,
    activeAuth,
    initialized,
    initializationError,
    api,
    hasProfiles: computed(() => profiles.value.length > 0),
    isAuthenticated: computed(() => Boolean(activeAuth.value)),
    initialize,
    saveProfile,
    selectProfile,
    removeProfile,
    pairRelay,
    logout,
    onUnauthorized(handler: () => void) { disconnectedHandler = handler },
  }
}

function publicIdentity(value: { relayId: string; credentialId: string; createdAt: string }): RelayIdentity {
  return { relayId: value.relayId, credentialId: value.credentialId, createdAt: value.createdAt }
}
function required(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}
function isRelayProfile(value: unknown): value is RelayProfile {
  return Boolean(value && typeof value === 'object' && typeof (value as RelayProfile).id === 'string'
    && typeof (value as RelayProfile).name === 'string' && typeof (value as RelayProfile).baseUrl === 'string')
}

export function friendlyRelayError(error: unknown): string {
  if (error instanceof RelayApiError) return error.message
  return error instanceof Error ? error.message : 'Unable to connect to Relay'
}

export const clientSession = createClientSession()
export type ClientSession = ReturnType<typeof createClientSession>
