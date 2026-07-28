import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    CODEVER_MATRIX_EXTENSION,
    createStrictMatrixCommandAuthorizer,
    FileMatrixReplayFingerprintStore,
    InMemoryTrustedCodeverDeviceStore,
    InMemoryMatrixPinnedDeviceStore,
    InMemoryMatrixReplayFingerprintStore,
    InMemoryMatrixTransport,
    MatrixIncomingRouter,
    MatrixPort,
    MatrixRoomSessionRegistry,
    type MatrixIncomingEvent,
    type MatrixRoomSessionTarget,
} from '@/channel/matrix'
import { InMemoryReplayStore, ReplayGuard, generateDeviceKeyPair, signCommand } from '@codever/security'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('MatrixPort', () => {
    it('sends a standard m.room.message fallback with a Codever PWA extension', async () => {
        const transport = new InMemoryMatrixTransport()
        const port = createPort(transport)

        const result = await port.send({
            text: '<b>Hello</b> &amp; goodbye',
            format: 'html',
            replyMarkup: { idempotencyKey: 'turn-1:text-1', ui: { kind: 'tool_card' } },
        })

        expect(result.messageId).toBe('$memory-1')
        expect(transport.delivered).toHaveLength(1)
        expect(transport.delivered[0]).toMatchObject({
            roomId: '!room:example.org',
            eventType: 'm.room.message',
            content: {
                msgtype: 'm.text',
                body: 'Hello & goodbye',
                format: 'org.matrix.custom.html',
                formatted_body: '<b>Hello</b> &amp; goodbye',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'message',
                    operation_id: 'turn-1:text-1',
                    format: 'html',
                    ui: { kind: 'tool_card' },
                },
            },
        })
    })

    it('uses stable transaction IDs to deduplicate the same semantic operation', async () => {
        const transport = new InMemoryMatrixTransport()
        const port = createPort(transport)
        const message = {
            text: 'same operation',
            format: 'plain' as const,
            replyMarkup: { idempotencyKey: 'delivery-42' },
        }

        const first = await port.send(message)
        const second = await port.send(message)

        expect(first).toEqual(second)
        expect(transport.attempts).toHaveLength(2)
        expect(transport.attempts[0].transactionId).toBe(transport.attempts[1].transactionId)
        expect(transport.delivered).toHaveLength(1)
    })

    it('keeps retries idempotent when DeliveryOutbox reuses a message without explicit metadata', async () => {
        const transport = new InMemoryMatrixTransport()
        const port = createPort(transport)
        const message = { text: 'retry me', format: 'plain' as const }

        const first = await port.send(message)
        const retry = await port.send(message)
        const distinct = await port.send({ ...message })

        expect(first).toEqual(retry)
        expect(distinct).not.toEqual(first)
        expect(transport.attempts[0].transactionId).toBe(transport.attempts[1].transactionId)
        expect(transport.attempts[2].transactionId).not.toBe(transport.attempts[0].transactionId)
    })

    it('edits using Matrix replacement relations and stable content-based IDs', async () => {
        const transport = new InMemoryMatrixTransport()
        const port = createPort(transport)

        await port.edit('$original', { text: 'updated', format: 'markdown' })
        await port.edit('$original', { text: 'updated', format: 'markdown' })

        expect(transport.attempts[0].content).toMatchObject({
            body: '* updated',
            'm.relates_to': { rel_type: 'm.replace', event_id: '$original' },
            'm.new_content': {
                msgtype: 'm.text',
                body: 'updated',
                [CODEVER_MATRIX_EXTENSION]: {
                    kind: 'message',
                    replaces_event_id: '$original',
                },
            },
        })
        expect(transport.attempts[0].transactionId).toBe(transport.attempts[1].transactionId)
        expect(transport.delivered).toHaveLength(1)
    })

    it('publishes structured decisions with text fallback and resolves only allowed options', async () => {
        const transport = new InMemoryMatrixTransport()
        const port = createPort(transport)
        const response = port.requestDecision({
            type: 'permission',
            title: 'Allow shell?',
            details: 'npm test',
            options: [
                { label: 'Allow', value: 'allow' },
                { label: 'Deny', value: 'deny' },
            ],
        })
        await vi.waitFor(() => expect(transport.delivered).toHaveLength(1))

        const extension = transport.delivered[0].content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        expect(transport.delivered[0].content.body).toContain('[Allow] [Deny]')
        expect(extension).toMatchObject({
            kind: 'decision_request',
            decision_type: 'permission',
            title: 'Allow shell?',
        })
        const decisionId = String(extension.decision_id)
        expect(port.resolveDecision(decisionId, 'anything')).toBe(false)
        expect(port.resolveDecision(decisionId, 'allow')).toBe(true)
        await expect(response).resolves.toEqual({ value: 'allow' })
    })

    it('sends querying status and typing through the transport boundary', async () => {
        const transport = new InMemoryMatrixTransport()
        const port = createPort(transport)

        port.notifyStatus({ state: 'querying', cwd: '/repo', provider: 'codex', model: 'gpt' })
        port.sendChatAction('typing')

        await vi.waitFor(() => expect(transport.delivered).toHaveLength(1))
        await vi.waitFor(() => expect(transport.typing).toHaveLength(1))
        expect(transport.delivered[0].content.body).toContain('Provider: codex')
        expect(transport.delivered[0].content).toMatchObject({
            msgtype: 'm.notice',
            [CODEVER_MATRIX_EXTENSION]: {
                version: 1,
                kind: 'status',
                state: 'querying',
            },
        })
        expect(transport.typing[0]).toEqual({
            roomId: '!room:example.org',
            typing: true,
            timeoutMs: 30_000,
        })
    })
})

