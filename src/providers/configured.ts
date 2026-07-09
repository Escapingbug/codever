import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDaemonBaseDir } from '@/config'
import { AcpProvider } from '@/providers/acp'
import type { AgentProvider } from '@/providers/provider'
import { AgentProvider as CursorAgentProvider } from '@/providers/agent'
import { CodebuddyProvider } from '@/providers/codebuddy'
import { CodexProvider } from '@/providers/codex'
import { OpencodeProvider } from '@/providers/opencode'
import { registerProvider } from './registry'

export type ProviderProfileType = 'opencode' | 'codebuddy' | 'agent' | 'codex' | 'acp'

export interface ProviderProfile {
    id: string
    type: ProviderProfileType
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelProviders?: string[]
    modelsCommand?: string
    modelsArgs?: string[]
}

export interface ProviderProfilesFile {
    defaultProvider?: string
    providers?: ProviderProfile[]
}

export interface LoadedProviderProfiles {
    path: string
    exists: boolean
    defaultProvider?: string
    providers: ProviderProfile[]
}

export interface RegisteredProviderProfiles {
    path: string
    exists: boolean
    defaultProvider?: string
    providers: ProviderProfile[]
}

const BUILTIN_PROVIDER_PROFILES: ProviderProfile[] = [
    { id: 'opencode', type: 'opencode' },
    { id: 'codebuddy', type: 'codebuddy' },
    { id: 'agent', type: 'agent' },
    { id: 'codex', type: 'codex' },
]

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/

export function getProviderProfilesPath(): string {
    return join(getDaemonBaseDir(), 'providers.json')
}

export function loadProviderProfiles(path: string = getProviderProfilesPath()): LoadedProviderProfiles {
    if (!existsSync(path)) {
        return {
            path,
            exists: false,
            providers: [...BUILTIN_PROVIDER_PROFILES],
        }
    }

    const parsed = parseProviderProfilesFile(readFileSync(path, 'utf-8'), path)
    const providers = resolveProviderProfiles(parsed)
    if (parsed.defaultProvider && !providers.some(profile => profile.id === parsed.defaultProvider)) {
        throw new Error(`Invalid provider profile config ${path}: defaultProvider "${parsed.defaultProvider}" does not match a configured provider`)
    }
    return {
        path,
        exists: true,
        defaultProvider: parsed.defaultProvider,
        providers,
    }
}

