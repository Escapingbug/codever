/**
 * KimiProvider — Kimi Code CLI integration over its native ACP server.
 *
 * Kimi exposes the agent runtime through `kimi acp`. Its non-interactive
 * provider and session commands provide the catalogs used by Codever's
 * `/model` and `/sessions` controls.
 */

import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { AcpProvider } from '@/providers/acp'
import type { ModelEntry, SessionEntry } from '@/providers/provider'

const KIMI_COMMAND = 'kimi'
const KIMI_ACP_ARGS = ['acp']
const KIMI_MODELS_ARGS = ['provider', 'list', '--json']
const KIMI_PERMISSION_MODES = ['default', 'plan', 'auto', 'yolo']

export interface KimiProviderOptions {
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelsCommand?: string
    modelsArgs?: string[]
}

interface KimiModelConfig {
    provider?: unknown
    model?: unknown
    displayName?: unknown
    display_name?: unknown
    capabilities?: unknown
    supportEfforts?: unknown
    support_efforts?: unknown
    defaultEffort?: unknown
    default_effort?: unknown
    overrides?: unknown
}

interface KimiProviderCatalog {
    models?: unknown
}

interface KimiSessionSummary {
    id?: unknown
    title?: unknown
    workDir?: unknown
    cwd?: unknown
    updatedAt?: unknown
    updated?: unknown
    lastPrompt?: unknown
}

export class KimiProvider extends AcpProvider {
    private readonly command: string
    private readonly modelsCommand: string
    private readonly modelsArgs: string[]
    private readonly env?: Record<string, string>
    private readonly processCwd?: string

    constructor(options: KimiProviderOptions = {}) {
        const command = options.command ?? KIMI_COMMAND
        super({
            name: options.name ?? 'kimi',
            command,
            args: options.args ?? KIMI_ACP_ARGS,
            ...(options.env ? { env: options.env } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            reasoningConfigId: 'thinking',
            permissionModeConfigId: 'mode',
            permissionModeValues: KIMI_PERMISSION_MODES,
        })
        this.command = command
        this.modelsCommand = options.modelsCommand ?? command
        this.modelsArgs = options.modelsArgs ?? KIMI_MODELS_ARGS
        this.env = options.env
        this.processCwd = options.cwd
    }

    getAvailableModels(): ModelEntry[] {
        try {
            const output = spawnKimiModels(this.modelsCommand, this.modelsArgs, this.env, this.processCwd)
            if (output.error || output.status !== 0) {
                console.error(`[kimi] Failed to list models: ${output.error?.message || output.stderr.trim() || `exit code ${output.status}`}`)
                return []
            }
            return parseKimiModels(output.stdout)
        } catch (e) {
            console.error(`[kimi] Failed to list models: ${e instanceof Error ? e.message : String(e)}`)
            return []
        }
    }

    override getAvailablePermissionModes(): string[] {
        return [...KIMI_PERMISSION_MODES]
    }

    async listSessions(cwd: string): Promise<SessionEntry[]> {
        try {
            const output = await spawnKimiCommand(this.command, ['session', 'list', '--cwd', cwd, '--json'], {
                cwd: this.processCwd ?? cwd,
                env: this.env,
            })
            return parseKimiSessions(output)
        } catch (e) {
            console.error(`[kimi] Failed to list sessions: ${e instanceof Error ? e.message : String(e)}`)
            return []
        }
    }

    resolveModel(model: string): string | undefined {
        const normalized = model.trim()
        return normalized || undefined
    }
}

function mergeProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
    return env ? { ...process.env, ...env } : process.env
}

function spawnKimiModels(command: string, args: string[], env?: Record<string, string>, cwd?: string) {
    const options: SpawnSyncOptionsWithStringEncoding = {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
        env: mergeProcessEnv(env),
        shell: process.platform === 'win32',
        ...(cwd ? { cwd } : {}),
    }
    return spawnSync(command, args, options)
}

