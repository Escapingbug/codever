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

const CHAT_ID = parseInt(process.env.E2E_CHAT_ID ?? '', 10)
const CODEVER_BOT_TOKEN = config.getBotToken() ?? ''
const CWD = process.env.E2E_CWD ?? ''
const MODEL = process.env.E2E_MODEL ?? 'lmstudio/glm-5.1-ioa'
const QUERY_TIMEOUT_MS = 180_000
const LOG_BASE = join(homedir(), '.config', 'codever')

function requireEnv(): void {
    if (!CHAT_ID || !CODEVER_BOT_TOKEN) {
        throw new Error('E2E test environment not configured.')
    }
}

/**
 * Capture console.error output during a test.
 * Used to detect "[OutputState] Query ended without done event" which
 * is the code path that sends "⚠️ Query ended unexpectedly".
 */
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

describe('E2E: Interrupt Bug Reproduction', () => {
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

    /**
     * Bug 2: After interrupt, query ends without a 'done' NodeOutput event.
     * OutputState.onQueryCompleted() sees sawDoneEvent=false and prints
     * "[OutputState] Query ended without done event", then sends
     * "⚠️ Query ended unexpectedly" to the user.
     *
     * For intentional interrupts, this is misleading — the user already
     * knows the query was stopped (they pressed /stop or /new).
     */
    it('should reproduce "Query ended unexpectedly" after interrupt(stop)', async () => {
        const marker = `e2e_warn_${Date.now()}`

        const queryLoop = createQueryLoop({
            cwd: CWD,
            providerName: config.getDefaultProvider(),
            groupChatId: CHAT_ID,
            verboseLevel: 2,
            model: MODEL,
        })

        const provider = getProvider(config.getDefaultProvider())!
        const bridge = createTopicSession({
            queryLoop,
            provider,
            channelPort: { send: async () => {}, requestDecision: async () => ({ value: '' }), notifyStatus: () => {} },
            pipeline: createMiddlewarePipeline({ formatting: createFormattingMiddleware() }),
        })

        // Capture console.error to detect OutputState's "Query ended without done event"
        const consoleCapture = captureConsoleError()

        // Register handler that fires when query starts, then immediately interrupt
        let reachedQuerying = false
        const unsubStarted = queryLoop.bus.on('query.started', () => {
            if (queryLoop.state === 'querying') {
                reachedQuerying = true
                queryLoop.interrupt('stop').catch(() => {})
            }
        })

        bridge.receiveInput({
            text: `[${marker}] Use the Bash tool to run this exact command and nothing else: sleep 60`,
            username: 'e2e-test',
        })

        // Wait for completion
        const settled = new Promise<void>((resolve) => {
            const unsub1 = queryLoop.bus.on('query.completed', () => { unsub1(); resolve() })
            const unsub2 = queryLoop.bus.on('query.error', () => { unsub2(); resolve() })
            setTimeout(resolve, 30_000)
        })

        await settled
        await new Promise(r => setTimeout(r, 3000))

        unsubStarted()
        consoleCapture.stop()

        // Check if OutputState detected "Query ended without done event"
        const outputStateMessages = consoleCapture.getOutput().filter(l =>
            l.includes('Query ended without done event')
        )

        console.log(`[E2E warn] Reached querying: ${reachedQuerying}`)
        console.log(`[E2E warn] OutputState "Query ended without done event" count: ${outputStateMessages.length}`)
        for (const m of outputStateMessages) console.log(`  ${m.slice(0, 200)}`)

        if (reachedQuerying && outputStateMessages.length > 0) {
            console.error(`[E2E warn] *** BUG REPRODUCED: OutputState thinks query ended unexpectedly after intentional interrupt ***`)
        }

        if (reachedQuerying) {
            // THIS TEST IS EXPECTED TO FAIL until the bug is fixed
            expect(outputStateMessages.length).toBe(0)
        }

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS + 30_000)

    /**
     * Bug 1: interrupt('replace') → startQuery(nextMsg) → old startQuery
     * calls cleanupQuery() → sets _abortController = null → crash at .signal
     */
    it('should reproduce "Cannot read properties of null (reading signal)" with interrupt(replace)', async () => {
        const marker = `e2e_signal_${Date.now()}`

        const queryLoop = createQueryLoop({
            cwd: CWD,
            providerName: config.getDefaultProvider(),
            groupChatId: CHAT_ID,
            verboseLevel: 2,
            model: MODEL,
        })

        const provider = getProvider(config.getDefaultProvider())!
        const bridge = createTopicSession({
            queryLoop,
            provider,
            channelPort: { send: async () => {}, requestDecision: async () => ({ value: '' }), notifyStatus: () => {} },
            pipeline: createMiddlewarePipeline({ formatting: createFormattingMiddleware() }),
        })

        // Capture console.error to detect the crash
        const consoleCapture = captureConsoleError()

        // Start first query (long-running)
        bridge.receiveInput({
            text: `[${marker}_1] Use the Bash tool to run this exact command and nothing else: sleep 60`,
            username: 'e2e-test',
        })

        // Wait for querying state
        let reachedQuerying = false
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
            if (queryLoop.state === 'querying') {
                reachedQuerying = true
                break
            }
            await new Promise(r => setTimeout(r, 100))
        }

        if (!reachedQuerying) {
            console.log(`[E2E signal] Never reached querying state — skipping`)
            consoleCapture.stop()
            await queryLoop.destroy()
            return
        }

        // Queue a second message then call interrupt('replace')
        const secondMarker = `${marker}_2`
        queryLoop.processInput({
            text: `[${secondMarker}] Use the Bash tool to execute: echo ${secondMarker}`,
            chatId: CHAT_ID,
            username: 'e2e-test',
        })

        await queryLoop.interrupt('replace')

        // Wait for everything to settle
        const allDone = new Promise<void>((resolve) => {
            let completedCount = 0
            const unsub1 = queryLoop.bus.on('query.completed', () => {
                completedCount++
                if (completedCount >= 2) { unsub1(); resolve() }
            })
            const unsub2 = queryLoop.bus.on('query.error', () => {
                completedCount++
                if (completedCount >= 2) { unsub2(); resolve() }
            })
            setTimeout(() => { unsub1(); unsub2(); resolve() }, 120_000)
        })

        await allDone
        await new Promise(r => setTimeout(r, 5000))

        consoleCapture.stop()

        // Check for the crash in console.error output
        const crashMessages = consoleCapture.getOutput().filter(l =>
            l.includes('null') && l.includes('signal')
        )

        console.log(`[E2E signal] Reached querying: ${reachedQuerying}`)
        console.log(`[E2E signal] Crash messages: ${crashMessages.length}`)
        for (const m of crashMessages) console.log(`  ${m.slice(0, 200)}`)

        if (crashMessages.length > 0) {
            console.error(`[E2E signal] *** BUG REPRODUCED: Cannot read properties of null (reading 'signal') ***`)
        }

        // THIS TEST IS EXPECTED TO FAIL until the bug is fixed
        expect(crashMessages.length).toBe(0)

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS * 2 + 30_000)
})
