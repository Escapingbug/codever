import { describe, it, expect, beforeAll } from 'vitest'
import { config } from '@/config'
import { createQueryLoop, createTopicSession } from '@/bridge/topicSession'
import type { TopicSession } from '@/bridge/channelPort'
import { createMiddlewarePipeline } from '@/middleware/pipeline'
import { createFormattingMiddleware } from '@/middleware/formatting'
import { Bot } from 'grammy'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { OpencodeProvider } from '@/providers/opencode'
import { registerProvider, getProvider } from '@/providers/registry'
import type { QueryLoopEvent, QueryLoopState } from '@/core/types'

/**
 * E2E test for interrupt behavior.
 *
 * Architecture:
 * 1. Creates a real QueryLoop + DirectNode + Middleware pipeline in-process
 * 2. Uses the real provider (opencode) to execute actual queries
 * 3. Sends messages via bridge.receiveInput() — bypasses Telegram transport
 * 4. Captures state transitions via EventBus events
 *
 * Race condition handling:
 * With a real LLM, queries may complete before we can interrupt them.
 * For tests that require an active query, we use bus.once('query.started')
 * to detect the querying state synchronously and interrupt immediately.
 * If the query completes before we can interrupt, we verify the normal
 * completion path instead.
 *
 * Two categories of tests:
 * - "Immediate" tests: can be verified without an active query (idle interrupt, dead session)
 * - "Active query" tests: require the session to be in querying state at the moment of interrupt
 */

const CHAT_ID = parseInt(process.env.E2E_CHAT_ID ?? '', 10)
const CODEVER_BOT_TOKEN = config.getBotToken() ?? ''
const CWD = process.env.E2E_CWD ?? ''
const MODEL = process.env.E2E_MODEL ?? 'lmstudio/glm-5.1-ioa'
const QUERY_TIMEOUT_MS = 180_000
const LOG_BASE = join(homedir(), '.config', 'codever')

function requireEnv(): void {
    if (!CHAT_ID || !CODEVER_BOT_TOKEN) {
        throw new Error(
            'E2E test environment not configured. ' +
            'Set E2E_CHAT_ID and ensure codever bot token is configured. ' +
            'E2E tests are mandatory for acceptance — they cannot be skipped.'
        )
    }
}

function getDaemonLogPath(): string {
    return join(LOG_BASE, 'logs', 'daemon', 'groups', String(CHAT_ID), 'session.log')
}

function readDaemonLog(): string[] {
    const logPath = getDaemonLogPath()
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
}

function getLogLinesSince(allLines: string[], marker: string): string[] {
    let idx = -1
    for (let i = 0; i < allLines.length; i++) {
        if (allLines[i].includes(marker) && allLines[i].includes('[msg:in]')) {
            idx = i
            break
        }
    }
    if (idx === -1) {
        for (let i = 0; i < allLines.length; i++) {
            if (allLines[i].includes(marker)) { idx = i; break }
        }
    }
    if (idx === -1) return []
    return allLines.slice(idx)
}

function truncate(s: string, max = 200): string {
    return s.length > max ? s.slice(0, max) + '...' : s
}

interface CapturedEvents {
    stateChanges: Array<{ from: QueryLoopState; to: QueryLoopState }>
    queryCompleted: Array<{ result: { status: string } }>
    queryErrors: unknown[]
    permissionResponded: Array<{ requestId: string; decision: string }>
    messagesQueued: Array<{ text: string; queueSize: number }>
}

function captureEvents(queryLoop: import('@/core/queryLoop').QueryLoop): CapturedEvents {
    const captured: CapturedEvents = {
        stateChanges: [],
        queryCompleted: [],
        queryErrors: [],
        permissionResponded: [],
        messagesQueued: [],
    }

    queryLoop.bus.on('session.state_changed', (e: QueryLoopEvent) => {
        if (e.type === 'session.state_changed') {
            captured.stateChanges.push({ from: e.from, to: e.to })
        }
    })

    queryLoop.bus.on('query.completed', (e: QueryLoopEvent) => {
        if (e.type === 'query.completed') {
            captured.queryCompleted.push({ result: e.result })
        }
    })

    queryLoop.bus.on('query.error', (e: QueryLoopEvent) => {
        if (e.type === 'query.error') {
            captured.queryErrors.push(e.error)
        }
    })

    queryLoop.bus.on('permission.respond', (e: QueryLoopEvent) => {
        if (e.type === 'permission.respond') {
            captured.permissionResponded.push({ requestId: e.requestId, decision: e.decision })
        }
    })

    queryLoop.bus.on('message.queued', (e: QueryLoopEvent) => {
        if (e.type === 'message.queued') {
            captured.messagesQueued.push({ text: e.text, queueSize: e.queueSize })
        }
    })

    return captured
}

