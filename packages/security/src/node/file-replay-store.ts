import type { ReplayClaim, ReplayStore } from '../replay.js'
import { AtomicJsonFile, type FileStoreOptions } from './atomic-json-file.js'

interface ReplayFileState {
  version: 1
  claims: Record<string, number>
}

function createState(): ReplayFileState {
  return { version: 1, claims: {} }
}

function pruneState(state: ReplayFileState, now: number): boolean {
  let changed = false
  for (const [key, expiresAt] of Object.entries(state.claims)) {
    if (expiresAt <= now) {
      delete state.claims[key]
      changed = true
    }
  }
  return changed
}

/**
 * Durable replay protection for a single gateway host.
 *
 * Multiple Node processes may use the same path: claimAll is serialized by an
 * atomic lock directory and commits all keys in one file transaction.
 */
export class FileReplayStore implements ReplayStore {
  private readonly file: AtomicJsonFile<ReplayFileState>

  constructor(path: string, options: FileStoreOptions = {}) {
    this.file = new AtomicJsonFile(path, options)
  }

  claimAll(claims: readonly ReplayClaim[], now: number): Promise<boolean> {
    return this.file.transaction(createState, (state) => {
      const pruned = pruneState(state, now)
      if (claims.some((claim) => Object.hasOwn(state.claims, claim.key))) {
        return { result: false, changed: pruned }
      }
      for (const claim of claims) {
        Object.defineProperty(state.claims, claim.key, {
          value: claim.expiresAt,
          configurable: true,
          enumerable: true,
          writable: true,
        })
      }
      return { result: true, changed: claims.length > 0 || pruned }
    })
  }

  prune(now: number): Promise<void> {
    return this.file.transaction(createState, (state) => ({
      result: undefined,
      changed: pruneState(state, now),
    }))
  }
}
