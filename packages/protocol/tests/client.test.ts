import { describe, expect, it } from 'vitest'
import { parseMutationReceiptDto, parseSendMessageDto } from '../src/index'

describe('client resource DTO schemas', () => {
    it('parses mutation requests and lifecycle receipts', () => {
        expect(parseSendMessageDto({ text: 'hello', sendWhenOnline: true })).toEqual({
            text: 'hello', sendWhenOnline: true,
        })
        expect(parseMutationReceiptDto({
            commandId: 'command-1', status: 'gateway_accepted', acceptedAt: '2026-07-16T10:00:00.000Z',
        }).status).toBe('gateway_accepted')
    })

    it('rejects non-JSON decision payloads', () => {
        expect(() => parseSendMessageDto({ text: '' })).toThrow()
    })
})
