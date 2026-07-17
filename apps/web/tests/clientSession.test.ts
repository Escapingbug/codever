import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAY_PORT, normalizeRelayUrl, relayProfileAddress } from '../src/state/clientSession'

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
})
