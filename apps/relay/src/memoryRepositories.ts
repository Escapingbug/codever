import type { Gateway } from '@codever/protocol'
import type { GatewayRepository } from './repositories'

const clone = <T>(value: T): T => structuredClone(value)

export class InMemoryGatewayRepository implements GatewayRepository {
    private readonly values = new Map<string, Gateway>()

    async list(): Promise<Gateway[]> {
        return [...this.values.values()].map(clone)
    }

    async get(id: string): Promise<Gateway | undefined> {
        const value = this.values.get(id)
        return value && clone(value)
    }

    async upsert(gateway: Gateway): Promise<void> {
        this.values.set(gateway.id, clone(gateway))
    }

    async updateConnection(id: string, status: Gateway['status'], connectionEpoch?: string, lastSeenAt?: string): Promise<void> {
        const current = this.values.get(id)
        if (!current) return
        const next = { ...current, status, lastSeenAt: lastSeenAt ?? current.lastSeenAt }
        if (connectionEpoch === undefined) delete next.connectionEpoch
        else next.connectionEpoch = connectionEpoch
        this.values.set(id, next)
    }
}

export interface InMemoryRelayRepositories {
    gateways: InMemoryGatewayRepository
}

export function createInMemoryRelayRepositories(): InMemoryRelayRepositories {
    return { gateways: new InMemoryGatewayRepository() }
}
