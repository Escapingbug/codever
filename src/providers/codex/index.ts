/**
 * CodexProvider — ACP-based OpenAI Codex integration.
 *
 * Codex CLI does not expose a native ACP subcommand, so Codever launches
 * The Agent Client Protocol codex-acp adapter as a stdio ACP agent.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import { AcpProvider } from '@/providers/acp'
import type { ModelEntry, SessionEntry } from '@/providers/provider'

const CODEX_ACP_COMMAND = 'npx'
const CODEX_ACP_ARGS = ['-y', '@agentclientprotocol/codex-acp']
const CODEX_MODELS_COMMAND = 'codex'
const CODEX_MODELS_ARGS = ['debug', 'models']
const CODEX_MODEL_PROVIDER = 'openai'
const SESSION_READ_BATCH_SIZE = 8

export interface CodexProviderOptions {
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelsCommand?: string
    modelsArgs?: string[]
    codexHome?: string
}

interface CodexModelCatalog {
    models?: Array<{
        slug?: unknown
        display_name?: unknown
        name?: unknown
        visibility?: unknown
        default_reasoning_level?: unknown
        supported_reasoning_levels?: unknown
    }>
}

export class CodexProvider extends AcpProvider {
    private readonly modelsCommand: string
    private readonly modelsArgs: string[]
    private readonly env?: Record<string, string>
    private readonly cwd?: string
    private readonly codexHome: string

    constructor(options: CodexProviderOptions = {}) {
        super({
            name: options.name ?? 'codex',
            command: options.command ?? CODEX_ACP_COMMAND,
            args: options.args ?? CODEX_ACP_ARGS,
            ...(options.env ? { env: options.env } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
        })
        this.modelsCommand = options.modelsCommand ?? CODEX_MODELS_COMMAND
        this.modelsArgs = options.modelsArgs ?? CODEX_MODELS_ARGS
        this.env = options.env
        this.cwd = options.cwd
        this.codexHome = options.codexHome
            ?? options.env?.CODEX_HOME
            ?? process.env.CODEX_HOME
            ?? path.join(homedir(), '.codex')
    }

    async listSessions(cwd: string): Promise<SessionEntry[]> {
        try {
            const sessionsDir = path.join(this.codexHome, 'sessions')
            const files = await findRolloutFiles(sessionsDir)
            const sessions: Array<SessionEntry | null> = []
            for (let start = 0; start < files.length; start += SESSION_READ_BATCH_SIZE) {
                sessions.push(...await Promise.all(
                    files.slice(start, start + SESSION_READ_BATCH_SIZE).map(file => readCodexSession(file)),
                ))
            }
            const normalizedCwd = normalizeCwd(cwd)

            const matching = sessions
                .filter((session): session is SessionEntry => session !== null)
                .filter(session => !cwd || normalizeCwd(session.cwd ?? '') === normalizedCwd)
            const latestBySessionId = new Map<string, SessionEntry>()
            for (const session of matching) {
                const existing = latestBySessionId.get(session.sessionId)
                if (!existing || session.updated > existing.updated) latestBySessionId.set(session.sessionId, session)
            }
            return [...latestBySessionId.values()].sort((a, b) => b.updated - a.updated)
        } catch (e) {
            const error = e as NodeJS.ErrnoException
            if (error?.code !== 'ENOENT') {
                console.error(`[codex] Failed to list sessions: ${e instanceof Error ? e.message : String(e)}`)
            }
            return []
        }
    }

    async getSessionFirstMessage(sessionId: string): Promise<string> {
        try {
            const files = await findRolloutFiles(path.join(this.codexHome, 'sessions'))
            for (const file of files) {
                if (!path.basename(file).includes(sessionId)) continue
                const session = await readCodexSession(file)
                if (session?.sessionId === sessionId) return session.firstMessage ?? ''
            }
        } catch (e) {
            const error = e as NodeJS.ErrnoException
            if (error?.code !== 'ENOENT') {
                console.error(`[codex] Failed to get first message: ${e instanceof Error ? e.message : String(e)}`)
            }
        }
        return ''
    }

    getAvailableModels(): ModelEntry[] {
        try {
            const output = spawnCodexModels(this.modelsCommand, this.modelsArgs, this.env, this.cwd)
            if (output.error || output.status !== 0) {
                console.error(`[codex] Failed to list models: ${output.error?.message || `exit code ${output.status}`}`)
                return []
            }
            return parseCodexModels(output.stdout)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error(`[codex] Failed to list models: ${msg}`)
            return []
        }
    }
}

interface CodexSessionMeta {
    id?: unknown
    session_id?: unknown
    cwd?: unknown
    timestamp?: unknown
}

interface CodexRolloutLine {
    type?: unknown
    timestamp?: unknown
    payload?: Record<string, unknown>
}

async function findRolloutFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) return findRolloutFiles(fullPath)
        return entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')
            ? [fullPath]
            : []
    }))
    return nested.flat()
}

async function readCodexSession(file: string): Promise<SessionEntry | null> {
    let metadata: CodexSessionMeta | undefined
    let firstMessage = ''
    let fallbackMessage = ''
    const input = createReadStream(file, { encoding: 'utf-8' })
    const lines = createInterface({
        input,
        crlfDelay: Infinity,
    })

    try {
        for await (const line of lines) {
            let record: CodexRolloutLine
            try {
                record = JSON.parse(line) as CodexRolloutLine
            } catch {
                continue
            }

            if (record.type === 'session_meta' && record.payload) {
                metadata = record.payload as CodexSessionMeta
            } else {
                const eventMessage = extractUserEventMessage(record)
                if (eventMessage) firstMessage = eventMessage
                else if (fallbackMessage) firstMessage = fallbackMessage
                else fallbackMessage = extractResponseUserMessage(record)
            }
            if (metadata && firstMessage) break
        }
    } finally {
        lines.close()
        input.destroy()
        await finished(input).catch(() => undefined)
    }

    if (!metadata) return null
    firstMessage ||= fallbackMessage
    const rolloutId = stringValue(metadata.id)
    const sessionId = stringValue(metadata.session_id) || rolloutId
    const cwd = stringValue(metadata.cwd)
    if (!sessionId || !cwd) return null
    if (rolloutId && rolloutId !== sessionId) return null

    const fileStat = await stat(file)
    const metadataTime = Date.parse(stringValue(metadata.timestamp))
    const updated = Math.max(fileStat.mtimeMs, Number.isFinite(metadataTime) ? metadataTime : 0)
    return {
        sessionId,
        title: makeSessionTitle(firstMessage),
        updated,
        cwd,
        firstMessage,
    }
}

function extractUserEventMessage(record: CodexRolloutLine): string {
    if (record.type !== 'event_msg' || record.payload?.type !== 'user_message') return ''
    return stringValue(record.payload.message)
}

function extractResponseUserMessage(record: CodexRolloutLine): string {
    if (record.type !== 'response_item' || record.payload?.role !== 'user') return ''
    const content = record.payload.content
    if (!Array.isArray(content)) return ''
    return content
        .map((part) => {
            if (!part || typeof part !== 'object') return ''
            const item = part as Record<string, unknown>
            return item.type === 'input_text' ? stringValue(item.text) : ''
        })
        .filter(text => text && !isInjectedContext(text))
        .join('\n')
        .trim()
}

function isInjectedContext(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('<recommended_plugins>')
        || trimmed.startsWith('# AGENTS.md instructions for ')
        || trimmed.startsWith('<environment_context>')
}

function makeSessionTitle(message: string): string {
    const title = message.replace(/\s+/g, ' ').trim()
    if (!title) return 'Untitled session'
    return title.length > 80 ? `${title.slice(0, 77)}...` : title
}

function normalizeCwd(cwd: string): string {
    const normalized = path.resolve(cwd).replace(/\\/g, '/')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function mergeProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
    return env ? { ...process.env, ...env } : process.env
}

function spawnCodexModels(command: string, args: string[], env?: Record<string, string>, cwd?: string) {
    const options: SpawnSyncOptionsWithStringEncoding = {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
        env: mergeProcessEnv(env),
        ...(cwd ? { cwd } : {}),
    }

    if (process.platform !== 'win32') {
        return spawnSync(command, args, options)
    }

    return spawnSync(`${command} ${args.join(' ')}`, {
        ...options,
        shell: true,
    })
}

export function parseCodexModels(stdout: string): ModelEntry[] {
    const catalog = JSON.parse(stdout) as CodexModelCatalog
    const models = Array.isArray(catalog.models) ? catalog.models : []
    const entries: ModelEntry[] = []

    for (const model of models) {
        if (model.visibility !== undefined && model.visibility !== 'list') continue
        const id = typeof model.slug === 'string' ? model.slug.trim() : ''
        if (!id) continue
        const name = typeof model.display_name === 'string'
            ? model.display_name.trim()
            : typeof model.name === 'string'
                ? model.name.trim()
                : id
        entries.push({
            id,
            name: name || id,
            provider: CODEX_MODEL_PROVIDER,
            ...parseReasoningMetadata(model),
        })
    }

    return entries
}

function parseReasoningMetadata(model: { default_reasoning_level?: unknown; supported_reasoning_levels?: unknown }): Pick<ModelEntry, 'defaultReasoningLevel' | 'supportedReasoningLevels'> {
    const defaultReasoningLevel = typeof model.default_reasoning_level === 'string'
        ? model.default_reasoning_level.trim()
        : ''
    const supported = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .map((entry) => {
                if (!entry || typeof entry !== 'object') return null
                const record = entry as Record<string, unknown>
                const effort = typeof record.effort === 'string' ? record.effort.trim() : ''
                if (!effort) return null
                const description = typeof record.description === 'string' && record.description.trim()
                    ? record.description.trim()
                    : undefined
                return { effort, ...(description ? { description } : {}) }
            })
            .filter((entry): entry is { effort: string; description?: string } => entry !== null)
        : []

    return {
        ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
        ...(supported.length > 0 ? { supportedReasoningLevels: supported } : {}),
    }
}
