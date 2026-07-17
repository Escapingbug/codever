import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../src/security/secretStore'
import { createClientSession, DEFAULT_RELAY_PORT, normalizeRelayUrl, relayProfileAddress } from '../src/state/clientSession'

describe('Relay profile address', () => {
  it('turns a domain into the native Relay URL with the hidden default port', () => {
    expect(normalizeRelayUrl('rd.anciety.my.id')).toBe(`http://rd.anciety.my.id:${DEFAULT_RELAY_PORT}`)
  })

  it('supports an explicitly selected advanced port', () => {
    expect(normalizeRelayUrl('relay.example.com', 9443)).toBe('http://relay.example.com:9443')
  })

  it('rejects protocols, inline ports, and paths in the domain field', () => {
    expect(() => normalizeRelayUrl('http://relay.example.com')).toThrow('without http://')
    expect(() => normalizeRelayUrl('relay.example.com:9000')).toThrow('Advanced connection settings')
    expect(() => normalizeRelayUrl('relay.example.com/codever')).toThrow('without a path')
  })

  it('loads the domain and port from a stored profile for editing', () => {
    expect(relayProfileAddress('http://relay.example.com:9443')).toEqual({ domain: 'relay.example.com', port: 9443 })
  })

  it('keeps one Relay and treats a second save as replacement', () => {
    const session = createClientSession(memoryStorage(), new MemorySecretStore())
    const first = session.saveProfile({ name: 'Primary', domain: 'relay-one.example' })
    const replaced = session.saveProfile({ name: 'Replacement', domain: 'relay-two.example' })

    expect(session.profiles.value).toHaveLength(1)
    expect(replaced.id).toBe(first.id)
    expect(session.activeProfile.value?.baseUrl).toContain('relay-two.example')
  })
})

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}
