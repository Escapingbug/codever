import { describe, expect, it } from 'vitest'
import {
    parseClientGatewayEventFrame,
    parseClientGatewayFrame,
    parseClientGatewayRequestFrame,
    parseClientGatewayResponseFrame,
} from '../src/index'

const request = (payload: unknown) => ({
    version: 1,
    type: 'client.gateway.request',
    requestId: 'request-1',
    idempotencyKey: 'idempotency-1',
    payload,
})

const timestamp = '2026-07-17T10:00:00+08:00'

const session = {
    id: 'session-1', gatewayId: 'gateway-1', projectId: 'project-1', state: 'idle', provider: 'codex',
    config: {}, createdAt: timestamp, updatedAt: timestamp, lastEventSeq: 0,
}

const project = {
    id: 'project-1', gatewayId: 'gateway-1', name: 'Codever', rootPath: '/workspace/codever',
    canonicalRoot: '/workspace/codever', defaultProvider: 'codex',
}

const event = {
    schemaVersion: 1,
    gatewayId: 'gateway-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    seq: 1,
    eventId: 'event-1',
    timestamp,
    event: { kind: 'turn_started' },
}

describe('encrypted Client to Gateway request frames', () => {
    it('parses every supported request payload', () => {
        const payloads = [
            { kind: 'inventory.get' },
            { kind: 'project.create', input: { name: 'Codever', rootPath: '/workspace/codever' } },
            { kind: 'provider.sessions.list', projectId: 'project-1', provider: 'codex' },
            { kind: 'session.create', projectId: 'project-1', input: { provider: 'codex', config: {} } },
            { kind: 'session.message', sessionId: 'session-1', input: { text: 'hello' } },
            { kind: 'session.cancel', sessionId: 'session-1', input: { reason: 'stop' } },
            { kind: 'session.archive.set', sessionId: 'session-1', archived: true },
            { kind: 'session.config.patch', sessionId: 'session-1', input: { config: {}, model: null } },
            {
                kind: 'decision.respond', sessionId: 'session-1', decisionId: 'decision-1',
                input: { value: { approved: true } },
            },
            { kind: 'events.list', sessionId: 'session-1', after: 0, limit: 100 },
            { kind: 'events.list', sessionId: 'session-1', before: 101, limit: 100 },
        ]

        for (const payload of payloads) {
            expect(parseClientGatewayRequestFrame(request(payload)).payload.kind).toBe(payload.kind)
        }
    })

    it('requires request identity and rejects invalid operation payloads', () => {
        const { requestId: _requestId, ...withoutRequestId } = request({ kind: 'inventory.get' })
        expect(() => parseClientGatewayRequestFrame(withoutRequestId)).toThrow()
        const { idempotencyKey: _idempotencyKey, ...withoutIdempotencyKey } = request({ kind: 'inventory.get' })
        expect(() => parseClientGatewayRequestFrame(withoutIdempotencyKey)).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({ kind: 'inventory.get', extra: true }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({
            kind: 'project.create', input: { name: ' ', rootPath: '/workspace/codever' },
        }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({
            kind: 'project.create', input: { name: 'Codever', rootPath: '/workspace/codever', extra: true },
        }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({
            kind: 'session.message', sessionId: 'session-1', input: { text: '' },
        }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({
            kind: 'events.list', sessionId: 'session-1', limit: 1_001,
        }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({ kind: 'session.archive.set', sessionId: 'session-1' }))).toThrow()
    })
})

describe('encrypted Gateway to Client response and event frames', () => {
    it('parses accepted, completed, and failed responses', () => {
        expect(parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-1',
            status: 'accepted', acceptedAt: timestamp,
        }).status).toBe('accepted')
        expect(parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-1',
            status: 'completed', completedAt: timestamp, payload: { session },
        }).status).toBe('completed')
        expect(parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-project',
            status: 'completed', completedAt: timestamp, payload: { project },
        }).status).toBe('completed')
        expect(parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-2',
            status: 'completed', completedAt: timestamp,
            payload: { commandId: 'command-1', status: 'completed', completedAt: timestamp },
        }).status).toBe('completed')
        expect(parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-1',
            status: 'failed', failedAt: timestamp,
            error: { code: 'offline', message: 'Gateway is offline', retryable: true },
        }).status).toBe('failed')
    })

    it('parses strict event batches and the combined frame union', () => {
        const frame = {
            version: 1,
            type: 'gateway.client.event',
            payload: { events: [event] },
        }
        expect(parseClientGatewayEventFrame(frame).payload.events).toHaveLength(1)
        expect(parseClientGatewayFrame(frame).type).toBe('gateway.client.event')
    })

    it('rejects invalid response states and malformed event batches', () => {
        expect(() => parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-1', status: 'accepted',
        })).toThrow()
        expect(() => parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-1',
            status: 'completed', completedAt: timestamp, payload: { arbitrary: true },
        })).toThrow()
        expect(() => parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-1',
            status: 'failed', failedAt: timestamp,
            error: { code: 'offline', message: 'offline', retryable: true }, payload: {},
        })).toThrow()
        expect(() => parseClientGatewayEventFrame({
            version: 1, type: 'gateway.client.event', payload: { events: [] },
        })).toThrow()
        expect(() => parseClientGatewayEventFrame({
            version: 1, type: 'gateway.client.event', payload: { events: [{ ...event, seq: 0 }] },
        })).toThrow()
    })
})
