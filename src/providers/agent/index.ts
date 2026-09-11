/**
 * AgentProvider — ACP-based Cursor Agent (CLI) integration.
 *
 * Uses the Agent Client Protocol to communicate with `agent acp`
 * via stdio JSON-RPC. The `agent` command is the Cursor CLI agent.
 *
 * ACP's session/cancel only stops the current turn — the session persists
 * for the next session/prompt, fixing the "new session after interrupt" bug.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { AcpProvider } from '@/providers/acp'
import type { AcpSessionConfiguration } from '@/providers/acp'
import type { AgentQueryConfig, AgentQueryInput, ModelEntry } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { PushableAsyncIterable } from '@/utils/PushableAsyncIterable'
import type { AcpExtensionHandler } from '@/providers/acp/AcpClientManager'
import { createCursorAcpExtensionHandler } from './cursorExtensions'
import { createCursorPermissionHandler } from './cursorPermissions'

const AGENT_ACP_COMMAND = 'agent'
const AGENT_ACP_ARGS = ['acp']
const AGENT_MODELS_ARGS = ['models']
const AGENT_MODEL_PROVIDER = 'cursor'

export interface AgentProviderOptions {
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelsCommand?: string
    modelsArgs?: string[]
}

export class AgentProvider extends AcpProvider {
    private readonly modelsCommand: string
    private readonly modelsArgs: string[]
    private readonly env?: Record<string, string>
    private readonly cwd?: string
    private discoveredModels: ModelEntry[] | null = null
    private sessionModelIds = new Map<string, string>()

    constructor(options: AgentProviderOptions = {}) {
        super({
            name: options.name ?? 'agent',
            command: options.command ?? AGENT_ACP_COMMAND,
            args: options.args ?? AGENT_ACP_ARGS,
            ...(options.env ? { env: options.env } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
        })
        this.modelsCommand = options.modelsCommand ?? options.command ?? AGENT_ACP_COMMAND
        this.modelsArgs = options.modelsArgs ?? AGENT_MODELS_ARGS
        this.env = options.env
        this.cwd = options.cwd
    }

    override startQuery(prompt: AgentQueryInput, config: AgentQueryConfig) {
        return super.startQuery(prompt, {
            ...config,
            permissionHandler: createCursorPermissionHandler(config.permissionHandler, config.cwd),
        })
    }

    getAvailableModels(): ModelEntry[] {
        if (this.discoveredModels) return this.discoveredModels
        try {
            const output = spawnAgentModels(this.modelsCommand, this.modelsArgs, this.env, this.cwd)
            if (output.error || output.status !== 0) {
                console.error(`[agent] Failed to list models: ${output.error?.message || `exit code ${output.status}`}`)
                return []
            }
            this.discoveredModels = parseAgentModels(output.stdout)
            return this.discoveredModels
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error(`[agent] Failed to list models: ${msg}`)
            return []
        }
    }

    override resolveModel(model: string): string | undefined {
        // Keep the user's selection intact until startQuery has the target
        // session's advertised model catalog. The exact ACP id is session-owned.
        return model
    }

    protected override captureSessionConfiguration(configuration: AcpSessionConfiguration): void {
        const advertised = configuration.models?.availableModels ?? []
        if (advertised.length === 0) return

        this.sessionModelIds = new Map()
        for (const entry of advertised) {
            const id = cursorModelMenuId(entry.modelId)
            this.sessionModelIds.set(id, entry.modelId)
            this.sessionModelIds.set(entry.name, entry.modelId)
            this.sessionModelIds.set(entry.modelId, entry.modelId)
        }
    }

    protected override resolveSessionModel(model: string, configuration: AcpSessionConfiguration | undefined): string | undefined {
        return resolveCursorSessionModel(model, configuration?.models?.availableModels ?? [])
            ?? this.sessionModelIds.get(model)
    }

    protected override requiresAdvertisedSessionModel(): boolean {
        return true
    }

    protected override createExtensionHandler(events: PushableAsyncIterable<AgentEvent>, config: AgentQueryConfig): AcpExtensionHandler | null {
        return createCursorAcpExtensionHandler(events, config)
    }
}

function mergeProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
    return env ? { ...process.env, ...env } : process.env
}

function spawnAgentModels(command: string, args: string[], env?: Record<string, string>, cwd?: string) {
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

    // The Cursor Agent binary is installed as agent.cmd on Windows. Node cannot
    // execute .cmd shims without a shell, so mirror the ACP startup path.
    return spawnSync(`${command} ${args.join(' ')}`, {
        ...options,
        shell: true,
    })
}

export function parseAgentModels(stdout: string): ModelEntry[] {
    const lines = stdout.trim().split('\n')
    const models: ModelEntry[] = []
    for (const line of lines) {
        const separatorIndex = line.indexOf(' - ')
        if (separatorIndex === -1) continue
        const id = line.slice(0, separatorIndex).trim()
        const name = line.slice(separatorIndex + 3).trim()
        if (!id || !name) continue
        models.push({ id, name, provider: AGENT_MODEL_PROVIDER })
    }
    return models
}

export function resolveCursorSessionModel(
    selectedModel: string,
    availableModels: Array<{ modelId: string; name: string }>,
): string | undefined {
    const exact = availableModels.find(model => model.modelId === selectedModel || model.name === selectedModel)
    if (exact) return exact.modelId

    const requested = parseCursorCliModelVariant(selectedModel)
    const candidates = availableModels.filter(model => model.name === requested.base || cursorModelMenuId(model.modelId) === requested.base)
    if (candidates.length === 1) return candidates[0].modelId
    if (candidates.length === 0) return undefined

    const matchingCandidates = candidates.filter(candidate => {
        if (requested.effort && !modelParameterMatches(candidate.modelId, ['effort', 'reasoning', 'reasoning_effort'], requested.effort)) return false
        if (requested.fast !== undefined && !modelParameterMatches(candidate.modelId, ['fast'], String(requested.fast))) return false
        if (requested.thinking !== undefined && !modelParameterMatches(candidate.modelId, ['thinking'], String(requested.thinking))) return false
        return true
    })
    return matchingCandidates.length === 1 ? matchingCandidates[0].modelId : undefined
}

function cursorModelBase(modelId: string): string {
    return modelId.replace(/\[.*]$/, '')
}

function cursorModelMenuId(modelId: string): string {
    const base = cursorModelBase(modelId)
    return base.startsWith('auto-') ? 'auto' : base
}

function parseCursorCliModelVariant(selectedModel: string): { base: string; effort?: string; fast?: boolean; thinking?: boolean } {
    let base = selectedModel
    let fast: boolean | undefined
    let thinking: boolean | undefined
    let effort: string | undefined

    const effortAliases: Array<[string, string]> = [
        ['-extra-high', 'xhigh'],
        ['-xhigh', 'xhigh'],
        ['-medium', 'medium'],
        ['-high', 'high'],
        ['-low', 'low'],
        ['-max', 'max'],
        ['-none', 'none'],
    ]

    let strippedSuffix = true
    while (strippedSuffix) {
        strippedSuffix = false
        if (base.endsWith('-fast')) {
            base = base.slice(0, -'-fast'.length)
            fast = true
            strippedSuffix = true
            continue
        }
        if (base.endsWith('-thinking')) {
            base = base.slice(0, -'-thinking'.length)
            thinking = true
            strippedSuffix = true
            continue
        }
        for (const [suffix, value] of effortAliases) {
            if (!base.endsWith(suffix)) continue
            base = base.slice(0, -suffix.length)
            effort = value
            strippedSuffix = true
            break
        }
    }

    return { base, ...(effort ? { effort } : {}), ...(fast !== undefined ? { fast } : {}), ...(thinking !== undefined ? { thinking } : {}) }
}

function modelParameterMatches(modelId: string, keys: string[], expected: string): boolean {
    const parameters = modelId.match(/\[(.*)]$/)?.[1]
    if (parameters === undefined) return false
    const values = new Map(parameters.split(',').flatMap(part => {
        const separator = part.indexOf('=')
        return separator > 0 ? [[part.slice(0, separator), part.slice(separator + 1)]] : []
    }))
    return keys.some(key => values.get(key) === expected)
}