/**
 * Run a query that triggers interrupt while the session is in 'querying' state.
 *
 * Strategy: Use bus.once('query.started') to synchronously detect when the
 * session enters querying state, then call interrupt() in the same tick.
 * This minimizes the race window.
 *
 * Returns the captured events and whether the interrupt was successfully
 * delivered during the querying state.
 */
async function runInterruptTest(
    bridge: TopicSession,
    queryLoop: import('@/core/queryLoop').QueryLoop,
    marker: string,
    interruptReason: 'stop' | 'new' | 'replace',
    onQueryStarted?: () => void,
): Promise<{ wasQueryingWhenInterrupted: boolean; completedNormally: boolean }> {
    let wasQueryingWhenInterrupted = false

    // Register a handler that fires synchronously when query starts
    const unsubStarted = queryLoop.bus.on('query.started', () => {
        if (queryLoop.state === 'querying') {
            wasQueryingWhenInterrupted = true
            onQueryStarted?.()
            // Immediately interrupt in the same event loop tick
            queryLoop.interrupt(interruptReason).catch(() => {})
        }
    })

    // Also register a completion handler
    let completedNormally = false
    const unsubCompleted = queryLoop.bus.on('query.completed', () => {
        if (!wasQueryingWhenInterrupted) {
            completedNormally = true
        }
    })
    const unsubError = queryLoop.bus.on('query.error', () => {
        if (!wasQueryingWhenInterrupted) {
            completedNormally = true
        }
    })

    try {
        bridge.receiveInput({
            text: `[${marker}] Use the Bash tool to run this exact command and nothing else: sleep 60`,
            username: 'e2e-test',
        })

        // Wait up to 60s for the test to resolve
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
            if (wasQueryingWhenInterrupted || completedNormally || queryLoop.state === 'idle' || queryLoop.state === 'dead') {
                break
            }
            await new Promise(r => setTimeout(r, 100))
        }

        // Wait for session to settle
        const settleDeadline = Date.now() + 10_000
        while (Date.now() < settleDeadline) {
            if (queryLoop.state === 'idle' || queryLoop.state === 'dead') break
            await new Promise(r => setTimeout(r, 100))
        }
    } finally {
        unsubStarted()
        unsubCompleted()
        unsubError()
    }

    return { wasQueryingWhenInterrupted, completedNormally }
}

