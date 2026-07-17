import { describe, expect, it } from 'vitest'
import {
    RELAY_BLOB_CHUNK_BYTES,
    parseGatewayBlobRequestFrame,
    parseGatewayFrame,
    parseRelayBlobResponseFrame,
} from '../src/index'

const base = {
    version: 1,
    messageId: 'message-1',
    gatewayId: 'gateway-1',
    connectionEpoch: 'epoch-1',
} as const

describe('Relay Blob protocol', () => {
    it('strictly parses every request operation without a total-size application limit', () => {
        const frames = [
            { ...base, type: 'gateway.blob.begin', payload: { requestId: 'r1', blobId: 'blob_1', totalSize: Number.MAX_SAFE_INTEGER, chunkSize: RELAY_BLOB_CHUNK_BYTES } },
            { ...base, type: 'gateway.blob.put-chunk', payload: { requestId: 'r2', blobId: 'blob_1', index: 0, opaqueChunk: 'AA' } },
            { ...base, type: 'gateway.blob.complete', payload: { requestId: 'r3', blobId: 'blob_1' } },
            { ...base, type: 'gateway.blob.manifest', payload: { requestId: 'r4', blobId: 'blob_1' } },
            { ...base, type: 'gateway.blob.get-chunk', payload: { requestId: 'r5', blobId: 'blob_1', index: 0 } },
            { ...base, type: 'gateway.blob.delete', payload: { requestId: 'r6', blobId: 'blob_1' } },
        ]
        for (const frame of frames) {
            expect(parseGatewayBlobRequestFrame(frame).type).toBe(frame.type)
            expect(parseGatewayFrame(frame).type).toBe(frame.type)
        }
    })

    it('rejects unsafe ids, unsafe sizes, oversized chunks, and extra fields', () => {
        expect(() => parseGatewayBlobRequestFrame({
            ...base, type: 'gateway.blob.begin', payload: { requestId: 'r1', blobId: '../escape', totalSize: 0, chunkSize: 1 },
        })).toThrow()
        expect(() => parseGatewayBlobRequestFrame({
            ...base, type: 'gateway.blob.begin', payload: { requestId: 'r1', blobId: 'blob', totalSize: Number.MAX_SAFE_INTEGER + 1, chunkSize: 1 },
        })).toThrow()
        expect(() => parseGatewayBlobRequestFrame({
            ...base, type: 'gateway.blob.begin', payload: { requestId: 'r1', blobId: 'blob', totalSize: 1, chunkSize: RELAY_BLOB_CHUNK_BYTES + 1 },
        })).toThrow()
        expect(() => parseGatewayBlobRequestFrame({
            ...base, type: 'gateway.blob.delete', payload: { requestId: 'r1', blobId: 'blob', extra: true },
        })).toThrow()
    })

    it('parses strict succeeded and failed responses', () => {
        const manifest = { blobId: 'blob', totalSize: 0, chunkSize: 1, chunkCount: 0, receivedChunkCount: 0, complete: true }
        expect(parseRelayBlobResponseFrame({
            ...base, type: 'relay.blob.response',
            payload: { requestId: 'r1', operation: 'complete', status: 'succeeded', manifest },
        }).payload.status).toBe('succeeded')
        expect(parseRelayBlobResponseFrame({
            ...base, type: 'relay.blob.response',
            payload: { requestId: 'r2', operation: 'complete', status: 'failed', code: 'incomplete', message: 'Missing chunk' },
        }).payload.status).toBe('failed')
        expect(() => parseRelayBlobResponseFrame({
            ...base, type: 'relay.blob.response',
            payload: { requestId: 'r2', operation: 'complete', status: 'failed', code: 'incomplete', message: 'Missing chunk', manifest },
        })).toThrow()
    })
})
