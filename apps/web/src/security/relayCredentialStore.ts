import type { SecretStore } from './secretStore'

export interface ClientRelayCredential {
  version: 3
  relayProfileId: string
  relayId: string
  credentialId: string
  createdAt: string
  natsSeed: string
  natsUserJwt: string
  natsWebSocketUrl: string
}

export class ClientRelayCredentialStore {
  constructor(private readonly secrets: SecretStore) {}

  async load(relayProfileId: string): Promise<ClientRelayCredential | undefined> {
    const raw = await this.secrets.get(account(relayProfileId))
    if (!raw) return undefined
    const value = parseCredential(JSON.parse(raw) as unknown)
    if (value.relayProfileId !== relayProfileId) throw new Error('Relay credential belongs to another profile')
    return value
  }

  async save(credential: ClientRelayCredential): Promise<void> {
    const value = parseCredential(credential)
    await this.secrets.set(account(value.relayProfileId), JSON.stringify(value))
  }

  delete(relayProfileId: string): Promise<void> { return this.secrets.delete(account(relayProfileId)) }
}

function account(profileId: string): string {
  if (!profileId.trim()) throw new Error('Relay profile ID is required')
  return `relay-credential:${profileId}`
}

function parseCredential(value: unknown): ClientRelayCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Relay credential')
  const input = value as Record<string, unknown>
  if (input.version !== 3) throw new Error('Unsupported Relay credential version; pair this Relay again')
  for (const field of [
    'relayProfileId', 'relayId', 'credentialId', 'createdAt',
    'natsSeed', 'natsUserJwt', 'natsWebSocketUrl',
  ] as const) {
    if (typeof input[field] !== 'string' || !input[field]) throw new Error(`Invalid Relay credential ${field}`)
  }
  if (!/^SU[A-Z2-7]{56}$/.test(input.natsSeed as string)) throw new Error('Relay NATS seed is invalid')
  const natsUrl = new URL(input.natsWebSocketUrl as string)
  if (natsUrl.protocol !== 'ws:' && natsUrl.protocol !== 'wss:') throw new Error('Relay NATS WebSocket URL is invalid')
  return input as unknown as ClientRelayCredential
}
