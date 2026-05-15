import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    createCancelReminderHandler,
    createScheduleReminderHandler,
    createSendFileHandler,
    createSendMessageHandler,
} from '@/mcp/tools/notify'

const existsSync = vi.fn()
const readFileSync = vi.fn()

vi.mock('node:os', () => ({ homedir: () => '/home/tester' }))
vi.mock('node:fs', () => ({
    existsSync: (...args: unknown[]) => existsSync(...args),
    readFileSync: (...args: unknown[]) => readFileSync(...args),
}))

describe('MCP notify tool integration with daemon API', () => {
    beforeEach(() => {
        existsSync.mockReturnValue(true)
        readFileSync.mockReturnValue('3737')
        process.env.CODEVER_CONVERSATION_ID = 'topic:-100:10'
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ taskId: 'task-1' }),
            text: async () => '',
        })))
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        delete process.env.CODEVER_CONVERSATION_ID
    })

    it('schedule_reminder posts a session-scoped schedule request to daemon API', async () => {
        const handler = createScheduleReminderHandler()

        const result = await handler({ delayMs: 1_000, recurringMs: 2_000, message: 'standup', context: 'test' })

        expect(result.isError).toBeUndefined()
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3737/api/schedule', expect.objectContaining({
            method: 'POST',
            body: expect.any(String),
        }))
        expect(JSON.parse((fetch as any).mock.calls[0][1].body)).toMatchObject({
            sessionId: 'topic:-100:10',
            message: 'standup',
            context: 'test',
            recurringMs: 2_000,
        })
    })

    it('send_message posts an immediate session-scoped channel message to daemon API', async () => {
        const handler = createSendMessageHandler()

        const result = await handler({ message: 'ping user now' })

        expect(result.isError).toBeUndefined()
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3737/api/send', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ sessionId: 'topic:-100:10', message: 'ping user now' }),
        }))
    })

    it('send_file posts a session-scoped file attachment request to daemon API', async () => {
        const handler = createSendFileHandler()

        const result = await handler({ path: '/repo/report.txt', caption: 'latest report' })

        expect(result.isError).toBeUndefined()
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3737/api/send-file', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                sessionId: 'topic:-100:10',
                path: '/repo/report.txt',
                caption: 'latest report',
            }),
        }))
    })

    it('cancel_reminder posts a cancel request without requiring session identity', async () => {
        delete process.env.CODEVER_CONVERSATION_ID
        const handler = createCancelReminderHandler()

        const result = await handler({ taskId: 'task-1' })

        expect(result.isError).toBeUndefined()
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3737/api/cancel', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ taskId: 'task-1' }),
        }))
    })

    it('returns a visible error when daemon API port is unavailable', async () => {
        existsSync.mockReturnValue(false)
        const handler = createSendMessageHandler()

        const result = await handler({ message: 'hello' })

        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('Daemon API not available')
        expect(fetch).not.toHaveBeenCalled()
    })

    it('returns a retryable session identity error on first-turn session-scoped calls', async () => {
        delete process.env.CODEVER_CONVERSATION_ID
        const handler = createScheduleReminderHandler()

        const result = await handler({ delayMs: 1_000, message: 'later' })

        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('Session identity not available yet')
        expect(fetch).not.toHaveBeenCalled()
    })
})
