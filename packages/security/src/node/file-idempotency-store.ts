import type { JsonValue } from '@codever/protocol'
import { SecurityError } from '../errors.js'
import type {
  IdempotencyStore,
  LedgerClaimResult,
  LedgerRecord,
} from '../idempotency.js'
import { AtomicJsonFile, type FileStoreOptions } from './atomic-json-file.js'

interface IdempotencyFileState<TResult extends JsonValue> {
  version: 1
  records: Record<string, LedgerRecord<TResult>>
}

function createState<TResult extends JsonValue>(): IdempotencyFileState<TResult> {
  return { version: 1, records: {} }
}

function pruneState<TResult extends JsonValue>(
  state: IdempotencyFileState<TResult>,
  now: number,
): boolean {
  let changed = false
  for (const [key, record] of Object.entries(state.records)) {
    if (record.expiresAt <= now) {
      delete state.records[key]
      changed = true
    }
  }
  return changed
}

/** Durable, cross-process execution-once ledger backed by a JSON transaction file. */
export class FileIdempotencyStore<TResult extends JsonValue = JsonValue>
  implements IdempotencyStore<TResult>
{
  private readonly file: AtomicJsonFile<IdempotencyFileState<TResult>>

  constructor(path: string, options: FileStoreOptions = {}) {
    this.file = new AtomicJsonFile(path, options)
  }

  claim(
    key: string,
    fingerprint: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<LedgerClaimResult<TResult>> {
    return this.file.transaction(
      createState<TResult>,
      (state): { result: LedgerClaimResult<TResult>; changed: boolean } => {
        const pruned = pruneState(state, createdAt)
        const existing = Object.hasOwn(state.records, key) ? state.records[key] : undefined
        if (existing) {
          return {
            result: { claimed: false, record: structuredClone(existing) },
            changed: pruned,
          }
        }
        Object.defineProperty(state.records, key, {
          value: { status: 'pending', fingerprint, createdAt, expiresAt },
          configurable: true,
          enumerable: true,
          writable: true,
        })
        return { result: { claimed: true }, changed: true }
      },
    )
  }

  settle(
    key: string,
    fingerprint: string,
    settlement:
      | { status: 'completed'; completedAt: number; result: TResult }
      | { status: 'failed'; completedAt: number; error: string },
  ): Promise<void> {
    return this.file.transaction(createState<TResult>, (state) => {
      const current = state.records[key]
      if (!current || current.fingerprint !== fingerprint || current.status !== 'pending') {
        throw new SecurityError('idempotency_state', 'Cannot settle an unclaimed execution')
      }
      state.records[key] = {
        ...settlement,
        fingerprint,
        createdAt: current.createdAt,
        expiresAt: current.expiresAt,
      }
      return { result: undefined, changed: true }
    })
  }

  prune(now: number): Promise<void> {
    return this.file.transaction(createState<TResult>, (state) => ({
      result: undefined,
      changed: pruneState(state, now),
    }))
  }
}
