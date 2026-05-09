import type { AgentProvider } from './provider'

const providers = new Map<string, AgentProvider>()

export function registerProvider(provider: AgentProvider): void {
    providers.set(provider.name, provider)
}

export function getProvider(name: string): AgentProvider | undefined {
    return providers.get(name)
}

export function getDefaultProvider(): AgentProvider {
    const first = providers.values().next()
    if (first.done) throw new Error('No agent providers registered')
    return first.value
}

export function listProviders(): string[] {
    return Array.from(providers.keys())
}
