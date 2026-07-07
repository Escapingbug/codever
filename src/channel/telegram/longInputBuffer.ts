export interface LongInputScope {
    topicKey: string
    userId: number
}

export interface LongInputStats {
    partCount: number
    totalChars: number
    startedAt: number
    updatedAt: number
}

export interface LongInputBufferOptions {
    maxChars?: number
    maxParts?: number
    ttlMs?: number
}

export type LongInputBeginResult =
    | { status: 'started'; stats: LongInputStats }
    | { status: 'already_active'; stats: LongInputStats }

export type LongInputAppendResult =
    | { status: 'appended'; stats: LongInputStats }
    | { status: 'inactive' }
    | { status: 'expired' }
    | { status: 'too_large'; stats: LongInputStats; maxChars: number; attemptedChars: number }
    | { status: 'too_many_parts'; stats: LongInputStats; maxParts: number }

export type LongInputReadResult =
    | { status: 'ready'; text: string; stats: LongInputStats }
    | { status: 'empty'; stats: LongInputStats }
    | { status: 'inactive' }
    | { status: 'expired' }

export type LongInputCancelResult =
    | { status: 'cancelled'; stats: LongInputStats }
    | { status: 'inactive' }
    | { status: 'expired' }

interface LongInputEntry {
    parts: string[]
    messageIds: number[]
    totalChars: number
    startedAt: number
    updatedAt: number
}

const DEFAULT_MAX_CHARS = 256 * 1024
const DEFAULT_MAX_PARTS = 256
const DEFAULT_TTL_MS = 30 * 60 * 1000

export class LongInputBuffer {
    readonly maxChars: number
    readonly maxParts: number
    readonly ttlMs: number
    private entries = new Map<string, LongInputEntry>()

    constructor(options: LongInputBufferOptions = {}) {
        this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
        this.maxParts = options.maxParts ?? DEFAULT_MAX_PARTS
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    }

    begin(scope: LongInputScope, now = Date.now()): LongInputBeginResult {
        this.cleanup(now)
        const key = this.key(scope)
        const existing = this.entries.get(key)
        if (existing) {
            return { status: 'already_active', stats: this.stats(existing) }
        }

        const entry: LongInputEntry = {
            parts: [],
            messageIds: [],
            totalChars: 0,
            startedAt: now,
            updatedAt: now,
        }
        this.entries.set(key, entry)
        return { status: 'started', stats: this.stats(entry) }
    }

    append(scope: LongInputScope, text: string, options: { messageId?: number; now?: number } = {}): LongInputAppendResult {
        const now = options.now ?? Date.now()
        const loaded = this.load(scope, now)
        if (loaded.status !== 'active') return { status: loaded.status }

        const entry = loaded.entry
        const attemptedChars = entry.totalChars + text.length
        if (attemptedChars > this.maxChars) {
            return {
                status: 'too_large',
                stats: this.stats(entry),
                maxChars: this.maxChars,
                attemptedChars,
            }
        }
        if (entry.parts.length >= this.maxParts) {
            return {
                status: 'too_many_parts',
                stats: this.stats(entry),
                maxParts: this.maxParts,
            }
        }

        entry.parts.push(text)
        if (options.messageId !== undefined) entry.messageIds.push(options.messageId)
        entry.totalChars = attemptedChars
        entry.updatedAt = now
        return { status: 'appended', stats: this.stats(entry) }
    }

    read(scope: LongInputScope, now = Date.now()): LongInputReadResult {
        const loaded = this.load(scope, now)
        if (loaded.status !== 'active') return { status: loaded.status }

        const entry = loaded.entry
        const text = entry.parts.join('')
        const stats = this.stats(entry)
        if (text.trim().length === 0) return { status: 'empty', stats }
        return { status: 'ready', text, stats }
    }

    cancel(scope: LongInputScope, now = Date.now()): LongInputCancelResult {
        const loaded = this.load(scope, now)
        if (loaded.status !== 'active') return { status: loaded.status }

        this.entries.delete(this.key(scope))
        return { status: 'cancelled', stats: this.stats(loaded.entry) }
    }

    clear(scope: LongInputScope): void {
        this.entries.delete(this.key(scope))
    }

    hasActive(scope: LongInputScope, now = Date.now()): boolean {
        return this.load(scope, now).status === 'active'
    }

    cleanup(now = Date.now()): number {
        let removed = 0
        for (const [key, entry] of this.entries) {
            if (!this.isExpired(entry, now)) continue
            this.entries.delete(key)
            removed++
        }
        return removed
    }

    private load(scope: LongInputScope, now: number): { status: 'active'; entry: LongInputEntry } | { status: 'inactive' | 'expired' } {
        const key = this.key(scope)
        const entry = this.entries.get(key)
        if (!entry) return { status: 'inactive' }
        if (this.isExpired(entry, now)) {
            this.entries.delete(key)
            return { status: 'expired' }
        }
        return { status: 'active', entry }
    }

    private isExpired(entry: LongInputEntry, now: number): boolean {
        return now - entry.updatedAt > this.ttlMs
    }

    private stats(entry: LongInputEntry): LongInputStats {
        return {
            partCount: entry.parts.length,
            totalChars: entry.totalChars,
            startedAt: entry.startedAt,
            updatedAt: entry.updatedAt,
        }
    }

    private key(scope: LongInputScope): string {
        return `${scope.topicKey}:${scope.userId}`
    }
}