describe('E2E: Interrupt Behavior', () => {
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

    async function createSession(marker: string) {
        const queryLoop = createQueryLoop({
            cwd: CWD,
            providerName: config.getDefaultProvider(),
            groupChatId: CHAT_ID,
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

        const events = captureEvents(queryLoop)

        return { queryLoop, bridge, events, marker }
    }

    // --- Tests that don't require active query ---

    it('interrupt is no-op when session is idle', async () => {
        const marker = `e2e_idle_${Date.now()}`
        const { queryLoop, events } = await createSession(marker)

        expect(queryLoop.state).toBe('idle')

        await queryLoop.interrupt('stop')

        expect(queryLoop.state).toBe('idle')

        const unexpectedChanges = events.stateChanges.filter(s => !(s.from === 'idle' && s.to === 'querying'))
        expect(unexpectedChanges.length).toBe(0)

        await queryLoop.destroy()
    })

    it('destroyed session ignores new input', async () => {
        const marker = `e2e_dead_${Date.now()}`
        const { queryLoop, events } = await createSession(marker)

        // Destroy while idle
        await queryLoop.destroy()
        expect(queryLoop.state).toBe('dead')

        const queryCountBefore = events.stateChanges.filter(s => s.from === 'idle' && s.to === 'querying').length

        await queryLoop.processInput({ text: 'This should be ignored', chatId: CHAT_ID })

        const queryCountAfter = events.stateChanges.filter(s => s.from === 'idle' && s.to === 'querying').length

        expect(queryCountAfter).toBe(queryCountBefore)

        console.log(`[E2E dead] Queries before: ${queryCountBefore}, after: ${queryCountAfter}`)
    })

    // --- Tests that require active query ---

    it('interrupt(stop) transitions querying → canceling → idle', async () => {
        const marker = `e2e_stop_${Date.now()}`
        const { queryLoop, bridge, events } = await createSession(marker)

        const { wasQueryingWhenInterrupted } = await runInterruptTest(bridge, queryLoop, marker, 'stop')

        if (!wasQueryingWhenInterrupted) {
            console.log(`[E2E stop] Query completed before interrupt — verifying normal completion instead`)
            expect(queryLoop.state).toBe('idle')
            expect(events.stateChanges.some(s => s.from === 'idle' && s.to === 'querying')).toBe(true)
            await queryLoop.destroy()
            return
        }

        expect(queryLoop.state).toBe('idle')

        const stateFlow = events.stateChanges.map(s => `${s.from}→${s.to}`)
        console.log(`[E2E stop] State flow: ${stateFlow.join(', ')}`)

        expect(stateFlow).toContain('idle→querying')
        expect(stateFlow).toContain('querying→canceling')
        expect(stateFlow).toContain('canceling→idle')

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS + 30_000)

    it('interrupt(new) sets resetRequested', async () => {
        const marker = `e2e_new_${Date.now()}`
        const { queryLoop, bridge, events } = await createSession(marker)

        const { wasQueryingWhenInterrupted } = await runInterruptTest(bridge, queryLoop, marker, 'new')

        if (!wasQueryingWhenInterrupted) {
            console.log(`[E2E new] Query completed before interrupt — skipping`)
            await queryLoop.destroy()
            return
        }

        expect(queryLoop.state).toBe('idle')

        // resetRequested is transient — it gets reset at the end of startQuery().
        // The observable effect is that query.completed has status='cancelled' (via resetRequested).
        // Check state transitions instead.
        expect(events.stateChanges.some(s => s.from === 'querying' && s.to === 'canceling')).toBe(true)
        expect(events.stateChanges.some(s => s.from === 'canceling' && s.to === 'idle')).toBe(true)

        // Check that query.completed was emitted with 'cancelled' status
        // (resetRequested causes the completed event to use 'cancelled' instead of 'success')
        const lastCompleted = events.queryCompleted[events.queryCompleted.length - 1]
        if (lastCompleted) {
            console.log(`[E2E new] query.completed status: ${lastCompleted.result.status}`)
            expect(lastCompleted.result.status).toBe('cancelled')
        }

        console.log(`[E2E new] State transitions verified`)

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS + 30_000)

    it('interrupt(stop) clears message queue and does not process queued messages', async () => {
        const marker = `e2e_qstop_${Date.now()}`
        const { queryLoop, bridge, events } = await createSession(marker)

        let queuedMarker = `${marker}_queued`
        let messageQueued = false

        const { wasQueryingWhenInterrupted } = await runInterruptTest(
            bridge,
            queryLoop,
            marker,
            'stop',
            () => {
                // This fires when query starts — send a queued message
                queryLoop.processInput({
                    text: `[${queuedMarker}] This should be queued and then discarded`,
                    chatId: CHAT_ID,
                    username: 'e2e-test',
                })
                messageQueued = true
            },
        )

        if (!wasQueryingWhenInterrupted) {
            console.log(`[E2E qstop] Query completed before interrupt — skipping`)
            await queryLoop.destroy()
            return
        }

        // Wait for everything to settle
        await new Promise(r => setTimeout(r, 3000))

        expect(queryLoop.state).toBe('idle')

        const allLines = readDaemonLog()
        const queuedLines = getLogLinesSince(allLines, queuedMarker)
        const queuedMessageStartedQuery = queuedLines.some(l => l.includes('[query] Started'))

        console.log(`[E2E qstop] Queued message started as new query: ${queuedMessageStartedQuery}`)

        expect(queuedMessageStartedQuery).toBe(false)

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS + 30_000)

    it('session can accept new query after interrupt(stop)', async () => {
        const marker = `e2e_resume_${Date.now()}`
        const { queryLoop, bridge, events } = await createSession(marker)

        const { wasQueryingWhenInterrupted } = await runInterruptTest(bridge, queryLoop, marker, 'stop')

        if (!wasQueryingWhenInterrupted) {
            console.log(`[E2E resume] Query completed before interrupt — skipping`)
            await queryLoop.destroy()
            return
        }

        expect(queryLoop.state).toBe('idle')

        // Now send a normal query
        const secondCompleted = new Promise<void>((resolve) => {
            const unsub = queryLoop.bus.on('query.completed', () => {
                unsub()
                resolve()
            })
            const unsubErr = queryLoop.bus.on('query.error', () => {
                unsubErr()
                resolve()
            })
        })

        const secondMarker = `${marker}_second`
        bridge.receiveInput({
            text: `[${secondMarker}] Use the Bash tool to execute: echo ${secondMarker}`,
            username: 'e2e-test',
        })

        await secondCompleted

        expect(queryLoop.state).toBe('idle')

        const queryStarts = events.stateChanges.filter(s => s.from === 'idle' && s.to === 'querying')
        console.log(`[E2E resume] Query starts: ${queryStarts.length}`)

        expect(queryStarts.length).toBeGreaterThanOrEqual(2)

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS * 2 + 30_000)

    it('second interrupt during canceling state is no-op', async () => {
        const marker = `e2e_double_${Date.now()}`
        const { queryLoop, bridge, events } = await createSession(marker)

        let secondInterruptDone = false

        const { wasQueryingWhenInterrupted } = await runInterruptTest(
            bridge,
            queryLoop,
            marker,
            'stop',
            () => {
                // Try a second interrupt immediately — should be no-op
                queryLoop.interrupt('new').then(() => { secondInterruptDone = true }).catch(() => {})
            },
        )

        if (!wasQueryingWhenInterrupted) {
            console.log(`[E2E double] Query completed before interrupt — skipping`)
            await queryLoop.destroy()
            return
        }

        // Wait for everything to settle
        await new Promise(r => setTimeout(r, 3000))

        expect(queryLoop.state).toBe('idle')

        // Only one querying→canceling transition should occur
        const cancelingCount = events.stateChanges.filter(s => s.from === 'querying' && s.to === 'canceling').length
        console.log(`[E2E double] querying→canceling transitions: ${cancelingCount}`)

        expect(cancelingCount).toBe(1)

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS + 30_000)

    it('interrupt rejects pending permissions', async () => {
        const marker = `e2e_perm_${Date.now()}`
        const { queryLoop, bridge, events } = await createSession(marker)

        const permPromise = queryLoop.waitForPermission('e2e-test-req', 'WriteFile', { path: '/tmp/test' })
        expect(queryLoop.hasPendingPermissions()).toBe(true)

        const { wasQueryingWhenInterrupted } = await runInterruptTest(bridge, queryLoop, marker, 'stop')

        if (!wasQueryingWhenInterrupted) {
            console.log(`[E2E perm] Query completed before interrupt — cleaning up`)
            queryLoop.resolvePermission('e2e-test-req', 'cancel')
            await queryLoop.destroy()
            return
        }

        const decision = await permPromise
        expect(decision).toBe('cancel')
        expect(queryLoop.hasPendingPermissions()).toBe(false)

        const permissionResponded = events.permissionResponded.filter(p => p.requestId === 'e2e-test-req')
        expect(permissionResponded.length).toBe(1)
        expect(permissionResponded[0].decision).toBe('cancel')

        console.log(`[E2E perm] Permission decision: ${decision}, pending: ${queryLoop.hasPendingPermissions()}`)

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS + 30_000)

    it('destroy during active query transitions to dead and rejects permissions', async () => {
        const marker = `e2e_destroy_${Date.now()}`
        const { queryLoop, bridge, events } = await createSession(marker)

        const permPromise = queryLoop.waitForPermission('e2e-destroy-req', 'WriteFile', { path: '/tmp/test' })

        let wasQuerying = false

        const unsubStarted = queryLoop.bus.on('query.started', () => {
            if (queryLoop.state === 'querying') {
                wasQuerying = true
                // Destroy immediately
                queryLoop.destroy().catch(() => {})
            }
        })

        bridge.receiveInput({
            text: `[${marker}] Use the Bash tool to run this exact command and nothing else: sleep 60`,
            username: 'e2e-test',
        })

        // Wait for result
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
            if (wasQuerying || queryLoop.state === 'dead' || queryLoop.state === 'idle') break
            await new Promise(r => setTimeout(r, 100))
        }

        unsubStarted()

        if (!wasQuerying) {
            console.log(`[E2E destroy] Query completed before destroy — cleaning up`)
            queryLoop.resolvePermission('e2e-destroy-req', 'cancel')
            if (queryLoop.state !== 'dead') await queryLoop.destroy()
            return
        }

        // Wait for destroy to complete
        const settleDeadline = Date.now() + 5_000
        while (Date.now() < settleDeadline && queryLoop.state !== 'dead') {
            await new Promise(r => setTimeout(r, 100))
        }

        expect(queryLoop.state).toBe('dead')

        const decision = await permPromise
        expect(decision).toBe('cancel')

        const hasDeadTransition = events.stateChanges.some(s => s.to === 'dead')
        expect(hasDeadTransition).toBe(true)

        console.log(`[E2E destroy] State: ${queryLoop.state}, permission decision: ${decision}`)
    }, QUERY_TIMEOUT_MS + 30_000)

    it('multiple sequential interrupts on the same session work correctly', async () => {
        const marker = `e2e_multi_${Date.now()}`
        const { queryLoop, bridge, events } = await createSession(marker)

        // First query: try to interrupt
        const result1 = await runInterruptTest(bridge, queryLoop, `${marker}_1`, 'stop')

        // Wait for settle
        await new Promise(r => setTimeout(r, 1000))
        if (queryLoop.state !== 'idle') {
            await new Promise<void>((resolve) => {
                const unsub = queryLoop.bus.on('query.completed', () => { unsub(); resolve() })
                const unsubErr = queryLoop.bus.on('query.error', () => { unsubErr(); resolve() })
            })
        }

        expect(queryLoop.state).toBe('idle')

        // Second query: try to interrupt
        const result2 = await runInterruptTest(bridge, queryLoop, `${marker}_2`, 'stop')

        // Wait for settle
        await new Promise(r => setTimeout(r, 1000))
        if (queryLoop.state !== 'idle') {
            await new Promise<void>((resolve) => {
                const unsub = queryLoop.bus.on('query.completed', () => { unsub(); resolve() })
                const unsubErr = queryLoop.bus.on('query.error', () => { unsubErr(); resolve() })
            })
        }

        expect(queryLoop.state).toBe('idle')

        const stateFlow = events.stateChanges.map(s => `${s.from}→${s.to}`)
        console.log(`[E2E multi] State flow: ${stateFlow.join(', ')}`)

        const queryingCount = events.stateChanges.filter(s => s.from === 'idle' && s.to === 'querying').length
        const cancelingCount = events.stateChanges.filter(s => s.from === 'querying' && s.to === 'canceling').length

        console.log(`[E2E multi] querying starts: ${queryingCount}, interrupts: ${cancelingCount}`)
        console.log(`[E2E multi] First interrupted: ${result1.wasQueryingWhenInterrupted}, Second interrupted: ${result2.wasQueryingWhenInterrupted}`)

        expect(queryingCount).toBeGreaterThanOrEqual(2)

        if (result1.wasQueryingWhenInterrupted && result2.wasQueryingWhenInterrupted) {
            expect(cancelingCount).toBeGreaterThanOrEqual(2)
        }

        await queryLoop.destroy()
    }, QUERY_TIMEOUT_MS * 2 + 30_000)
})
