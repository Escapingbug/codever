import type { ChannelMessage, ChannelPort, ChannelSendResult } from '@/bridge/channelPort'

export type DeliveryStatus = 'pending' | 'sent' | 'edited' | 'failed' | 'skipped'

export interface DeliveryRecord {
    id: string
    kind: 'send' | 'edit'
    status: DeliveryStatus
    message: ChannelMessage
    messageId?: string | number
    error?: unknown
    createdAt: number
    completedAt?: number
}

export interface DeliveryOutboxConfig {
    channelPort: ChannelPort
    onFailure?: (record: DeliveryRecord) => void
    maxRateLimitRetries?: number
    maxRateLimitDelayMs?: number
    deliveryTimeoutMs?: number
}

const DEFAULT_RATE_LIMIT_RETRIES = 3
const DEFAULT_MAX_RATE_LIMIT_DELAY_MS = 60_000
const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000

export class DeliveryOutbox {
    private chain: Promise<void> = Promise.resolve()
    private records: DeliveryRecord[] = []
    private nextId = 0

    constructor(private config: DeliveryOutboxConfig) {}

    send(message: ChannelMessage, onSent?: (result: ChannelSendResult) => void): Promise<DeliveryRecord> {
        const record = this.createRecord('send', message)
        this.chain = this.chain.then(async () => {
            try {
                const result = await this.withRateLimitRetry(() => this.config.channelPort.send(message))
                record.status = 'sent'
                record.messageId = result.messageId
                onSent?.(result)
            } catch (error) {
                record.status = 'failed'
                record.error = error
                this.config.onFailure?.(record)
            } finally {
                record.completedAt = Date.now()
            }
        })
        return this.chain.then(() => record)
    }

    edit(messageId: string | number | undefined, message: ChannelMessage, fallbackToSend = true): Promise<DeliveryRecord> {
        if (messageId === undefined || messageId === null || !this.config.channelPort.edit) {
            if (fallbackToSend) return this.send(message)
            const skipped = this.createRecord('edit', message)
            skipped.status = 'skipped'
            skipped.completedAt = Date.now()
            return Promise.resolve(skipped)
        }

        const record = this.createRecord('edit', message)
        record.messageId = messageId
        this.chain = this.chain.then(async () => {
            try {
                await this.withRateLimitRetry(() => this.config.channelPort.edit!(messageId, message))
                record.status = 'edited'
            } catch (error) {
                record.status = 'failed'
                record.error = error
                this.config.onFailure?.(record)
                if (fallbackToSend) {
                    await this.withRateLimitRetry(() => this.config.channelPort.send(message))
                }
            } finally {
                record.completedAt = Date.now()
            }
        })
        return this.chain.then(() => record)
    }

    editDeferred(resolveMessageId: () => string | number | undefined, message: ChannelMessage, fallbackToSend = true): Promise<DeliveryRecord> {
        const record = this.createRecord('edit', message)
        this.chain = this.chain.then(async () => {
            const messageId = resolveMessageId()
            if (messageId === undefined || messageId === null || !this.config.channelPort.edit) {
                if (!fallbackToSend) {
                    record.status = 'skipped'
                    record.completedAt = Date.now()
                    return
                }
                try {
                    const result = await this.withRateLimitRetry(() => this.config.channelPort.send(message))
                    record.status = 'sent'
                    record.messageId = result.messageId
                } catch (error) {
                    record.status = 'failed'
                    record.error = error
                    this.config.onFailure?.(record)
                }
                record.completedAt = Date.now()
                return
            }

            record.messageId = messageId
            const edit = this.config.channelPort.edit
            try {
                await this.withRateLimitRetry(() => edit(messageId, message))
                record.status = 'edited'
            } catch (error) {
                record.status = 'failed'
                record.error = error
                this.config.onFailure?.(record)
                if (fallbackToSend) {
                    const result = await this.withRateLimitRetry(() => this.config.channelPort.send(message))
                    record.status = 'sent'
                    record.messageId = result.messageId
                }
            } finally {
                record.completedAt = Date.now()
            }
        })
        return this.chain.then(() => record)
    }

    async drain(): Promise<DeliveryRecord[]> {
        await this.chain
        return [...this.records]
    }

    list(): DeliveryRecord[] {
        return [...this.records]
    }

    private createRecord(kind: 'send' | 'edit', message: ChannelMessage): DeliveryRecord {
        const record: DeliveryRecord = {
            id: `delivery-${++this.nextId}`,
            kind,
            status: 'pending',
            message,
            createdAt: Date.now(),
        }
        this.records.push(record)
        return record
    }

    private async withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
        const maxRetries = this.config.maxRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES
        const maxDelayMs = this.config.maxRateLimitDelayMs ?? DEFAULT_MAX_RATE_LIMIT_DELAY_MS
        const timeoutMs = this.config.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS

        for (let attempt = 0; ; attempt++) {
            try {
                return await withTimeout(operation(), timeoutMs)
            } catch (error) {
                const retryAfterMs = getRetryAfterMs(error)
                if (retryAfterMs === null || attempt >= maxRetries) {
                    throw error
                }
                await delay(Math.min(retryAfterMs, maxDelayMs))
            }
        }
    }
}

class DeliveryTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Delivery operation timed out after ${timeoutMs}ms`)
        this.name = 'DeliveryTimeoutError'
    }
}

function getRetryAfterMs(error: unknown): number | null {
    const retryAfter = getNestedRetryAfter(error)
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
        return retryAfter * 1000
    }

    const message = error instanceof Error ? error.message : String(error)
    const match = /retry after (\d+)/i.exec(message)
    if (!match) return null
    return Number.parseInt(match[1], 10) * 1000
}

function getNestedRetryAfter(error: unknown): unknown {
    if (!error || typeof error !== 'object') return undefined
    const record = error as Record<string, unknown>
    const parameters = record.parameters
    if (parameters && typeof parameters === 'object' && 'retry_after' in parameters) {
        return (parameters as Record<string, unknown>).retry_after
    }
    if ('retry_after' in record) {
        return record.retry_after
    }
    return undefined
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise

    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new DeliveryTimeoutError(timeoutMs)), timeoutMs)
    })

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
}
