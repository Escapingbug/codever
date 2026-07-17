import type { Gateway } from '@codever/protocol'

export interface GatewayRepository {
    list(): Promise<Gateway[]>
    get(id: string): Promise<Gateway | undefined>
    upsert(gateway: Gateway): Promise<void>
    remove(id: string): Promise<boolean>
    updateConnection(id: string, status: Gateway['status'], connectionEpoch?: string, lastSeenAt?: string): Promise<void>
}
