import { canonicalJson, type CodeverCommand } from '@codever/protocol'
import { SecurityError } from './errors.js'

export interface ReplayClaim {
  key: string
  expiresAt: number
}

/**
 * Persistent implementations MUST atomically claim all keys or none of them.
 * They should enforce uniqueness in durable storage across gateway processes.
 */
export interface ReplayStore {
  claimAll(claims: readonly ReplayClaim[], now: number): Promise<boolean>
  prune(now: number): Promise<void>
}

export class ReplayGuard {
  constructor(private readonly store: ReplayStore) {}

  async claim(command: CodeverCommand, now = Date.now()): Promise<void> {
    if (command.expiresAt <= now) {
      throw new SecurityError('expired', 'Expired commands cannot enter the replay store')
    }
    const scope = canonicalJson([
      command.gatewayId,
      command.deviceId,
      command.conversationId,
    ])
    const accepted = await this.store.claimAll(
      [
        { key: `${scope}:nonce:${command.nonce}`, expiresAt: command.expiresAt },
        { key: `${scope}:command:${command.commandId}`, expiresAt: command.expiresAt },
      ],
      now,
    )
    if (!accepted) {
      throw new SecurityError('replay', 'Command nonce or command id has already been used')
    }
  }

  prune(now = Date.now()): Promise<void> {
    return this.store.prune(now)
  }
}

/** Test/development store. Production gateways should provide a durable store. */
export class InMemoryReplayStore implements ReplayStore {
  private readonly claims = new Map<string, number>()

  async claimAll(claims: readonly ReplayClaim[], now: number): Promise<boolean> {
    await this.prune(now)
    if (claims.some((claim) => this.claims.has(claim.key))) return false
    for (const claim of claims) this.claims.set(claim.key, claim.expiresAt)
    return true
  }

  async prune(now: number): Promise<void> {
    for (const [key, expiresAt] of this.claims) {
      if (expiresAt <= now) this.claims.delete(key)
    }
  }
}
