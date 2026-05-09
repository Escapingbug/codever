import { describe, it, expect, beforeAll } from 'vitest'
import { config } from '@/config'
import { createQueryLoop, createTopicSession } from '@/bridge/topicSession'
import type { TopicSession } from '@/bridge/channelPort'
import { createMiddlewarePipeline } from '@/middleware/pipeline'
import { createFormattingMiddleware } from '@/middleware/formatting'
import { Bot } from 'grammy'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { OpencodeProvider } from '@/providers/opencode'
import { registerProvider, getProvider } from '@/providers/registry'
import type { QueryLoopEvent } from '@/core/types'

/**
 * E2E test to reproduce: provider crash → no recovery.
 *
 * After OpenCode (Bun) crashes, AcpProvider.initialized=true but
 * connected=false. init() has `if (this.initialized) return` guard,
 * so it never re-initializes. All subsequent messages get
 * "❌ Provider not available" forever.
 *
 * Strategy: simulate the crash by calling clientManager.close() on
 * the provider, which sets connected=false (same state as a crash).
 * Then send a message and verify the provider recovers.
 */

const CHAT_ID = parseInt(process.env.E2E_CHAT_ID ?? '', 10)
const CODEVER_BOT_TOKEN = config.getBotToken() ?? ''
const CWD = process.env.E2E_CWD ?? ''
const MODEL = process.env.E2E_MODEL ?? 'lmstudio/glm-5.1-ioa'
const QUERY_TIMEOUT_MS = 180_000
const LOG_BASE = join(homedir(), '.config', 'codever')
// Use a different chatId to avoid log pollution with other e2e tests
const CRASH_CHAT_ID = CHAT_ID - 1

function requireEnv(): void {
    if (!CHAT_ID || !CODEVER_BOT_TOKEN) {
        throw new Error('E2E test environment not configured.')
    }
}

function captureConsoleError(): { getOutput: () => string[]; stop: () => void } {
    const original = console.error
    const output: string[] = []
    console.error = (...args: unknown[]) => {
        output.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' '))
        original.apply(console, args)
    }
    return {
        getOutput: () => output,
        stop: () => { console.error = original },
    }
}

