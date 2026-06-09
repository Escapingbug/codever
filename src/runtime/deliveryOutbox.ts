import type { ChannelMessage, ChannelPort, ChannelSendResult } from '@/bridge/channelPort'

export type DeliveryStatus = 'pending' | 'sent' | 'edited' | 'failed' | 'skipped'
export type DeliveryLane = 'control' | 'normal' | 'progressive-edit'

export interface DeliveryRecord {
    id: string
    kind: 'send' | 'edit'
    status: DeliveryStatus
    message: ChannelMessage
    messageId?: string | number
    error?: unknown
    createdAt: number
    completedAt?: number
    lane?: DeliveryLane
    coalesceKey?: string
    terminal?: boolean
    skippedReason?: string
}

export interface DeliveryOutboxConfig {
    channelPort: ChannelPort
    onFailure?: (record: DeliveryRecord) => void
    onLog?: (message: string) => void
    maxRateLimitRetries?: number
    maxRateLimitDelayMs?: number
    deliveryTimeoutMs?: number
    progressiveEditDebounceMs?: number
}

export interface DeliveryOptions {
    lane?: DeliveryLane
    coalesceKey?: string
    terminal?: boolean
}

export interface DeliveryOutboxState {
    pendingControl: number
    pendingNormal: number
    pendingProgressiveEdits: number
    progressiveEditBlockedUntil?: number
    lastRateLimitError?: string
    lastFailure?: string
}

const DEFAULT_RATE_LIMIT_RETRIES = 3
const DEFAULT_MAX_RATE_LIMIT_DELAY_MS = 60_000
const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000

export class DeliveryOutbox {
    private controlChain: Promise<void> = Promise.resolve()
    private normalChain: Promise<void> = Promise.resolve()
    private records: DeliveryRecord[] = []
    private nextId = 0
    private pendingControl = 0
    private pendingNormal = 0
    private progressiveEditLoop: Promise<void> | null = null
    private progressiveEditBlockedUntil = 0
    private progressiveEdits = new Map<string, ProgressiveEditTask>()
    private lastRateLimitError: string | undefined
    private lastFailure: string | undefined

    constructor(private config: DeliveryOutboxConfig) {}

