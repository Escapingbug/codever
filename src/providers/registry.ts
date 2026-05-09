import type { AgentProvider } from './provider'

export type ProviderFactory = () => AgentProvider

const providers = new Map<string, AgentProvider>()
const providerFactories = new Map<string, ProviderFactory>()

export function registerProvider(provider: AgentProvider, factory?: ProviderFactory): void {
    providers.set(provider.name, provider)
    providerFactories.set(provider.name, factory ?? (() => provider))
}

export function getProvider(name: string): AgentProvider | undefined {
    return providers.get(name)
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
