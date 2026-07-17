import type { SecretStore } from './secretStore'

export interface ClientRelayCredential {
  version: 1
  relayProfileId: string
  relayId: string
  credentialId: string
  secret: string
  relayStaticPublicKey: string
  createdAt: string
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
  if (input.version !== 1) throw new Error('Unsupported Relay credential version')
  for (const field of ['relayProfileId', 'relayId', 'credentialId', 'secret', 'relayStaticPublicKey', 'createdAt'] as const) {
    if (typeof input[field] !== 'string' || !input[field]) throw new Error(`Invalid Relay credential ${field}`)
  }
  if ((input.secret as string).length < 32) throw new Error('Relay credential secret is too short')
  return input as unknown as ClientRelayCredential
}
