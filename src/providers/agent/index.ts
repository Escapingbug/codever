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
import type { ModelEntry } from '@/providers/provider'

const AGENT_ACP_COMMAND = 'agent'
const AGENT_ACP_ARGS = ['acp']
const AGENT_MODELS_ARGS = ['models']

export class AgentProvider extends AcpProvider {
    constructor() {
        super({
            name: 'agent',
            command: AGENT_ACP_COMMAND,
            args: AGENT_ACP_ARGS,
        })
    }

    getAvailableModels(): ModelEntry[] {
        try {
            const output = spawnAgentModels()
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
}

function spawnAgentModels() {
    const options: SpawnSyncOptionsWithStringEncoding = {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
    }

    if (process.platform !== 'win32') {
        return spawnSync(AGENT_ACP_COMMAND, AGENT_MODELS_ARGS, options)
    }

    // The Cursor Agent binary is installed as agent.cmd on Windows. Node cannot
    // execute .cmd shims without a shell, so mirror the ACP startup path.
    return spawnSync(`${AGENT_ACP_COMMAND} ${AGENT_MODELS_ARGS.join(' ')}`, {
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
        models.push({ id, name })
    }
    return models
}
