import type { HpkeKeyPair } from '@codever/secure-channel'
import type { SecretStore } from './secretStore'

export interface ClientDeviceCredential {
  version: 2
  relayProfileId: string
  gatewayId: string
  credentialId: string
  deviceHpkeKeyPair: HpkeKeyPair
  gatewayHpkeKeyId: string
  gatewayHpkePublicKey: string
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
  if (input.version !== 2) throw new Error('Unsupported device credential version; pair this Gateway again')
  for (const field of ['relayProfileId', 'gatewayId', 'credentialId', 'gatewayHpkeKeyId', 'gatewayHpkePublicKey', 'createdAt'] as const) {
    if (typeof input[field] !== 'string' || !input[field]) throw new Error(`Invalid device credential ${field}`)
  }
  if (!isKeyPair(input.deviceHpkeKeyPair)) throw new Error('Invalid device HPKE key pair')
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.gatewayHpkePublicKey as string)) throw new Error('Invalid Gateway HPKE public key')
  return input as unknown as ClientDeviceCredential
}

function isKeyPair(value: unknown): value is HpkeKeyPair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const key = value as Record<string, unknown>
  return typeof key.keyId === 'string' && !!key.keyId
    && typeof key.publicKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.publicKey)
    && typeof key.privateKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.privateKey)
}