export function parseProviderProfilesFile(content: string, source = 'providers.json'): ProviderProfilesFile {
    let raw: unknown
    try {
        raw = JSON.parse(content)
    } catch (error) {
        throw new Error(`Invalid provider profile config ${source}: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`Invalid provider profile config ${source}: root must be an object`)
    }

    const record = raw as Record<string, unknown>
    const defaultProvider = readOptionalString(record, 'defaultProvider', source)
    if (defaultProvider !== undefined) validateProfileId(defaultProvider, `${source}.defaultProvider`)

    const providersRaw = record.providers
    if (providersRaw !== undefined && !Array.isArray(providersRaw)) {
        throw new Error(`Invalid provider profile config ${source}: providers must be an array`)
    }

    const providers = (providersRaw ?? []).map((entry, index) => parseProviderProfile(entry, `${source}.providers[${index}]`))
    const seen = new Set<string>()
    for (const provider of providers) {
        if (seen.has(provider.id)) {
            throw new Error(`Invalid provider profile config ${source}: duplicate provider id "${provider.id}"`)
        }
        seen.add(provider.id)
    }

    return {
        ...(defaultProvider ? { defaultProvider } : {}),
        providers,
    }
}

export function resolveProviderProfiles(file: ProviderProfilesFile = {}): ProviderProfile[] {
    const profiles = new Map(BUILTIN_PROVIDER_PROFILES.map(profile => [profile.id, profile]))
    for (const profile of file.providers ?? []) {
        profiles.set(profile.id, profile)
    }
    return Array.from(profiles.values())
}

export function registerConfiguredProviders(path: string = getProviderProfilesPath()): RegisteredProviderProfiles {
    const loaded = loadProviderProfiles(path)
    for (const profile of loaded.providers) {
        registerProvider(createProviderFromProfile(profile), () => createProviderFromProfile(profile), { type: profile.type })
    }
    return loaded
}

export function createProviderFromProfile(profile: ProviderProfile): AgentProvider {
    switch (profile.type) {
        case 'opencode':
            return new OpencodeProvider({
                name: profile.id,
                command: profile.command,
                args: profile.args,
                env: profile.env,
                cwd: profile.cwd,
                modelProviders: profile.modelProviders,
            })
        case 'codebuddy':
            return new CodebuddyProvider({
                name: profile.id,
                command: profile.command,
                args: profile.args,
                env: profile.env,
                cwd: profile.cwd,
            })
        case 'agent':
            return new CursorAgentProvider({
                name: profile.id,
                command: profile.command,
                args: profile.args,
                env: profile.env,
                cwd: profile.cwd,
                modelsCommand: profile.modelsCommand,
                modelsArgs: profile.modelsArgs,
            })
        case 'codex':
            return new CodexProvider({
                name: profile.id,
                command: profile.command,
                args: profile.args,
                env: profile.env,
                cwd: profile.cwd,
                modelsCommand: profile.modelsCommand,
                modelsArgs: profile.modelsArgs,
            })
        case 'acp':
            if (!profile.command) {
                throw new Error(`Provider profile "${profile.id}" of type "acp" requires command`)
            }
            return new AcpProvider({
                name: profile.id,
                command: profile.command,
                args: profile.args ?? [],
                ...(profile.env ? { env: profile.env } : {}),
                ...(profile.cwd ? { cwd: profile.cwd } : {}),
            })
    }
}

function parseProviderProfile(entry: unknown, source: string): ProviderProfile {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Invalid provider profile config ${source}: provider must be an object`)
    }

    const record = entry as Record<string, unknown>
    const id = readRequiredString(record, 'id', source)
    validateProfileId(id, `${source}.id`)
    const type = readRequiredString(record, 'type', source) as ProviderProfileType
    if (!isProviderProfileType(type)) {
        throw new Error(`Invalid provider profile config ${source}.type: unsupported provider type "${type}"`)
    }

    return {
        id,
        type,
        ...readOptionalStringField(record, 'command', source),
        ...readOptionalStringArrayField(record, 'args', source),
        ...readOptionalStringRecordField(record, 'env', source),
        ...readOptionalStringField(record, 'cwd', source),
        ...readOptionalStringArrayField(record, 'modelProviders', source),
        ...readOptionalStringField(record, 'modelsCommand', source),
        ...readOptionalStringArrayField(record, 'modelsArgs', source),
    }
}

function isProviderProfileType(value: string): value is ProviderProfileType {
    return value === 'opencode'
        || value === 'codebuddy'
        || value === 'agent'
        || value === 'codex'
        || value === 'acp'
}

function validateProfileId(id: string, source: string): void {
    if (!PROFILE_ID_PATTERN.test(id)) {
        throw new Error(`Invalid provider profile config ${source}: use 1-48 characters from letters, numbers, dot, underscore, or dash, and start with a letter or number`)
    }
}

function readRequiredString(record: Record<string, unknown>, key: string, source: string): string {
    const value = readOptionalString(record, key, source)
    if (!value) throw new Error(`Invalid provider profile config ${source}.${key}: required string`)
    return value
}

function readOptionalString(record: Record<string, unknown>, key: string, source: string): string | undefined {
    const value = record[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') {
        throw new Error(`Invalid provider profile config ${source}.${key}: expected string`)
    }
    const trimmed = value.trim()
    return trimmed || undefined
}

function readOptionalStringField<K extends string>(record: Record<string, unknown>, key: K, source: string): Partial<Record<K, string>> {
    const value = readOptionalString(record, key, source)
    return value === undefined ? {} : { [key]: value } as Partial<Record<K, string>>
}

function readOptionalStringArrayField<K extends string>(record: Record<string, unknown>, key: K, source: string): Partial<Record<K, string[]>> {
    const value = record[key]
    if (value === undefined) return {}
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`Invalid provider profile config ${source}.${key}: expected string array`)
    }
    return { [key]: value } as Partial<Record<K, string[]>>
}

function readOptionalStringRecordField<K extends string>(record: Record<string, unknown>, key: K, source: string): Partial<Record<K, Record<string, string>>> {
    const value = record[key]
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid provider profile config ${source}.${key}: expected object`)
    }
    const output: Record<string, string> = {}
    for (const [envKey, envValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof envValue !== 'string') {
            throw new Error(`Invalid provider profile config ${source}.${key}.${envKey}: expected string`)
        }
        output[envKey] = envValue
    }
    return { [key]: output } as Partial<Record<K, Record<string, string>>>
}
