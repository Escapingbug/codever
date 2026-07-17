import type { SecretStore } from './secretStore'

export interface ClientDeviceCredential {
  version: 1
  relayProfileId: string
  gatewayId: string
  credentialId: string
  secret: string
  gatewayStaticPublicKey: string
  createdAt: string
}

export class ClientDeviceCredentialStore {
  constructor(private readonly secrets: SecretStore) {}

  async load(relayProfileId: string, gatewayId: string): Promise<ClientDeviceCredential | undefined> {
    const raw = await this.secrets.get(account(relayProfileId, gatewayId))
    if (!raw) return undefined
    const value = parseCredential(JSON.parse(raw) as unknown)
    if (value.relayProfileId !== relayProfileId || value.gatewayId !== gatewayId) {
      throw new Error('Device credential belongs to another Relay profile or Gateway')
    }
    return value
  }

  async save(credential: ClientDeviceCredential): Promise<void> {
    const value = parseCredential(credential)
    await this.secrets.set(account(value.relayProfileId, value.gatewayId), JSON.stringify(value))
  }

  delete(relayProfileId: string, gatewayId: string): Promise<void> {
    return this.secrets.delete(account(relayProfileId, gatewayId))
  }
}

function account(relayProfileId: string, gatewayId: string): string {
  if (!relayProfileId.trim() || !gatewayId.trim()) throw new Error('Relay profile ID and Gateway ID are required')
  return `gateway-credential:${relayProfileId}:${gatewayId}`
}

function parseCredential(value: unknown): ClientDeviceCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid device credential')
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('Unsupported device credential version')
  for (const field of ['relayProfileId', 'gatewayId', 'credentialId', 'secret', 'gatewayStaticPublicKey', 'createdAt'] as const) {
    if (typeof input[field] !== 'string' || !input[field]) throw new Error(`Invalid device credential ${field}`)
  }
  if ((input.secret as string).length < 32) throw new Error('Device credential secret is too short')
  return input as unknown as ClientDeviceCredential
}
