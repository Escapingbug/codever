import { ExecutionAuthorizationError } from './keys'

export interface ReplayRecord {
    tokenId: string
    requestHash: string
    expiresAt: number
}

export type ReplayDisposition = 'first-seen' | 'duplicate'

export interface ExecutionReplayGuard {
    consume(record: ReplayRecord): Promise<ReplayDisposition>
}

/** Test and ephemeral-runtime implementation. Gateways use the persistent implementation. */
export class InMemoryExecutionReplayGuard implements ExecutionReplayGuard {
    private readonly records = new Map<string, ReplayRecord>()

    constructor(private readonly now: () => number = () => Date.now()) {}

    async consume(record: ReplayRecord): Promise<ReplayDisposition> {
        this.prune()
        const existing = this.records.get(record.tokenId)
        if (!existing) {
            this.records.set(record.tokenId, { ...record })
            return 'first-seen'
        }
        if (existing.requestHash !== record.requestHash) {
            throw new ExecutionAuthorizationError('replay_conflict', 'The execution token was reused for another request')
        }
        return 'duplicate'
    }

    private prune(): void {
        const nowSeconds = Math.floor(this.now() / 1_000)
        for (const [tokenId, record] of this.records) {
            if (record.expiresAt < nowSeconds) this.records.delete(tokenId)
        }
    }
}
