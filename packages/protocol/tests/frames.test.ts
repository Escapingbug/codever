import { describe, expect, it } from 'vitest'
import { parseCommandLifecycleFrame, parseGatewayFrame, parseGatewayHandshakeFrame } from '../src/index'

const base = {
    version: 1,
    messageId: 'message-1',
    gatewayId: 'gateway-1',
    connectionEpoch: 'epoch-1',
} as const

describe('gateway frame discriminated union', () => {
    it('parses pre-connection authentication handshake frames', () => {
        expect(parseGatewayHandshakeFrame({
            version: 1,
            type: 'gateway.auth.response',
            messageId: 'message-auth-1',
            payload: {
                gatewayId: 'gateway-1',
                algorithm: 'ECDSA-P256-SHA256',
                fingerprint: 'sha256:abc',
                signature: 'signature',
            },
        }).type).toBe('gateway.auth.response')
    })

    it('parses inventory, heartbeat, and sync frame variants', () => {
        const heartbeat = parseGatewayFrame({
            ...base,
            type: 'gateway.heartbeat',
            payload: {
                sentAt: '2026-07-16T10:00:00.000Z',
                uptimeMs: 1000,
                inventoryRevision: 2,
                sessionStates: { 'session-1': 'querying' },
            },
        })
        const sync = parseGatewayFrame({
            ...base,
            messageId: 'message-2',
            type: 'sync.request',
            payload: { cursors: [{ sessionId: 'session-1', afterSeq: 4 }], includeInventory: true },
        })

        expect(heartbeat.type).toBe('gateway.heartbeat')
        expect(sync.type).toBe('sync.request')
        if (sync.type === 'sync.request') expect(sync.payload.cursors[0]?.afterSeq).toBe(4)
    })

    it('represents command request, accepted, result, and failed lifecycle frames', () => {
        const request = parseCommandLifecycleFrame({
            ...base,
            type: 'command.request',
            sessionId: 'session-1',
            idempotencyKey: 'idem-1',
            payload: {
                commandId: 'command-1', projectId: 'project-1', sessionId: 'session-1',
                requestedAt: '2026-07-16T10:00:00.000Z',
                command: { kind: 'session.message', text: 'Run tests' },
            },
        })
        const failed = parseCommandLifecycleFrame({
            ...base,
            messageId: 'message-2',
            type: 'command.failed',
            payload: {
                commandId: 'command-1', failedAt: '2026-07-16T10:00:01.000Z', status: 'rejected',
                error: { code: 'gateway_offline', message: 'Gateway is offline', retryable: true },
            },
        })

        expect(request.type).toBe('command.request')
        expect(failed.type).toBe('command.failed')
    })

    it('accepts Relay-routed session creation commands', () => {
        const request = parseCommandLifecycleFrame({
            ...base,
            type: 'command.request',
            sessionId: 'session-new',
            idempotencyKey: 'idem-create',
            payload: {
                commandId: 'command-create',
                projectId: 'project-1',
                sessionId: 'session-new',
                requestedAt: '2026-07-16T10:00:00.000Z',
                command: { kind: 'session.create', provider: 'codex', config: {}, title: 'New task' },
            },
        })
        expect(request.type).toBe('command.request')
        if (request.type === 'command.request') expect(request.payload.command.kind).toBe('session.create')
    })

    it('rejects unknown frame types and protocol versions', () => {
        expect(() => parseGatewayFrame({ ...base, type: 'gateway.unknown', payload: {} })).toThrow()
        expect(() => parseGatewayFrame({
            ...base, version: 2, type: 'sync.request', payload: { cursors: [], includeInventory: false },
        })).toThrow()
    })
})
