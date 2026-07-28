import {
  canonicalJson,
  type CodeverCommand,
  type JsonValue,
} from '@codever/protocol'
import { sha256 } from './encoding.js'
import { SecurityError } from './errors.js'

export type LedgerRecord<TResult extends JsonValue = JsonValue> =
  | {
      status: 'pending'
      fingerprint: string
      createdAt: number
      expiresAt: number
    }
  | {
      status: 'completed'
      fingerprint: string
      createdAt: number
      expiresAt: number
      completedAt: number
      result: TResult
    }
  | {
      status: 'failed'
      fingerprint: string
      createdAt: number
      expiresAt: number
      completedAt: number
      error: string
    }

export type LedgerClaimResult<TResult extends JsonValue> =
  | { claimed: true }
  | { claimed: false; record: LedgerRecord<TResult> }

/**
 * Persistent implementations MUST make claim atomic and compare fingerprints
 * under a unique key. This is the execution-once boundary across restarts.
 */
export interface IdempotencyStore<TResult extends JsonValue = JsonValue> {
  claim(
    key: string,
    fingerprint: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<LedgerClaimResult<TResult>>
  settle(
    key: string,
    fingerprint: string,
    settlement:
      | { status: 'completed'; completedAt: number; result: TResult }
      | { status: 'failed'; completedAt: number; error: string },
  ): Promise<void>
  prune(now: number): Promise<void>
}

export interface ExecutionClaim {
  kind: 'execute'
  key: string
  fingerprint: string
}

export type BeginResult<TResult extends JsonValue> =
  | ExecutionClaim
  | { kind: 'in_progress' }
  | { kind: 'completed'; result: TResult }
  | { kind: 'failed'; error: string }

export class IdempotencyLedger<TResult extends JsonValue = JsonValue> {
  constructor(
    private readonly store: IdempotencyStore<TResult>,
    private readonly retentionMs = 24 * 60 * 60_000,
  ) {}

  async begin(command: CodeverCommand, now = Date.now()): Promise<BeginResult<TResult>> {
    const key = canonicalJson([
      command.gatewayId,
      command.deviceId,
      command.conversationId,
      command.commandId,
    ])
    const fingerprint = await sha256(canonicalJson(command))
    const result = await this.store.claim(key, fingerprint, now, now + this.retentionMs)

    if (result.claimed) return { kind: 'execute', key, fingerprint }
    if (result.record.fingerprint !== fingerprint) {
      throw new SecurityError(
        'idempotency_conflict',
        'Command id was reused with different signed content',
      )
    }
    switch (result.record.status) {
      case 'pending':
        return { kind: 'in_progress' }
      case 'completed':
        return { kind: 'completed', result: result.record.result }
      case 'failed':
        return { kind: 'failed', error: result.record.error }
    }
  }

  complete(claim: ExecutionClaim, result: TResult, now = Date.now()): Promise<void> {
    return this.store.settle(claim.key, claim.fingerprint, {
      status: 'completed',
      completedAt: now,
      result,
    })
  }

  fail(claim: ExecutionClaim, error: string, now = Date.now()): Promise<void> {
    return this.store.settle(claim.key, claim.fingerprint, {
      status: 'failed',
      completedAt: now,
      error,
    })
  }

  prune(now = Date.now()): Promise<void> {
    return this.store.prune(now)
  }
}

/** Test/development store. Production gateways should provide a durable store. */
export class InMemoryIdempotencyStore<TResult extends JsonValue = JsonValue>
  implements IdempotencyStore<TResult>
{
  private readonly records = new Map<string, LedgerRecord<TResult>>()

  async claim(
    key: string,
    fingerprint: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<LedgerClaimResult<TResult>> {
    await this.prune(createdAt)
    const existing = this.records.get(key)
    if (existing) return { claimed: false, record: structuredClone(existing) }
    this.records.set(key, { status: 'pending', fingerprint, createdAt, expiresAt })
    return { claimed: true }
  }

  async settle(
    key: string,
    fingerprint: string,
    settlement:
      | { status: 'completed'; completedAt: number; result: TResult }
      | { status: 'failed'; completedAt: number; error: string },
  ): Promise<void> {
    const current = this.records.get(key)
    if (!current || current.fingerprint !== fingerprint || current.status !== 'pending') {
      throw new SecurityError('idempotency_state', 'Cannot settle an unclaimed execution')
    }
    this.records.set(key, {
      ...settlement,
      fingerprint,
      createdAt: current.createdAt,
      expiresAt: current.expiresAt,
    })
  }

  async prune(now: number): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key)
    }
  }
}
