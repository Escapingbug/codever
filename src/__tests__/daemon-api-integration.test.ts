import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDaemonApi, type DaemonApi } from '@/daemon/api'

describe('Daemon API integration boundary', () => {
    let api: DaemonApi | undefined
    const onSchedule = vi.fn()
    const onCancel = vi.fn()
    const onSend = vi.fn()
    const onSendFile = vi.fn()
    const onDeliveryStatus = vi.fn()

    beforeEach(async () => {
        vi.clearAllMocks()
        onSchedule.mockReturnValue({ taskId: 'task-1' })
        onSendFile.mockResolvedValue({ status: 'queued', deliveryId: 'delivery-1' })
        onDeliveryStatus.mockReturnValue({ deliveries: [] })
        api = await startDaemonApi({ onSchedule, onCancel, onSend, onSendFile, onDeliveryStatus })
    })

    afterEach(() => {
        api?.stop()
        api = undefined
        vi.restoreAllMocks()
    })

    function url(path: string): string {
        if (!api) throw new Error('Daemon API was not started')
        return `http://127.0.0.1:${api.port}${path}`
    }

    it('POST /api/schedule validates and forwards schedule requests', async () => {
        const res = await fetch(url('/api/schedule'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: 'topic:-100:10',
                triggerAt: 1_800_000_000_000,
                message: 'check progress',
                context: 'test',
                recurringMs: 60_000,
            }),
        })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ taskId: 'task-1' })
        expect(onSchedule).toHaveBeenCalledWith({
            sessionId: 'topic:-100:10',
            triggerAt: 1_800_000_000_000,
            message: 'check progress',
            context: 'test',
            recurringMs: 60_000,
        })
    })

    it('POST /api/send validates and forwards immediate session messages', async () => {
        const res = await fetch(url('/api/send'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'topic:-100:10', message: 'wake up' }),
        })

        expect(res.status).toBe(200)
        expect(onSend).toHaveBeenCalledWith({ sessionId: 'topic:-100:10', message: 'wake up' })
    })

    it('POST /api/send-file validates and forwards immediate session file render requests', async () => {
        const res = await fetch(url('/api/send-file'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: 'topic:-100:10',
                path: '/repo/report.md',
                caption: 'latest report',
                type: 'markdown',
            }),
        })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, result: { status: 'queued', deliveryId: 'delivery-1' } })
        expect(onSendFile).toHaveBeenCalledWith({
            sessionId: 'topic:-100:10',
            path: '/repo/report.md',
            caption: 'latest report',
            type: 'markdown',
        })
    })

    it('POST /api/delivery-status validates and forwards delivery status requests', async () => {
        onDeliveryStatus.mockReturnValueOnce({
            deliveries: [{
                id: 'delivery-1',
                kind: 'send',
                status: 'pending',
                createdAt: 1,
                textChars: 12,
                attachments: [{ type: 'document', path: '/repo/report.md', filename: 'report.md' }],
            }],
        })

        const res = await fetch(url('/api/delivery-status'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'topic:-100:10', deliveryId: 'delivery-1' }),
        })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            deliveries: [{
                id: 'delivery-1',
                kind: 'send',
                status: 'pending',
                createdAt: 1,
                textChars: 12,
                attachments: [{ type: 'document', path: '/repo/report.md', filename: 'report.md' }],
            }],
        })
        expect(onDeliveryStatus).toHaveBeenCalledWith({ sessionId: 'topic:-100:10', deliveryId: 'delivery-1' })
    })

    it('POST /api/cancel validates and forwards cancel requests', async () => {
        const res = await fetch(url('/api/cancel'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: 'task-1' }),
        })

        expect(res.status).toBe(200)
        expect(onCancel).toHaveBeenCalledWith({ taskId: 'task-1' })
    })

    it('rejects incomplete schedule requests without calling handlers', async () => {
        const res = await fetch(url('/api/schedule'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'topic:-100:10', message: 'missing trigger' }),
        })

        expect(res.status).toBe(400)
        expect(onSchedule).not.toHaveBeenCalled()
    })

    it('returns a visible 500 response when a daemon handler fails', async () => {
        onSend.mockImplementationOnce(() => {
            throw new Error('session lookup failed')
        })

        const res = await fetch(url('/api/send'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'missing-session', message: 'wake up' }),
        })

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({ error: 'session lookup failed' })
    })
})
