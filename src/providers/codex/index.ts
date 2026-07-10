/**
 * CodexProvider — ACP-based OpenAI Codex integration.
 *
 * Codex CLI does not expose a native ACP subcommand, so Codever launches
 * The Agent Client Protocol codex-acp adapter as a stdio ACP agent.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { AcpProvider } from '@/providers/acp'
import type { ModelEntry } from '@/providers/provider'

const CODEX_ACP_COMMAND = 'npx'
const CODEX_ACP_ARGS = ['-y', '@agentclientprotocol/codex-acp']
const CODEX_MODELS_COMMAND = 'codex'
const CODEX_MODELS_ARGS = ['debug', 'models']
const CODEX_MODEL_PROVIDER = 'openai'

export interface CodexProviderOptions {
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelsCommand?: string
    modelsArgs?: string[]
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
