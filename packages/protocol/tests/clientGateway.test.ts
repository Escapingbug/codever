import { describe, expect, it } from 'vitest'
import {
    parseAuthorizedClientGatewayRequestFrame,
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
    it('requires a COSE/CWT authorization wrapper for transported commands', () => {
        const authorized = {
            version: 1,
            type: 'client.gateway.authorized-request',
            request: request({ kind: 'inventory.get' }),
            authorization: { format: 'cose-sign1-cwt', token: 'cose-token' },
        }
        expect(parseAuthorizedClientGatewayRequestFrame(authorized).request.payload.kind).toBe('inventory.get')
        expect(() => parseAuthorizedClientGatewayRequestFrame({
            ...authorized,
            authorization: { format: 'bearer', token: 'server-token' },
        })).toThrow()
    })

    it('parses every supported request payload', () => {
        const payloads = [
            { kind: 'inventory.get' },
            { kind: 'project.create', input: { name: 'Codever', rootPath: '/workspace/codever' } },
            { kind: 'provider.sessions.list', projectId: 'project-1', provider: 'codex' },
            { kind: 'session.create', projectId: 'project-1', input: { provider: 'codex', config: {} } },
            { kind: 'session.message', sessionId: 'session-1', input: { text: 'hello' } },
            {
                kind: 'attachment.media.import', sessionId: 'session-1', filename: 'notes.txt',
                mimeType: 'text/plain', sizeBytes: 12,
                encryptedFile: { url: 'mxc://matrix.example/media', key: { kty: 'oct' } },
            },
            { kind: 'attachment.list', sessionId: 'session-1' },
            { kind: 'attachment.delete', sessionId: 'session-1', attachmentIds: ['attachment-1'] },
            { kind: 'file.export', sessionId: 'session-1', path: '/workspace/codever/client.apk' },
            { kind: 'attachment.download', sessionId: 'session-1', attachmentId: 'attachment-1', offset: 0 },
            { kind: 'session.cancel', sessionId: 'session-1', input: { reason: 'stop' } },
            { kind: 'session.archive.set', sessionId: 'session-1', archived: true },
            { kind: 'session.rename', sessionId: 'session-1', input: { title: 'Renamed task' } },
            { kind: 'session.config.patch', sessionId: 'session-1', input: { config: {}, model: null } },
            {
                kind: 'decision.respond', sessionId: 'session-1', decisionId: 'decision-1',
                input: { value: { approved: true } },
            },
            { kind: 'events.list', sessionId: 'session-1', after: 0, limit: 100 },
            { kind: 'events.list', sessionId: 'session-1', before: 101, limit: 100 },
            {
                kind: 'execution.root.trust', ownerId: 'tablet-device', matrixDeviceId: 'TABLETDEVICE', label: 'Tablet',
                publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'key-2', x: 'x', y: 'y' },
            },
            { kind: 'execution.root.revoke', keyId: 'key-2' },
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
        expect(parseClientGatewayRequestFrame(request({
            kind: 'session.message', sessionId: 'session-1', input: { text: '', attachmentIds: ['attachment-1'] },
        })).payload.kind).toBe('session.message')
        expect(parseClientGatewayRequestFrame(request({
            kind: 'attachment.media.import', sessionId: 'session-1', filename: 'large.bin',
            mimeType: 'application/octet-stream', sizeBytes: Number.MAX_SAFE_INTEGER,
            encryptedFile: { url: 'mxc://matrix.example/large' },
        })).payload.kind).toBe('attachment.media.import')
        expect(parseClientGatewayRequestFrame(request({
            kind: 'attachment.media.import', sessionId: 'session-1', filename: 'empty.bin',
            mimeType: 'application/octet-stream', sizeBytes: 0,
            encryptedFile: { url: 'mxc://matrix.example/empty' },
        })).payload.kind).toBe('attachment.media.import')
        expect(() => parseClientGatewayRequestFrame(request({
            kind: 'attachment.media.import', sessionId: 'session-1', filename: 'unsafe.bin',
            mimeType: 'application/octet-stream', sizeBytes: Number.MAX_SAFE_INTEGER + 1,
            encryptedFile: { url: 'mxc://matrix.example/unsafe' },
        }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({
            kind: 'attachment.media.import', sessionId: 'session-1', filename: 'missing.bin',
            mimeType: 'application/octet-stream', sizeBytes: 1,
        }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({
            kind: 'events.list', sessionId: 'session-1', limit: 1_001,
        }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({ kind: 'session.archive.set', sessionId: 'session-1' }))).toThrow()
        expect(() => parseClientGatewayRequestFrame(request({
            kind: 'execution.root.trust', ownerId: 'attacker', label: 'Attacker',
            publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'key', x: 'x', y: 'y', d: 'private' },
        }))).toThrow()
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
            version: 1, type: 'gateway.client.response', requestId: 'request-download',
            status: 'completed', completedAt: timestamp,
            payload: { attachmentId: 'attachment-1', offset: 0, data: 'aGVsbG8=', nextOffset: null },
        }).status).toBe('completed')
        expect(parseClientGatewayResponseFrame({
            version: 1, type: 'gateway.client.response', requestId: 'request-attachments',
            status: 'completed', completedAt: timestamp,
            payload: {
                sessionId: 'session-1',
                attachments: [{
                    attachmentId: 'attachment-1', sessionId: 'session-1', filename: 'notes.txt',
                    mimeType: 'text/plain', sizeBytes: 5, createdAt: timestamp, status: 'ready',
                }],
            },
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
            version: 1, type: 'gateway.client.response', requestId: 'request-upload',
            status: 'completed', completedAt: timestamp,
            payload: {
                attachmentId: 'attachment-1', sessionId: 'session-1', filename: 'notes.txt',
                mimeType: 'text/plain', sizeBytes: 5, receivedBytes: 5, status: 'ready',
            },
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