describe('E2E: Provider Crash Recovery', () => {
    let bot: Bot

    beforeAll(async () => {
        requireEnv()

        const provider = new OpencodeProvider()
        registerProvider(provider)
        if ('init' in provider && typeof (provider as any).init === 'function') {
            await (provider as any).init()
        }

        bot = new Bot(CODEVER_BOT_TOKEN)
        await bot.api.getMe()
    }, 30_000)

    it('should reproduce: after provider crash, subsequent messages fail permanently', async () => {
        const marker = `e2e_crash_${Date.now()}`

        // First, verify provider works normally
        const queryLoop = createQueryLoop({
            cwd: CWD,
            providerName: config.getDefaultProvider(),
            groupChatId: CRASH_CHAT_ID,
            verboseLevel: 1,
            model: MODEL,
        })

        const provider = getProvider(config.getDefaultProvider())!
        const bridge = createTopicSession({
            queryLoop,
            provider,
            channelPort: { send: async () => {}, requestDecision: async () => ({ value: '' }), notifyStatus: () => {} },
            pipeline: createMiddlewarePipeline({ formatting: createFormattingMiddleware() }),
        })

        // Send a normal query to confirm it works
        const firstCompleted = new Promise<void>((resolve) => {
            const unsub1 = queryLoop.bus.on('query.completed', () => { unsub1(); resolve() })
            const unsub2 = queryLoop.bus.on('query.error', () => { unsub2(); resolve() })
        })

        bridge.receiveInput({
            text: `[${marker}_pre] Use the Bash tool to execute: echo working`,
            username: 'e2e-test',
        })

        await firstCompleted
        console.log(`[E2E crash] Pre-crash query completed successfully`)

        // Now simulate the crash: close the provider's client manager
        // This puts the provider in the same state as a Bun crash:
        // initialized=true, connected=false
        const crashProvider = getProvider(config.getDefaultProvider()) as any
        expect(crashProvider.isReady()).toBe(true)

        // Access the internal clientManager and close it
        if (crashProvider.clientManager && typeof crashProvider.clientManager.close === 'function') {
            await crashProvider.clientManager.close()
        }

        console.log(`[E2E crash] Provider state after simulated crash: isReady=${crashProvider.isReady()}, initialized=${crashProvider.initialized}`)

        // Verify the broken state: initialized=true but not ready
        expect(crashProvider.isReady()).toBe(false)

        // Now send a message — this should recover, not fail permanently
        const consoleCapture = captureConsoleError()

        const secondCompleted = new Promise<string>((resolve) => {
            const unsub1 = queryLoop.bus.on('query.completed', () => { unsub1(); resolve('completed') })
            const unsub2 = queryLoop.bus.on('query.error', () => { unsub2(); resolve('error') })
            // If nothing happens within 30s, the message was silently dropped
            setTimeout(() => resolve('timeout'), 30_000)
        })

        const secondMarker = `${marker}_post`
        bridge.receiveInput({
            text: `[${secondMarker}] Use the Bash tool to execute: echo ${secondMarker}`,
            username: 'e2e-test',
        })

        const result = await secondCompleted

        consoleCapture.stop()

        // Check for "Provider not available" in console output
        const providerNotAvailable = consoleCapture.getOutput().some(l =>
            l.includes('not available') || l.includes('Provider')
        )

        console.log(`[E2E crash] Post-crash query result: ${result}`)
        console.log(`[E2E crash] Provider not available error: ${providerNotAvailable}`)
        console.log(`[E2E crash] Provider isReady after attempt: ${crashProvider.isReady()}`)

        if (result === 'timeout') {
            console.error(`[E2E crash] *** BUG REPRODUCED: message silently dropped after provider crash ***`)
        }
        if (result !== 'completed') {
            console.error(`[E2E crash] *** BUG REPRODUCED: provider did not recover after crash, result=${result} ***`)
        }

        // The test expects recovery — should complete, not timeout or error
        expect(result).toBe('completed')

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS + 60_000)

    it('should preserve session context after provider recovery', async () => {
        const marker = `e2e_session_${Date.now()}`

        const queryLoop = createQueryLoop({
            cwd: CWD,
            providerName: config.getDefaultProvider(),
            groupChatId: CRASH_CHAT_ID,
            verboseLevel: 1,
            model: MODEL,
        })

        const provider = getProvider(config.getDefaultProvider())!
        const bridge = createTopicSession({
            queryLoop,
            provider,
            channelPort: { send: async () => {}, requestDecision: async () => ({ value: '' }), notifyStatus: () => {} },
            pipeline: createMiddlewarePipeline({ formatting: createFormattingMiddleware() }),
        })

        // First query to establish a session
        const firstCompleted = new Promise<void>((resolve) => {
            const unsub1 = queryLoop.bus.on('query.completed', () => { unsub1(); resolve() })
            const unsub2 = queryLoop.bus.on('query.error', () => { unsub2(); resolve() })
        })

        bridge.receiveInput({
            text: `[${marker}_1] Use the Bash tool to execute: echo session_established`,
            username: 'e2e-test',
        })

        await firstCompleted

        const sessionIdBefore = queryLoop.conversationId
        console.log(`[E2E session] Session ID before crash: ${sessionIdBefore}`)

        // Simulate crash
        const crashProvider = getProvider(config.getDefaultProvider()) as any
        if (crashProvider.clientManager && typeof crashProvider.clientManager.close === 'function') {
            await crashProvider.clientManager.close()
        }

        // Send another message — after recovery, conversationId should be preserved
        const secondCompleted = new Promise<string>((resolve) => {
            const unsub1 = queryLoop.bus.on('query.completed', () => { unsub1(); resolve('completed') })
            const unsub2 = queryLoop.bus.on('query.error', () => { unsub2(); resolve('error') })
            setTimeout(() => resolve('timeout'), 60_000)
        })

        bridge.receiveInput({
            text: `[${marker}_2] Use the Bash tool to execute: echo after_recovery`,
            username: 'e2e-test',
        })

        const result = await secondCompleted

        const sessionIdAfter = queryLoop.conversationId
        console.log(`[E2E session] Session ID after recovery: ${sessionIdAfter}`)
        console.log(`[E2E session] Post-crash result: ${result}`)

        // Session should be preserved (OpenCode persists sessions to disk)
        expect(result).toBe('completed')
        if (sessionIdBefore) {
            expect(sessionIdAfter).toBe(sessionIdBefore)
            console.log(`[E2E session] Session preserved across crash recovery`)
        }

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS * 2 + 60_000)
})