describe('MatrixIncomingRouter', () => {
    it('verifies a real Codever signature before a Matrix event can control the agent', async () => {
        const keyPair = await generateDeviceKeyPair()
        const trustedDevices = new InMemoryTrustedCodeverDeviceStore()
        trustedDevices.pin('phone-1', keyPair.keyId, keyPair.publicJwk)
        const envelope = await signCommand({
            kind: 'codever.command',
            version: 1,
            commandId: 'command-1',
            gatewayId: 'gateway-1',
            deviceId: 'phone-1',
            conversationId: '!room:example.org',
            operation: 'prompt',
            issuedAt: 1_000,
            expiresAt: 61_000,
            nonce: '0123456789abcdef',
            payload: { operation: 'prompt', text: 'run verified task' },
        }, keyPair.privateKey, keyPair.keyId)
        const sessions = new MatrixRoomSessionRegistry()
        const devices = new InMemoryMatrixPinnedDeviceStore()
        const target = createTarget()
        sessions.bind('!room:example.org', target)
        devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')
        const router = new MatrixIncomingRouter({
            sessions,
            pinnedDevices: devices,
            replayFingerprints: new InMemoryMatrixReplayFingerprintStore(),
            verifySignedCommand: createStrictMatrixCommandAuthorizer({
                gatewayId: 'gateway-1',
                trustedDevices,
                replayGuard: new ReplayGuard(new InMemoryReplayStore()),
                now: () => 2_000,
            }),
        })

        const result = await router.route(incoming({
            content: {
                msgtype: 'm.text',
                body: 'untrusted fallback',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'signed_command',
                    envelope,
                },
            },
        }))

        expect(result).toEqual({ status: 'handled', inputKind: 'user_message' })
        expect(target.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            text: 'run verified task',
            user: expect.objectContaining({ id: 'phone-1' }),
        }))
    })

    it('defaults to strict application-layer authorization', async () => {
        const fixture = createRouterFixture({}, 'strict')
        fixture.devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')

        const unsigned = await fixture.router.route(incoming())
        const signed = await fixture.router.route(incoming({
            encryptedPayloadFingerprint: 'signed-ciphertext',
            content: {
                msgtype: 'm.text',
                body: 'signed fallback',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'signed_command',
                    envelope: { opaque: 'verified by security package' },
                },
            },
        }))

        expect(unsigned).toEqual({ status: 'rejected', reason: 'unsigned-command' })
        expect(signed).toEqual({ status: 'handled', inputKind: 'user_message' })
        expect(fixture.verifySignedCommand).toHaveBeenCalledOnce()
        expect(fixture.target.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'user_message',
            text: 'verified prompt',
        }))
    })

    it('routes encrypted messages from a locally pinned device to the mapped room session', async () => {
        const fixture = createRouterFixture()
        fixture.devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')

        const result = await fixture.router.route(incoming({
            content: { msgtype: 'm.text', body: 'hello agent' },
        }))

        expect(result).toEqual({ status: 'handled', inputKind: 'user_message' })
        expect(fixture.target.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'user_message',
            text: 'hello agent',
            source: 'channel',
        }))
    })

    it.each([
        {
            name: 'clear-text event',
            patch: { encrypted: false },
            reason: 'not-encrypted',
        },
        {
            name: 'event without sender device',
            patch: { senderDeviceId: undefined },
            reason: 'missing-device',
        },
        {
            name: 'event without encrypted payload fingerprint',
            patch: { encryptedPayloadFingerprint: undefined },
            reason: 'missing-ciphertext-fingerprint',
        },
    ])('rejects $name before dispatch', async ({ patch, reason }) => {
        const fixture = createRouterFixture()
        fixture.devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')

        const result = await fixture.router.route(incoming(patch))

        expect(result).toEqual({ status: 'rejected', reason })
        expect(fixture.target.dispatch).not.toHaveBeenCalled()
    })

    it('rejects an encrypted event whose sender device is not locally pinned', async () => {
        const fixture = createRouterFixture()

        const result = await fixture.router.route(incoming())

        expect(result).toEqual({ status: 'rejected', reason: 'device-not-pinned' })
        expect(fixture.target.dispatch).not.toHaveBeenCalled()
    })

    it('rejects ciphertext replay even if the homeserver changes the event ID', async () => {
        const fixture = createRouterFixture()
        fixture.devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')

        const first = await fixture.router.route(incoming({ eventId: '$one' }))
        const replay = await fixture.router.route(incoming({ eventId: '$rewritten' }))

        expect(first.status).toBe('handled')
        expect(replay).toEqual({ status: 'rejected', reason: 'replay' })
        expect(fixture.target.dispatch).toHaveBeenCalledTimes(1)
    })

    it('keeps room-to-session targets isolated', async () => {
        const fixture = createRouterFixture()
        fixture.devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')
        const otherTarget = createTarget()
        fixture.sessions.bind('!other:example.org', otherTarget)
        fixture.devices.pin('!other:example.org', '@alice:example.org', 'ALICE1')

        await fixture.router.route(incoming({
            roomId: '!other:example.org',
            encryptedPayloadFingerprint: 'ciphertext-other',
        }))

        expect(fixture.target.dispatch).not.toHaveBeenCalled()
        expect(otherTarget.dispatch).toHaveBeenCalledOnce()
    })

    it('maps advanced PWA command and cancel events without trusting fallback text', async () => {
        const fixture = createRouterFixture()
        fixture.devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')

        await fixture.router.route(incoming({
            encryptedPayloadFingerprint: 'command-ciphertext',
            content: {
                msgtype: 'm.text',
                body: 'this fallback must not execute',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'command',
                    name: 'model',
                    args: 'gpt',
                },
            },
        }))
        await fixture.router.route(incoming({
            encryptedPayloadFingerprint: 'cancel-ciphertext',
            content: {
                msgtype: 'm.text',
                body: '/ignored',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'cancel' },
            },
        }))

        expect(fixture.target.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
            kind: 'command',
            name: 'model',
            args: 'gpt',
        }))
        expect(fixture.target.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
            kind: 'cancel',
            reason: 'user',
        }))
    })

    it('resolves a MatrixPort decision through the room target instead of dispatching it', async () => {
        const transport = new InMemoryMatrixTransport()
        const port = createPort(transport)
        const response = port.requestDecision({
            type: 'question',
            title: 'Choose',
            options: [{ label: 'A', value: 'a' }],
        })
        await vi.waitFor(() => expect(transport.delivered).toHaveLength(1))
        const extension = transport.delivered[0].content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>

        const fixture = createRouterFixture({
            resolveDecision: port.resolveDecision.bind(port),
        })
        fixture.devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')
        const result = await fixture.router.route(incoming({
            content: {
                msgtype: 'm.text',
                body: 'A',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'decision_response',
                    decision_id: extension.decision_id,
                    value: 'a',
                },
            },
        }))

        expect(result).toEqual({ status: 'handled', inputKind: 'decision_response' })
        expect(fixture.target.dispatch).not.toHaveBeenCalled()
        await expect(response).resolves.toEqual({ value: 'a' })
    })

    it('treats invalid Codever extensions as invalid instead of downgrading to fallback text', async () => {
        const fixture = createRouterFixture()
        fixture.devices.pin('!room:example.org', '@alice:example.org', 'ALICE1')

        const result = await fixture.router.route(incoming({
            content: {
                msgtype: 'm.text',
                body: 'dangerous fallback',
                [CODEVER_MATRIX_EXTENSION]: { version: 99, kind: 'user_message' },
            },
        }))

        expect(result).toEqual({ status: 'rejected', reason: 'invalid-content' })
        expect(fixture.target.dispatch).not.toHaveBeenCalled()
    })
})

