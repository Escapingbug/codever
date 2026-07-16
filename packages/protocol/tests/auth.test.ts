import { describe, expect, it } from 'vitest'
import { CLIENT_EVENT_PROTOCOL, parseAuthSessionDto, parseLoginDto, parseLoginResultDto } from '../src'

describe('auth DTOs', () => {
    it('publishes the browser event WebSocket protocol', () => {
        expect(CLIENT_EVENT_PROTOCOL).toBe('codever.events.v1')
    })

    it('parses login input and trims identity fields', () => {
        expect(parseLoginDto({ username: ' alice ', password: 'secret', deviceName: ' Pixel ' })).toEqual({
            username: 'alice',
            password: 'secret',
            deviceName: 'Pixel',
        })
    })

    it('parses an authenticated session', () => {
        expect(parseLoginResultDto({
            accessToken: 'a'.repeat(32),
            expiresAt: '2027-01-01T00:00:00.000Z',
            user: { id: 'user-1', username: 'alice', workspaceId: 'home', roles: ['operator'] },
        }).user.roles).toEqual(['operator'])
        expect(parseAuthSessionDto({
            expiresAt: '2027-01-01T00:00:00.000Z',
            user: { id: 'user-1', username: 'alice', workspaceId: 'home', roles: ['operator'] },
        }).user.username).toBe('alice')
    })

    it('rejects unknown roles and plaintext-shaped extras', () => {
        expect(() => parseAuthSessionDto({
            expiresAt: '2027-01-01T00:00:00.000Z',
            user: { id: 'user-1', username: 'alice', workspaceId: 'home', roles: ['owner'], password: 'secret' },
        })).toThrow()
    })
})
