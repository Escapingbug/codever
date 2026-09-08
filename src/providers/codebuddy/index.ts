/**
 * CodebuddyProvider — ACP-based Codebuddy integration.
 *
 * Uses the Agent Client Protocol to communicate with `codebuddy --acp`
 * via stdio JSON-RPC. This replaces the previous @tencent-ai/agent-sdk
 * approach, gaining ACP's explicit session lifecycle guarantees.
 *
 * ACP's session/cancel only stops the current turn — the session persists
 * for the next session/prompt, fixing the "new session after interrupt" bug.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { AcpProvider } from '@/providers/acp'
import type { ModelEntry } from '@/providers/provider'
import {
    addCodebuddyAnswersToPermissionResponse,
    resolveCodebuddyPermissionToolName,
} from './askUserQuestion'

const CODEBUDDY_ACP_COMMAND = 'codebuddy'
const CODEBUDDY_ACP_ARGS = ['--acp']
const CODEBUDDY_MODELS_ARGS = ['--help']
const CODEBUDDY_MODEL_PROVIDER = 'codebuddy'

export interface CodebuddyProviderOptions {
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelsCommand?: string
    modelsArgs?: string[]
}

export class CodebuddyProvider extends AcpProvider {
    private readonly modelsCommand: string
    private readonly modelsArgs: string[]
    private readonly env?: Record<string, string>
    private readonly cwd?: string

    constructor(options: CodebuddyProviderOptions = {}) {
        super({
            name: options.name ?? 'codebuddy',
            command: options.command ?? CODEBUDDY_ACP_COMMAND,
            args: options.args ?? CODEBUDDY_ACP_ARGS,
            ...(options.env ? { env: options.env } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            resolvePermissionToolName: resolveCodebuddyPermissionToolName,
            mapPermissionResponse: addCodebuddyAnswersToPermissionResponse,
        })
        this.modelsCommand = options.modelsCommand ?? options.command ?? CODEBUDDY_ACP_COMMAND
        this.modelsArgs = options.modelsArgs ?? CODEBUDDY_MODELS_ARGS
        this.env = options.env
        this.cwd = options.cwd
    }

    getAvailableModels(): ModelEntry[] {
        try {
            const output = spawnCodebuddyHelp(this.modelsCommand, this.modelsArgs, this.env, this.cwd)
            if (output.error || output.status !== 0) {
                console.error(`[codebuddy] Failed to list models: ${output.error?.message || `exit code ${output.status}`}`)
                return []
            }
            return parseCodebuddyModels(output.stdout)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[codebuddy] Failed to list models: ${message}`)
            return []
        }
    }
}

function mergeProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
    return env ? { ...process.env, ...env } : process.env
}

function spawnCodebuddyHelp(command: string, args: string[], env?: Record<string, string>, cwd?: string) {
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

export function parseCodebuddyModels(helpText: string): ModelEntry[] {
    const supportedModels = helpText.match(/Currently supported:\s*\(([^)]*)\)/s)?.[1]
    if (!supportedModels) return []

    return supportedModels
        .split(',')
        .map(model => model.trim())
        .filter(Boolean)
        .map(id => ({ id, name: id, provider: CODEBUDDY_MODEL_PROVIDER }))
}
