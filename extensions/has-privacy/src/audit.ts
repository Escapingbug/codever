import { createHash, createHmac, randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { HasEngineIdentity } from './types.js'

export interface PrivacyAuditEntry {
    action: 'prepare' | 'commit' | 'reject' | 'lifecycle'
    status: 'succeeded' | 'blocked' | 'failed'
    contextId: string
    sessionId: string
    turnId?: string
    findingCount?: number
    mappingVersion?: number
    sourceDigest?: string
    sanitizedDigest?: string
    engine?: HasEngineIdentity
    errorCode?: string
}

export class PrivacyAuditLog {
    private readonly path: string
    private readonly digestKey: Buffer
    private tail: Promise<void> = Promise.resolve()

    constructor(path: string, digestKey: Uint8Array) {
        if (digestKey.byteLength !== 32) {
            throw new Error('Privacy audit digest key must contain exactly 32 bytes')
        }
        this.path = resolve(path)
        this.digestKey = Buffer.from(digestKey)
    }

    async append(entry: PrivacyAuditEntry): Promise<void> {
        const record = {
            id: randomUUID(),
            occurredAt: new Date().toISOString(),
            action: entry.action,
            status: entry.status,
            contextHash: this.protectedDigest(`context\0${entry.contextId}`),
            sessionId: entry.sessionId,
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
            ...(entry.findingCount === undefined ? {} : { findingCount: entry.findingCount }),
            ...(entry.mappingVersion === undefined ? {} : { mappingVersion: entry.mappingVersion }),
            ...(entry.sourceDigest
                ? { sourceDigest: this.protectedDigest(entry.sourceDigest) }
                : {}),
            ...(entry.sanitizedDigest
                ? { sanitizedDigest: this.protectedDigest(entry.sanitizedDigest) }
                : {}),
            ...(entry.engine ? { engine: entry.engine } : {}),
            ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        }
        const write = this.tail.then(async () => {
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
            await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
        })
        this.tail = write.catch(() => undefined)
        await write
    }

    private protectedDigest(value: string): string {
        return createHmac('sha256', this.digestKey)
            .update(`codever-has-audit-digest-v1\0${value}`)
            .digest('hex')
    }
}

export function contentDigest(value: string): string {
    return digest(value)
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}
