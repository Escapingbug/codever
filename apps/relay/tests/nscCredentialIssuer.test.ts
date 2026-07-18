import { nkeys } from '@nats-io/transport-node'
import type { JetStreamManager } from '@nats-io/jetstream'
import { describe, expect, it, vi } from 'vitest'
import { NscCredentialIssuer } from '../src/nscCredentialIssuer'

const userJwt = `${'a'.repeat(40)}.${'b'.repeat(80)}.${'c'.repeat(64)}`

describe('NscCredentialIssuer', () => {
    it('signs only a client public key and provisions least-privilege durable consumers', async () => {
        const calls: string[][] = []
        const added: Array<{ stream: string; config: { durable_name?: string; filter_subject?: string } }> = []
        const manager = fakeManager(added)
        const key = nkeys.createUser()
        const seed = new TextDecoder().decode(key.getSeed())
        const publicKey = key.getPublicKey()
        const issuer = createIssuer(manager, calls)

        await expect(issuer.issueClient('client_1', publicKey)).resolves.toEqual({
            publicKey,
            userJwt,
            websocketUrl: 'wss://relay.example.test/nats',
        })

        const addUser = calls.find(args => args[0] === 'add' && args[1] === 'user')!
        expect(addUser).toContain(publicKey)
        expect(addUser.join(' ')).not.toContain(seed)
        expect(addUser).toContain('cv.v1.gateway.*.commands')
        expect(addUser).toContain('cv.v1.client.client_1.responses')
        expect(addUser).not.toContain('cv.v1.client.*.responses')
        expect(added.map(value => value.config.filter_subject)).toEqual([
            'cv.v1.client.client_1.responses',
            'cv.v1.client.client_1.events',
            'cv.v1.client.client_1.inventory.*',
            'cv.v1.gateway.*.presence',
        ])
    })

    it('gives a Gateway only its command consumer and publish-only client output routes', async () => {
        const calls: string[][] = []
        const added: Array<{ stream: string; config: { durable_name?: string; filter_subject?: string } }> = []
        const key = nkeys.createUser()
        const issuer = createIssuer(fakeManager(added), calls)

        await expect(issuer.issueGateway('gateway_1', key.getPublicKey())).resolves.toMatchObject({
            publicKey: key.getPublicKey(),
            userJwt,
            natsUrl: 'tls://relay.example.test:4222',
        })

        const addUser = calls.find(args => args[0] === 'add' && args[1] === 'user')!
        expect(addUser).toContain('cv.v1.gateway.gateway_1.commands')
        expect(addUser).toContain('cv.v1.gateway.gateway_1.pairing.requests')
        expect(addUser).toContain('cv.v1.client.*.responses')
        expect(addUser).not.toContain('cv.v1.gateway.*.commands')
        expect(addUser).toContain('$O.CV_gateway_1.>')
        expect(addUser).toContain('$JS.API.INFO')
        expect(addUser).not.toContain('$O.CV_*.>')
        expect(added).toHaveLength(1)
        expect(added[0]?.config.filter_subject).toBe('cv.v1.gateway.gateway_1.commands')
    })
})

function createIssuer(manager: JetStreamManager, calls: string[][]): NscCredentialIssuer {
    return new NscCredentialIssuer({
        storeDirectory: '/nsc/store',
        keysDirectory: '/nsc/keys',
        configDirectory: '/nsc/config',
        operator: 'CODEVER',
        account: 'APP',
        websocketUrl: 'wss://relay.example.test/nats',
        natsUrl: 'tls://relay.example.test:4222',
        jetstreamManager: manager,
        run: vi.fn(async args => {
            calls.push(args)
            return { stdout: args.includes('--raw') ? userJwt : '' }
        }),
    })
}

function fakeManager(
    added: Array<{ stream: string; config: { durable_name?: string; filter_subject?: string } }>,
): JetStreamManager {
    return {
        streams: {
            info: async () => { throw new Error('stream not found') },
            add: vi.fn(async () => ({})),
            update: vi.fn(async () => ({})),
        },
        consumers: {
            list: () => ({ async *[Symbol.asyncIterator]() { /* no existing consumers */ } }),
            add: async (stream: string, config: { durable_name?: string; filter_subject?: string }) => {
                added.push({ stream, config })
                return {} as never
            },
            update: vi.fn(),
        },
    } as unknown as JetStreamManager
}
