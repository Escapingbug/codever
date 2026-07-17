import { describe, expect, it } from 'vitest'
import {
    finishOpaquePairingClient,
    OpaquePairingAuthority,
    startOpaquePairingClient,
} from '../src/opaquePairing'

describe('OpaquePairingAuthority', () => {
    it('derives a matching session key and consumes the one-time code atomically', async () => {
        const authority = await OpaquePairingAuthority.create({ serverId: 'relay-1', domain: 'relay-client' })
        const ticket = authority.issue()
        const clientStart = await startOpaquePairingClient(ticket.code)
        const serverStart = authority.begin(clientStart.pairingId, clientStart.startLoginRequest)
        const clientFinish = finishOpaquePairingClient({
            code: ticket.code,
            serverId: 'relay-1',
            domain: 'relay-client',
            clientLoginState: clientStart.clientLoginState,
            loginResponse: serverStart.loginResponse,
        })
        const serverFinish = authority.finish(serverStart.handshakeId, clientFinish.finishLoginRequest)

        expect(serverFinish.sessionKey).toBe(clientFinish.sessionKey)
        expect(clientFinish.serverStaticPublicKey).toBe(authority.serverStaticPublicKey)
        expect(authority.hasOpenPairing(ticket.pairingId)).toBe(false)
        expect(() => authority.finish(serverStart.handshakeId, clientFinish.finishLoginRequest)).toThrow('invalid or expired')
        expect(() => authority.begin(ticket.pairingId, clientStart.startLoginRequest)).toThrow('not open')
    })

    it('expires after three minutes and clears incomplete handshakes', async () => {
        let now = Date.parse('2026-07-17T00:00:00.000Z')
        const authority = await OpaquePairingAuthority.create({ serverId: 'relay-1', domain: 'relay-client', now: () => now })
        const ticket = authority.issue()
        const client = await startOpaquePairingClient(ticket.code)
        const started = authority.begin(client.pairingId, client.startLoginRequest)
        now += 3 * 60_000

        expect(authority.hasOpenPairing(ticket.pairingId)).toBe(false)
        expect(() => authority.finish(started.handshakeId, 'invalid')).toThrow('invalid or expired')
    })

    it('closes the request after the total attempt budget regardless of source IP', async () => {
        const authority = await OpaquePairingAuthority.create({ serverId: 'relay-1', domain: 'relay-client', maxAttempts: 5 })
        const ticket = authority.issue()
        for (let index = 0; index < 5; index += 1) {
            const wrong = await startOpaquePairingClient(`${ticket.pairingId}-AAAAAAAAAA`)
            authority.begin(ticket.pairingId, wrong.startLoginRequest)
        }
        expect(authority.hasOpenPairing(ticket.pairingId)).toBe(false)
        const sixth = await startOpaquePairingClient(`${ticket.pairingId}-BBBBBBBBBB`)
        expect(() => authority.begin(ticket.pairingId, sixth.startLoginRequest)).toThrow('attempts are exhausted')
    })

    it('allows the final budgeted attempt to finish successfully', async () => {
        const authority = await OpaquePairingAuthority.create({ serverId: 'relay-1', domain: 'relay-client', maxAttempts: 1 })
        const ticket = authority.issue()
        const clientStart = await startOpaquePairingClient(ticket.code)
        const serverStart = authority.begin(ticket.pairingId, clientStart.startLoginRequest)
        expect(authority.hasOpenPairing(ticket.pairingId)).toBe(false)
        const clientFinish = finishOpaquePairingClient({
            code: ticket.code, serverId: 'relay-1', domain: 'relay-client', clientLoginState: clientStart.clientLoginState,
            loginResponse: serverStart.loginResponse,
        })
        expect(authority.finish(serverStart.handshakeId, clientFinish.finishLoginRequest).sessionKey).toBe(clientFinish.sessionKey)
    })

    it('rejects the wrong code and a changed Relay identity', async () => {
        const authority = await OpaquePairingAuthority.create({ serverId: 'relay-1', domain: 'relay-client' })
        const ticket = authority.issue()
        const wrong = await startOpaquePairingClient(`${ticket.pairingId}-AAAAAAAAAA`)
        const serverStart = authority.begin(wrong.pairingId, wrong.startLoginRequest)
        expect(() => finishOpaquePairingClient({
            code: `${ticket.pairingId}-AAAAAAAAAA`,
            serverId: 'relay-1',
            domain: 'relay-client',
            clientLoginState: wrong.clientLoginState,
            loginResponse: serverStart.loginResponse,
        })).toThrow('authentication failed')

        const correct = await startOpaquePairingClient(ticket.code)
        const correctResponse = authority.begin(correct.pairingId, correct.startLoginRequest)
        expect(() => finishOpaquePairingClient({
            code: ticket.code,
            serverId: 'another-relay',
            domain: 'relay-client',
            clientLoginState: correct.clientLoginState,
            loginResponse: correctResponse.loginResponse,
        })).toThrow('authentication failed')
    }, 15_000)
})
