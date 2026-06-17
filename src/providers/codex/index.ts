/**
 * CodexProvider — ACP-based OpenAI Codex integration.
 *
 * Codex CLI does not expose a native ACP subcommand, so Codever launches
 * Zed's codex-acp adapter as a stdio ACP agent.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { AcpProvider } from '@/providers/acp'
import type { ModelEntry } from '@/providers/provider'

const CODEX_ACP_COMMAND = 'npx'
const CODEX_ACP_ARGS = ['-y', '@zed-industries/codex-acp']
const CODEX_MODELS_COMMAND = 'codex'
const CODEX_MODELS_ARGS = ['debug', 'models']
const CODEX_MODEL_PROVIDER = 'openai'

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
    constructor() {
        super({
            name: 'codex',
            command: CODEX_ACP_COMMAND,
            args: CODEX_ACP_ARGS,
        })
    }

    getAvailableModels(): ModelEntry[] {
        try {
            const output = spawnCodexModels()
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

function spawnCodexModels() {
    const options: SpawnSyncOptionsWithStringEncoding = {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
    }

    if (process.platform !== 'win32') {
        return spawnSync(CODEX_MODELS_COMMAND, CODEX_MODELS_ARGS, options)
    }

    return spawnSync(`${CODEX_MODELS_COMMAND} ${CODEX_MODELS_ARGS.join(' ')}`, {
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
