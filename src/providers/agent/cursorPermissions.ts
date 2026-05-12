import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { homedir } from 'node:os'
import type { AgentPermissionHandler, AgentPermissionResult } from '@/providers/provider'

interface CursorCliConfig {
    approvalMode?: string
    permissions?: {
        allow?: string[]
        deny?: string[]
    }
}

export function createCursorPermissionHandler(
    fallback: AgentPermissionHandler | undefined,
    cwd: string,
): AgentPermissionHandler | undefined {
    if (!fallback) return undefined

    return {
        async handleToolCall(toolName, input, options): Promise<AgentPermissionResult> {
            const config = readCursorCliConfig(cwd)
            const decision = resolveCursorPermission(toolName, input, config)
            if (decision) return decision
            return fallback.handleToolCall(toolName, input, options)
        },
        onEvent(event) {
            fallback.onEvent?.(event)
        },
        reset() {
            fallback.reset()
        },
    }
}

function resolveCursorPermission(toolName: string, input: unknown, config: CursorCliConfig): AgentPermissionResult | null {
    const deny = config.permissions?.deny ?? []
    if (deny.some(pattern => matchesPermissionPattern(pattern, toolName, input))) {
        return { behavior: 'deny', permanent: true }
    }

    if (config.approvalMode === 'unrestricted') {
        return { behavior: 'allow', permanent: true }
    }

    const allow = config.permissions?.allow ?? []
    if (allow.some(pattern => matchesPermissionPattern(pattern, toolName, input))) {
        return { behavior: 'allow', permanent: true }
    }

    return null
}

function readCursorCliConfig(cwd: string): CursorCliConfig {
    return mergeCursorCliConfigs([
        readJsonFile(join(getCursorHome(), '.cursor', 'cli-config.json')),
        ...readProjectCursorCliConfigs(cwd),
    ])
}

function getCursorHome(): string {
    return process.env.USERPROFILE || process.env.HOME || homedir()
}

function readProjectCursorCliConfigs(cwd: string): CursorCliConfig[] {
    const configs: CursorCliConfig[] = []
    let current = cwd
    const root = parse(current).root

    while (true) {
        const config = readJsonFile(join(current, '.cursor', 'cli.json'))
        if (config) configs.unshift(config)
        if (current === root) break
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }

    return configs
}

function readJsonFile(path: string): CursorCliConfig | null {
    try {
        if (!existsSync(path)) return null
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        return isRecord(parsed) ? parsed as CursorCliConfig : null
    } catch {
        return null
    }
}

function mergeCursorCliConfigs(configs: Array<CursorCliConfig | null>): CursorCliConfig {
    const merged: CursorCliConfig = {}
    for (const config of configs) {
        if (!config) continue
        if (config.approvalMode !== undefined) merged.approvalMode = config.approvalMode
        if (config.permissions) {
            merged.permissions = {
                allow: config.permissions.allow ?? merged.permissions?.allow,
                deny: config.permissions.deny ?? merged.permissions?.deny,
            }
        }
    }
    return merged
}

function matchesPermissionPattern(pattern: string, toolName: string, input: unknown): boolean {
    const trimmed = pattern.trim()
    if (!trimmed || trimmed === '**') return trimmed === '**'

    const callPattern = trimmed.match(/^([A-Za-z0-9_-]+)\((.*)\)$/)
    if (!callPattern) return normalizeToolName(trimmed) === normalizeToolName(toolName)

    const [, patternToolName, argumentPattern] = callPattern
    if (normalizeToolName(patternToolName) !== normalizeToolName(toolName)) return false
    if (argumentPattern === '**' || argumentPattern === '*') return true

    const inputText = typeof input === 'string' ? input : JSON.stringify(input)
    return inputText.includes(argumentPattern)
}

function normalizeToolName(toolName: string): string {
    return toolName.replace(/[_-]/g, '').toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
