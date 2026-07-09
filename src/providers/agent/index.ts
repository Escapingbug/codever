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
        try {
            const output = spawnAgentModels(this.modelsCommand, this.modelsArgs, this.env, this.cwd)
            if (output.error || output.status !== 0) {
                console.error(`[agent] Failed to list models: ${output.error?.message || `exit code ${output.status}`}`)
                return []
            }
            return parseAgentModels(output.stdout)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error(`[agent] Failed to list models: ${msg}`)
            return []
        }
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
