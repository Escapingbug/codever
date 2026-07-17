import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ClientGatewayRequestFrame, ClientGatewayResponseFrame } from '@codever/protocol'
import { PROTOCOL_VERSION } from '@codever/protocol'

const SCHEMA_VERSION = 1
const DEFAULT_MAX_RECORDS = 5_000

interface PendingRecord {
    key: string
    payloadHash: string
    status: 'pending'
    createdAt: string
    updatedAt: string
}

interface CompletedRecord {
    key: string
    payloadHash: string
    status: 'completed'
    createdAt: string
    updatedAt: string
    response: ClientGatewayResponseFrame
}

type LedgerRecord = PendingRecord | CompletedRecord

interface PersistedLedger {
    schemaVersion: 1
    records: LedgerRecord[]
}

export interface GatewayRequestLedgerOptions {
    maxRecords?: number
    now?: () => Date
}

/**
 * Durable boundary for client command idempotency.
 *
 * A pending record is persisted before executing a command. If the process dies
 * in the commit gap, the next attempt is reported as indeterminate instead of
 * executing the mutation twice. Completed responses can be replayed on a fresh
 * secure connection with the new request ID.
 */
export class GatewayRequestLedger {
    private readonly records = new Map<string, LedgerRecord>()
    private readonly inFlight = new Map<string, {
        payloadHash: string
        promise: Promise<ClientGatewayResponseFrame>
    }>()
    private mutationQueue: Promise<void> = Promise.resolve()
    private readonly temporaryPath: string
    private readonly maxRecords: number
    private readonly now: () => Date

    private constructor(private readonly storagePath: string, options: GatewayRequestLedgerOptions) {
        this.temporaryPath = `${storagePath}.tmp`
        this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
        this.now = options.now ?? (() => new Date())
        if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) {
            throw new Error('maxRecords must be a positive integer')
        }
    }

    static async open(storagePath: string, options: GatewayRequestLedgerOptions = {}): Promise<GatewayRequestLedger> {
        const ledger = new GatewayRequestLedger(resolve(storagePath), options)
        const persisted = await recover(ledger.storagePath, ledger.temporaryPath)
        for (const record of persisted?.records ?? []) ledger.records.set(record.key, record)
        return ledger
    }

    execute(
        request: ClientGatewayRequestFrame,
        credentialId: string,
        operation: () => Promise<ClientGatewayResponseFrame>,
    ): Promise<ClientGatewayResponseFrame> {
        const key = ledgerKey(credentialId, request.idempotencyKey)
        const payloadHash = hashPayload(request.payload)
        const running = this.inFlight.get(key)
        if (running) {
            if (running.payloadHash !== payloadHash) {
                return Promise.resolve(failed(
                    request.requestId,
                    'idempotency_conflict',
                    'The idempotency key is already executing another request',
                ))
            }
            return running.promise.then(response => withRequestId(response, request.requestId))
        }

        const execution = this.executeOnce(key, payloadHash, request, operation)
        this.inFlight.set(key, { payloadHash, promise: execution })
        void execution.finally(() => {
            if (this.inFlight.get(key)?.promise === execution) this.inFlight.delete(key)
        }).catch(() => undefined)
        return execution
    }

    private async executeOnce(
        key: string,
        payloadHash: string,
        request: ClientGatewayRequestFrame,
        operation: () => Promise<ClientGatewayResponseFrame>,
    ): Promise<ClientGatewayResponseFrame> {
        const existing = await this.serialized(async () => {
            const record = this.records.get(key)
            if (record) return record
            const timestamp = this.now().toISOString()
            this.records.set(key, { key, payloadHash, status: 'pending', createdAt: timestamp, updatedAt: timestamp })
            await this.persist()
            return undefined
        })

        if (existing) {
            if (existing.payloadHash !== payloadHash) {
                return failed(request.requestId, 'idempotency_conflict', 'The idempotency key was already used for another request')
            }
            if (existing.status === 'pending') {
                return failed(request.requestId, 'idempotency_in_doubt', 'The previous request may have completed; it will not be executed again')
            }
            return withRequestId(existing.response, request.requestId)
        }

        let response: ClientGatewayResponseFrame
        try {
            response = await operation()
        } catch (error) {
            response = failed(request.requestId, 'gateway_request_failed', error instanceof Error ? error.message : String(error))
        }

        await this.serialized(async () => {
            const pending = this.records.get(key)
            const timestamp = this.now().toISOString()
            this.records.set(key, {
                key,
                payloadHash,
                status: 'completed',
                createdAt: pending?.createdAt ?? timestamp,
                updatedAt: timestamp,
                response,
            })
            this.prune()
            await this.persist()
        })
        return response
    }

    private prune(): void {
        if (this.records.size <= this.maxRecords) return
        const removable = [...this.records.values()]
            .filter((record): record is CompletedRecord => record.status === 'completed')
            .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        for (const record of removable) {
            if (this.records.size <= this.maxRecords) break
            this.records.delete(record.key)
        }
    }

    private serialized<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation)
        this.mutationQueue = result.then(() => undefined, () => undefined)
        return result
    }

    private async persist(): Promise<void> {
        await mkdir(dirname(this.storagePath), { recursive: true })
        const body = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records: [...this.records.values()] }, null, 2)}\n`
        const handle = await open(this.temporaryPath, 'w')
        try {
            await handle.writeFile(body, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }
        await rename(this.temporaryPath, this.storagePath)
        await syncDirectory(dirname(this.storagePath))
    }
}

function ledgerKey(credentialId: string, idempotencyKey: string): string {
    return `${credentialId}:${idempotencyKey}`
}

function hashPayload(payload: ClientGatewayRequestFrame['payload']): string {
    return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        const serialized = JSON.stringify(value)
        if (serialized === undefined) throw new Error('Idempotent request payload must be JSON serializable')
        return serialized
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function withRequestId(response: ClientGatewayResponseFrame, requestId: string): ClientGatewayResponseFrame {
    return { ...structuredClone(response), requestId }
}

function failed(requestId: string, code: string, message: string): ClientGatewayResponseFrame {
    return {
        version: PROTOCOL_VERSION,
        type: 'gateway.client.response',
        requestId,
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: { code, message, retryable: false },
    }
}

async function recover(storagePath: string, temporaryPath: string): Promise<PersistedLedger | undefined> {
    try {
        const persisted = await readLedger(storagePath)
        await rm(temporaryPath, { force: true })
        return persisted
    } catch (error) {
        if (!isMissing(error)) throw error
        try {
            const recovered = await readLedger(temporaryPath)
            await mkdir(dirname(storagePath), { recursive: true })
            await rename(temporaryPath, storagePath)
            await syncDirectory(dirname(storagePath))
            return recovered
        } catch (recoveryError) {
            if (isMissing(recoveryError)) return undefined
            throw recoveryError
        }
    }
}

async function readLedger(path: string): Promise<PersistedLedger> {
    const value = JSON.parse(await readFile(path, 'utf8')) as PersistedLedger
    if (value?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.records)) {
        throw new Error(`Invalid Gateway request ledger: ${path}`)
    }
    return value
}

async function syncDirectory(directory: string): Promise<void> {
    let handle
    try {
        handle = await open(directory, 'r')
        await handle.sync()
    } catch (error) {
        if (process.platform !== 'win32') throw error
    } finally {
        await handle?.close()
    }
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
