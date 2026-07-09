import type { AgentProvider } from './provider'

export type ProviderFactory = () => AgentProvider
export interface ProviderRegistrationOptions {
    type?: string
}

const providers = new Map<string, AgentProvider>()
const providerFactories = new Map<string, ProviderFactory>()
const providerTypes = new Map<string, string>()

export function registerProvider(provider: AgentProvider, factory?: ProviderFactory, options: ProviderRegistrationOptions = {}): void {
    providers.set(provider.name, provider)
    providerFactories.set(provider.name, factory ?? (() => provider))
    providerTypes.set(provider.name, options.type ?? inferProviderType(provider.name))
}

export function getProvider(name: string): AgentProvider | undefined {
    return providers.get(name)
}

export function getProviderType(name: string): string | undefined {
    return providerTypes.get(name)
}

/**
 * Create a provider instance for one channel session.
 *
 * The registry-level provider is a catalog/probe instance used for model lists
 * and readiness checks. Runtime sessions must not share its ACP connection,
 * otherwise concurrent topics overwrite active prompt and permission state.
 */
export function createProviderInstance(name: string): AgentProvider | undefined {
    return providerFactories.get(name)?.()
}

export function getDefaultProvider(): AgentProvider {
    const first = providers.values().next()
    if (first.done) throw new Error('No agent providers registered')
    return first.value
}

export function listProviders(): string[] {
    return Array.from(providers.keys())
}

export function clearProviderRegistryForTesting(): void {
    providers.clear()
    providerFactories.clear()
    providerTypes.clear()
}

function inferProviderType(name: string): string {
    const normalized = name.toLowerCase()
    if (normalized.includes('opencode')) return 'opencode'
    if (normalized.includes('codebuddy')) return 'codebuddy'
    if (normalized === 'agent' || normalized.includes('cursor')) return 'agent'
    if (normalized.includes('codex')) return 'codex'
    if (normalized.includes('acp')) return 'acp'
    return normalized
}
