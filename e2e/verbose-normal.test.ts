import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

/**
 * E2E test for verbose level behavior.
 *
 * How it works:
 * 1. Creates a real QueryLoop + DirectNode + Middleware pipeline in-process
 * 2. Uses the real provider (opencode) to execute actual queries
 * 3. Sends messages via bridge.receiveInput() — bypasses Telegram transport
 * 4. Captures rendered output via daemon group log [msg:out] entries
 *
 * This tests the full pipeline: Provider → DirectNode → QueryLoop → Middleware
 * → FormattingMiddleware (agentFormatter with verboseLevel) → Renderer → log
 *
 * The only thing bypassed is Telegram message delivery — the formatting and
 * verbose filtering logic is exercised exactly as in production.
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
    // Find the [msg:in] line that contains the marker (the trigger message)
    // Fall back to any line containing the marker
    let idx = -1
    for (let i = 0; i < allLines.length; i++) {
        if (allLines[i].includes(marker) && allLines[i].includes('[msg:in]')) {
            idx = i
            break
        }
    }
    if (idx === -1) {
        // Fallback: find first occurrence of marker in any line
        for (let i = 0; i < allLines.length; i++) {
            if (allLines[i].includes(marker)) { idx = i; break }
        }
    }
    if (idx === -1) return []
    return allLines.slice(idx)
}

function getOutgoingMessages(lines: string[]): string[] {
    return lines.filter(l => l.includes('[msg:out]')).map(l => {
        const match = l.match(/\[msg:out\] (.+)$/)
        return match ? match[1] : ''
    }).filter(Boolean)
}

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
}

function truncate(s: string, max = 200): string {
    return s.length > max ? s.slice(0, max) + '...' : s
}

async function waitForDaemonLog(
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
    startMarker: string,
): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const allLines = readDaemonLog()
        const lines = getLogLinesSince(allLines, startMarker)
        if (predicate(lines)) return lines
        await new Promise(r => setTimeout(r, 2000))
    }
    const allLines = readDaemonLog()
    const lines = getLogLinesSince(allLines, startMarker)
    throw new Error(
        `Timeout after ${timeoutMs}ms waiting for daemon log condition. ` +
        `Lines since marker: ${lines.length}. ` +
        `Last 5: ${lines.slice(-5).map(l => truncate(l, 100)).join(' | ')}`
    )
}

function queryCompleted(lines: string[]): boolean {
    return lines.some(l => l.includes('[query] Completed'))
}

describe('E2E: Verbose Normal Mode', () => {
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

    async function runQuery(verboseLevel: 0 | 1 | 2, marker: string): Promise<string[]> {
        const queryLoop = createQueryLoop({
            cwd: CWD,
            providerName: config.getDefaultProvider(),
            groupChatId: CHAT_ID,
            verboseLevel,
            model: MODEL,
        })

        const provider = getProvider(config.getDefaultProvider())!
        const bridge = createTopicSession({
            queryLoop,
            provider,
            channelPort: { send: async () => {}, requestDecision: async () => ({ value: '' }), notifyStatus: () => {} },
            pipeline: createMiddlewarePipeline({ formatting: createFormattingMiddleware() }),
        })

        // Wait for query to complete
        const completed = new Promise<void>((resolve) => {
            queryLoop.bus.on('query.completed', () => resolve())
            queryLoop.bus.on('query.error', () => resolve())
        })

        bridge.receiveInput({
            text: `[${marker}] Use the Bash tool to execute: echo ${marker}`,
            username: 'e2e-test',
        })

        await completed

        // Give logs a moment to flush
        await new Promise(r => setTimeout(r, 3000))

        const allLines = readDaemonLog()
        const lines = getLogLinesSince(allLines, marker)
        const outgoing = getOutgoingMessages(lines)

        console.log(`[E2E debug] marker=${marker}`)
        console.log(`[E2E debug] total log lines=${allLines.length}, lines since marker=${lines.length}`)
        console.log(`[E2E debug] outgoing count=${outgoing.length}`)
        if (lines.length > 0) {
            console.log(`[E2E debug] first 10 lines since marker:`)
            for (const l of lines.slice(0, 10)) console.log(`  ${truncate(l, 150)}`)
        }

        await queryLoop.destroy()

        return outgoing
    }

    it('should show Bash command but NOT show command output when verbose=normal (level 1)', async () => {
        const marker = `e2e_normal_${Date.now()}`
        const outgoing = await runQuery(1, marker)

        console.log('[E2E normal] Outgoing messages:')
        for (const msg of outgoing) console.log(`  ${truncate(msg, 150)}`)

        const hasBashCommand = outgoing.some(m => m.includes('💻') || m.includes('$ echo'))
        expect(hasBashCommand).toBe(true)

        const hasBashOutput = outgoing.some(m => {
            const stripped = stripHtml(m)
            return stripped.includes(marker) && !stripped.includes('$ echo') && !stripped.includes('💻')
        })

        if (hasBashOutput) {
            console.error('[E2E FAIL] Found Bash output in normal mode (should be hidden):')
            for (const m of outgoing.filter(m => stripHtml(m).includes(marker)))
                console.error(`  ${truncate(m, 200)}`)
        }

        expect(hasBashOutput).toBe(false)
    }, QUERY_TIMEOUT_MS + 30_000)

    it('should show both Bash command AND output when verbose=verbose (level 2)', async () => {
        const marker = `e2e_verbose_${Date.now()}`
        const outgoing = await runQuery(2, marker)

        console.log('[E2E verbose] Outgoing messages:')
        for (const msg of outgoing) console.log(`  ${truncate(msg, 150)}`)

        const hasBashCommand = outgoing.some(m => m.includes('💻') || m.includes('$ echo'))
        expect(hasBashCommand).toBe(true)

        const hasBashOutput = outgoing.some(m => stripHtml(m).includes(marker) && !m.includes('$ echo'))
        expect(hasBashOutput).toBe(true)
    }, QUERY_TIMEOUT_MS + 30_000)

    it('should hide both Bash command and output when verbose=quiet (level 0)', async () => {
        const marker = `e2e_quiet_${Date.now()}`
        const outgoing = await runQuery(0, marker)

        console.log('[E2E quiet] Outgoing messages:')
        for (const msg of outgoing) console.log(`  ${truncate(msg, 150)}`)

        const hasBashCommand = outgoing.some(m => m.includes('💻') || m.includes('$ echo'))
        expect(hasBashCommand).toBe(false)

        const hasBashOutput = outgoing.some(m => stripHtml(m).includes(marker))
        expect(hasBashOutput).toBe(false)
    }, QUERY_TIMEOUT_MS + 30_000)
})