describe('FileMatrixReplayFingerprintStore', () => {
    it('persists claimed fingerprints across store instances', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-matrix-replay-'))
        temporaryDirectories.push(directory)
        const filePath = join(directory, 'replay.jsonl')

        expect(await new FileMatrixReplayFingerprintStore(filePath).claim('fingerprint-1')).toBe(true)
        expect(await new FileMatrixReplayFingerprintStore(filePath).claim('fingerprint-1')).toBe(false)
    })
})

function createPort(transport: InMemoryMatrixTransport): MatrixPort {
    return new MatrixPort({
        transport,
        roomId: '!room:example.org',
        gatewayId: 'gateway-1',
    })
}

function createTarget(overrides: Partial<MatrixRoomSessionTarget> = {}): MatrixRoomSessionTarget {
    return {
        dispatch: vi.fn(async () => undefined),
        ...overrides,
    }
}

function createRouterFixture(
    targetOverrides: Partial<MatrixRoomSessionTarget> = {},
    authorizationMode: 'strict' | 'compatibility' = 'compatibility',
) {
    const sessions = new MatrixRoomSessionRegistry()
    const devices = new InMemoryMatrixPinnedDeviceStore()
    const target = createTarget(targetOverrides)
    const verifySignedCommand = vi.fn(async () => ({
        kind: 'user_message' as const,
        text: 'verified prompt',
        source: 'channel' as const,
        user: { id: '@alice:example.org' },
    }))
    sessions.bind('!room:example.org', target)
    return {
        sessions,
        devices,
        target,
        verifySignedCommand,
        router: new MatrixIncomingRouter({
            sessions,
            pinnedDevices: devices,
            replayFingerprints: new InMemoryMatrixReplayFingerprintStore(),
            authorizationMode,
            verifySignedCommand,
        }),
    }
}

function incoming(patch: Partial<MatrixIncomingEvent> = {}): MatrixIncomingEvent {
    return {
        roomId: '!room:example.org',
        eventId: '$event-1',
        eventType: 'm.room.message',
        sender: '@alice:example.org',
        senderDeviceId: 'ALICE1',
        encrypted: true,
        encryptedPayloadFingerprint: 'ciphertext-1',
        content: { msgtype: 'm.text', body: 'hello' },
        ...patch,
    }
}
