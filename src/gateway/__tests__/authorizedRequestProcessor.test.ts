import { generateExecutionKeyPair, signExecutionToken } from '@codever/execution-auth'
import { PROTOCOL_VERSION, type ClientGatewayRequestFrame, type ClientGatewayResponseFrame } from '@codever/protocol'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AuthorizedRequestProcessor, authorizedRequest } from '../authorizedRequestProcessor'
import { GatewayRequestLedger } from '../requestLedger'
import { ExecutionTrustRepository, FileExecutionReplayGuard } from '../security'

const NOW = Date.parse('2026-07-19T05:00:00.000Z')

describe('Gateway authorized request boundary', () => {
    it('executes a valid COSE/CWT command and deduplicates transport redelivery', async () => {
        const fixture = await createFixture()
        const request = command('request-1', 'command-1')
        const token = await sign(fixture.key, request)

        await expect(fixture.processor.process(authorizedRequest(request, token)))
            .resolves.toMatchObject({ status: 'completed' })
        await expect(fixture.processor.process(authorizedRequest(request, token)))
            .resolves.toMatchObject({ status: 'completed' })
        expect(fixture.handleRequest).toHaveBeenCalledTimes(1)
        expect(fixture.handleRequest).toHaveBeenCalledWith(request, 'phone-device')
    })

    it('survives Gateway restart without replaying a completed mutation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-authorized-restart-'))
        const key = await generateExecutionKeyPair()
        const trustPath = join(directory, 'trust.json')
        const replayPath = join(directory, 'replay.json')
        const ledgerPath = join(directory, 'requests.json')
        const trust = await ExecutionTrustRepository.open(trustPath, { now: () => NOW })
        await trust.trust('owner', key.publicKey)
        const request = command('request-1', 'restart-command')
        const token = await sign(key, request)
        const firstHandler = vi.fn(async () => completed(request.requestId))
        const first = new AuthorizedRequestProcessor({
            gatewayId: 'gateway-windows', trust,
            replayGuard: await FileExecutionReplayGuard.open(replayPath, { now: () => NOW }),
            requestLedger: await GatewayRequestLedger.open(ledgerPath), handleRequest: firstHandler, now: () => NOW,
        })
        await first.process(authorizedRequest(request, token))

        const restoredHandler = vi.fn(async () => completed(request.requestId))
        const restored = new AuthorizedRequestProcessor({
            gatewayId: 'gateway-windows', trust: await ExecutionTrustRepository.open(trustPath),
            replayGuard: await FileExecutionReplayGuard.open(replayPath, { now: () => NOW }),
            requestLedger: await GatewayRequestLedger.open(ledgerPath), handleRequest: restoredHandler, now: () => NOW,
        })
        await expect(restored.process(authorizedRequest(request, token))).resolves.toMatchObject({ status: 'completed' })
        expect(firstHandler).toHaveBeenCalledTimes(1)
        expect(restoredHandler).not.toHaveBeenCalled()
    })

    it('does not call business logic for a command forged by the transport', async () => {
        const fixture = await createFixture()
        const original = command('request-1', 'command-1')
        const token = await sign(fixture.key, original)
        const forged = { ...original, payload: { ...original.payload, sessionId: 'attacker-session' } } as ClientGatewayRequestFrame

        await expect(fixture.processor.process(authorizedRequest(forged, token))).resolves.toMatchObject({
            status: 'failed', error: { code: 'execution_authorization_request_mismatch' },
        })
        expect(fixture.handleRequest).not.toHaveBeenCalled()
    })

    it('rejects a validly signed command after its independent trust anchor is revoked', async () => {
        const fixture = await createFixture()
        const request = command('request-1', 'command-1')
        const token = await sign(fixture.key, request)
        await fixture.trust.revoke(fixture.key.keyId)

        await expect(fixture.processor.process(authorizedRequest(request, token))).resolves.toMatchObject({
            status: 'failed', error: { code: 'execution_authorization_unknown_key' },
        })
        expect(fixture.handleRequest).not.toHaveBeenCalled()
    })

    it('rejects reuse of one CWT token ID for a different validly signed request', async () => {
        const fixture = await createFixture()
        const first = command('request-1', 'command-1')
        const second = command('request-2', 'command-2')
        const tokenId = 'MDEyMzQ1Njc4OWFiY2RlZg'
        const firstToken = await sign(fixture.key, first, tokenId)
        const secondToken = await sign(fixture.key, second, tokenId)
        await fixture.processor.process(authorizedRequest(first, firstToken))

        await expect(fixture.processor.process(authorizedRequest(second, secondToken))).resolves.toMatchObject({
            status: 'failed', error: { code: 'execution_authorization_replay_conflict' },
        })
        expect(fixture.handleRequest).toHaveBeenCalledTimes(1)
    })
})

async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'codever-authorized-request-'))
    const key = await generateExecutionKeyPair()
    const trust = await ExecutionTrustRepository.open(join(directory, 'trust.json'), { now: () => NOW })
    await trust.trust('owner', key.publicKey)
    const handleRequest = vi.fn(async (request: ClientGatewayRequestFrame) => completed(request.requestId))
    const processor = new AuthorizedRequestProcessor({
        gatewayId: 'gateway-windows',
        trust,
        replayGuard: await FileExecutionReplayGuard.open(join(directory, 'replay.json'), { now: () => NOW }),
        requestLedger: await GatewayRequestLedger.open(join(directory, 'requests.json')),
        handleRequest,
        now: () => NOW,
    })
    return { key, trust, handleRequest, processor }
}

function command(requestId: string, idempotencyKey: string): ClientGatewayRequestFrame {
    return {
        version: PROTOCOL_VERSION,
        type: 'client.gateway.request',
        requestId,
        idempotencyKey,
        payload: { kind: 'session.cancel', sessionId: 'session-1', input: { reason: 'stop' } },
    }
}

async function sign(
    key: Awaited<ReturnType<typeof generateExecutionKeyPair>>,
    request: ClientGatewayRequestFrame,
    tokenId?: string,
): Promise<string> {
    return signExecutionToken({
        request,
        gatewayId: 'gateway-windows',
        issuer: 'codever-control:owner',
        subject: 'phone-device',
        operation: request.payload.kind,
        keyId: key.keyId,
        privateKey: key.privateKey,
        now: () => NOW,
        ...(tokenId ? { tokenId } : {}),
    })
}

function completed(requestId: string): ClientGatewayResponseFrame {
    const now = new Date(NOW).toISOString()
    return {
        version: PROTOCOL_VERSION,
        type: 'gateway.client.response',
        requestId,
        status: 'completed',
        completedAt: now,
        payload: { commandId: 'command-1', status: 'completed', acceptedAt: now, completedAt: now },
    }
}