    send(message: ChannelMessage, onSent?: (result: ChannelSendResult) => void, options: DeliveryOptions = {}): Promise<DeliveryRecord> {
        const lane = options.lane ?? 'normal'
        const record = this.createRecord('send', message, { ...options, lane })
        return this.enqueueReliable(lane, record, async () => {
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
    }

    edit(messageId: string | number | undefined, message: ChannelMessage, fallbackToSend = true, options: DeliveryOptions = {}): Promise<DeliveryRecord> {
        if (messageId === undefined || messageId === null || !this.config.channelPort.edit) {
            if (fallbackToSend) return this.send(message, undefined, options)
            const skipped = this.createRecord('edit', message, options)
            skipped.status = 'skipped'
            skipped.skippedReason = 'missing-message-id'
            skipped.completedAt = Date.now()
            return Promise.resolve(skipped)
        }

        const lane = options.lane ?? 'normal'
        const record = this.createRecord('edit', message, { ...options, lane })
        record.messageId = messageId

        if (lane === 'progressive-edit') {
            return this.enqueueProgressiveEdit(record, messageId, message, fallbackToSend)
        }

        return this.enqueueReliable(lane, record, async () => {
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
    }

    editDeferred(resolveMessageId: () => string | number | undefined, message: ChannelMessage, fallbackToSend = true, options: DeliveryOptions = {}): Promise<DeliveryRecord> {
        const lane = options.lane ?? 'normal'
        const record = this.createRecord('edit', message, { ...options, lane })
        return this.enqueueReliable(lane, record, async () => {
            const messageId = resolveMessageId()
            if (messageId === undefined || messageId === null || !this.config.channelPort.edit) {
                if (!fallbackToSend) {
                    record.status = 'skipped'
                    record.skippedReason = 'missing-message-id'
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
    }

    async drain(options: { timeoutMs?: number } = {}): Promise<DeliveryRecord[]> {
        const promise = Promise.all([
            this.controlChain,
            this.normalChain,
            this.progressiveEditLoop ?? Promise.resolve(),
        ])
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
            await Promise.race([
                promise,
                delay(options.timeoutMs),
            ])
        } else {
            await promise
        }
        return [...this.records]
    }

    list(): DeliveryRecord[] {
        return [...this.records]
    }

    getState(): DeliveryOutboxState {
        return {
            pendingControl: this.pendingControl,
            pendingNormal: this.pendingNormal,
            pendingProgressiveEdits: this.progressiveEdits.size,
            ...(this.progressiveEditBlockedUntil > Date.now() ? { progressiveEditBlockedUntil: this.progressiveEditBlockedUntil } : {}),
            ...(this.lastRateLimitError ? { lastRateLimitError: this.lastRateLimitError } : {}),
            ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
        }
    }

    private createRecord(kind: 'send' | 'edit', message: ChannelMessage, options: DeliveryOptions = {}): DeliveryRecord {
        const record: DeliveryRecord = {
            id: `delivery-${++this.nextId}`,
            kind,
            status: 'pending',
            message,
            createdAt: Date.now(),
            ...(options.lane ? { lane: options.lane } : {}),
            ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
            ...(options.terminal !== undefined ? { terminal: options.terminal } : {}),
        }
        this.records.push(record)
        return record
    }

    private enqueueReliable(lane: DeliveryLane, record: DeliveryRecord, operation: () => Promise<void>): Promise<DeliveryRecord> {
        if (lane === 'control') {
            this.pendingControl += 1
            this.controlChain = this.controlChain.then(operation).finally(() => {
                this.pendingControl -= 1
            })
            return this.controlChain.then(() => record)
        }

        this.pendingNormal += 1
        this.normalChain = this.normalChain.then(operation).finally(() => {
            this.pendingNormal -= 1
        })
        return this.normalChain.then(() => record)
    }

    private enqueueProgressiveEdit(
        record: DeliveryRecord,
        messageId: string | number,
        message: ChannelMessage,
        fallbackToSend: boolean,
    ): Promise<DeliveryRecord> {
        const key = record.coalesceKey ?? String(messageId)

        return new Promise((resolve) => {
            const existing = this.progressiveEdits.get(key)
            if (existing && !existing.record.terminal) {
                existing.record.status = 'skipped'
                existing.record.skippedReason = 'coalesced'
                existing.record.completedAt = Date.now()
                existing.resolve(existing.record)
                this.log(`[delivery] coalesced progressive edit key=${key}`)
            }

            this.progressiveEdits.set(key, {
                key,
                record,
                messageId,
                message,
                fallbackToSend,
                attempts: 0,
                resolve,
            })
            this.ensureProgressiveEditLoop()
        })
    }

    private ensureProgressiveEditLoop(): void {
        if (this.progressiveEditLoop) return
        this.progressiveEditLoop = this.runProgressiveEditLoop().finally(() => {
            this.progressiveEditLoop = null
            if (this.progressiveEdits.size > 0) {
                this.ensureProgressiveEditLoop()
            }
        })
    }

    private async runProgressiveEditLoop(): Promise<void> {
        while (this.progressiveEdits.size > 0) {
            const debounceMs = this.config.progressiveEditDebounceMs ?? 1500
            const hasOnlyTerminalEdits = [...this.progressiveEdits.values()].every(task => task.record.terminal)
            if (!hasOnlyTerminalEdits && debounceMs > 0) {
                await delay(debounceMs)
            }

            const blockedForMs = this.progressiveEditBlockedUntil - Date.now()
            if (blockedForMs > 0) {
                await delay(blockedForMs)
            }

            const tasks = [...this.progressiveEdits.values()]
            this.progressiveEdits.clear()
            for (const task of tasks) {
                await this.performProgressiveEdit(task)
            }
        }
    }

    private async performProgressiveEdit(task: ProgressiveEditTask): Promise<void> {
        let requeued = false
        try {
            await withTimeout(this.config.channelPort.edit!(task.messageId, task.message), this.config.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS)
            task.record.status = 'edited'
        } catch (error) {
            const retryAfterMs = getRetryAfterMs(error)
            if (retryAfterMs !== null) {
                const delayMs = Math.min(retryAfterMs, this.config.maxRateLimitDelayMs ?? DEFAULT_MAX_RATE_LIMIT_DELAY_MS)
                this.progressiveEditBlockedUntil = Math.max(this.progressiveEditBlockedUntil, Date.now() + delayMs)
                this.lastRateLimitError = error instanceof Error ? error.message : String(error)

                if (task.record.terminal && task.attempts < (this.config.maxRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES)) {
                    task.attempts += 1
                    this.progressiveEdits.set(task.key, task)
                    requeued = true
                    this.log(`[delivery] terminal progressive edit rate-limited; retrying key=${task.key} after ${delayMs}ms`)
                    return
                }

                task.record.status = 'skipped'
                task.record.error = error
                task.record.skippedReason = 'rate-limited'
                this.log(`[delivery] skipped progressive edit key=${task.key}: ${this.lastRateLimitError}`)
                return
            }

            task.record.status = 'failed'
            task.record.error = error
            this.config.onFailure?.(task.record)
            if (task.fallbackToSend) {
                try {
                    const result = await this.withRateLimitRetry(() => this.config.channelPort.send(task.message))
                    task.record.status = 'sent'
                    task.record.messageId = result.messageId
                } catch (sendError) {
                    task.record.status = 'failed'
                    task.record.error = sendError
                    this.config.onFailure?.(task.record)
                }
            }
        } finally {
            if (task.record.status === 'failed') {
                this.lastFailure = task.record.error instanceof Error ? task.record.error.message : String(task.record.error)
            }
            if (requeued) return
            task.record.completedAt = Date.now()
            task.resolve(task.record)
        }
    }

    private log(message: string): void {
        this.config.onLog?.(message)
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
                    this.lastFailure = error instanceof Error ? error.message : String(error)
                    throw error
                }
                this.lastRateLimitError = error instanceof Error ? error.message : String(error)
                await delay(Math.min(retryAfterMs, maxDelayMs))
            }
        }
    }
}

interface ProgressiveEditTask {
    key: string
    record: DeliveryRecord
    messageId: string | number
    message: ChannelMessage
    fallbackToSend: boolean
    attempts: number
    resolve: (record: DeliveryRecord) => void
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