function spawnKimiCommand(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: process.platform === 'win32',
            env: mergeProcessEnv(options.env),
            ...(options.cwd ? { cwd: options.cwd } : {}),
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        const timer = setTimeout(() => {
            child.kill()
            reject(new Error(`${command} ${args.join(' ')} timed out`))
        }, options.timeoutMs ?? 10_000)
        timer.unref()

        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.once('close', (code) => {
            clearTimeout(timer)
            if (code === 0) {
                resolve(Buffer.concat(stdout).toString('utf-8'))
                return
            }
            const detail = Buffer.concat(stderr).toString('utf-8').trim()
            reject(new Error(`${command} ${args.join(' ')} exited with code ${code}${detail ? `: ${detail}` : ''}`))
        })
    })
}

export function parseKimiModels(stdout: string): ModelEntry[] {
    const catalog = JSON.parse(stdout) as KimiProviderCatalog
    if (!catalog.models || typeof catalog.models !== 'object' || Array.isArray(catalog.models)) return []

    const entries: ModelEntry[] = []
    for (const [alias, raw] of Object.entries(catalog.models as Record<string, unknown>)) {
        const id = alias.trim()
        if (!id || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue

        const model = raw as KimiModelConfig
        const overrides = model.overrides && typeof model.overrides === 'object' && !Array.isArray(model.overrides)
            ? model.overrides as KimiModelConfig
            : {}
        const provider = readString(model.provider)
        const name = readString(overrides.displayName)
            ?? readString(overrides.display_name)
            ?? readString(model.displayName)
            ?? readString(model.display_name)
            ?? readString(model.model)
            ?? id
        const capabilities = readStringArray(overrides.capabilities) ?? readStringArray(model.capabilities) ?? []
        const configuredEfforts = readStringArray(overrides.supportEfforts)
            ?? readStringArray(overrides.support_efforts)
            ?? readStringArray(model.supportEfforts)
            ?? readStringArray(model.support_efforts)
        const alwaysThinking = capabilities.includes('always_thinking')
        const modelId = readString(model.model)?.toLowerCase() ?? ''
        const supportsThinking = capabilities.includes('thinking')
            || alwaysThinking
            || Boolean(configuredEfforts?.length)
            || /thinking|reason/.test(modelId)
            || modelId === 'kimi-for-coding'
            || modelId === 'kimi-code'
        const enabledEfforts = configuredEfforts && configuredEfforts.length > 0 ? configuredEfforts : ['on']
        const efforts = supportsThinking
            ? Array.from(new Set([...(alwaysThinking ? [] : ['off']), ...enabledEfforts]))
            : []
        const defaultEffort = readString(overrides.defaultEffort)
            ?? readString(overrides.default_effort)
            ?? readString(model.defaultEffort)
            ?? readString(model.default_effort)
            ?? (supportsThinking ? enabledEfforts[Math.floor(enabledEfforts.length / 2)] : undefined)

        entries.push({
            id,
            name,
            ...(provider ? { provider } : {}),
            ...(defaultEffort ? { defaultReasoningLevel: defaultEffort } : {}),
            ...(efforts.length > 0 ? {
                supportedReasoningLevels: efforts.map(effort => ({ effort })),
            } : {}),
        })
    }
    return entries
}

export function parseKimiSessions(stdout: string): SessionEntry[] {
    const parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed.flatMap((raw): SessionEntry[] => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
        const session = raw as KimiSessionSummary
        const sessionId = readString(session.id)
        if (!sessionId) return []
        const title = readString(session.title) ?? readString(session.lastPrompt) ?? sessionId
        const cwd = readString(session.workDir) ?? readString(session.cwd)
        return [{
            sessionId,
            title,
            updated: readTimestamp(session.updatedAt ?? session.updated),
            ...(cwd ? { cwd } : {}),
            firstMessage: readString(session.lastPrompt) ?? '',
        }]
    })
}

function readString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed || undefined
}

function readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    return value.flatMap(item => {
        const normalized = readString(item)
        return normalized ? [normalized] : []
    })
}

function readTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const numeric = Number(value)
        if (Number.isFinite(numeric)) return numeric
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return 0
}
