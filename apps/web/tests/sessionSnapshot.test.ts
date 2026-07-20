import type { CodeverSession } from '@codever/protocol'
import { describe, expect, it } from 'vitest'
import { mergeSessionSnapshot } from '../src/state/sessionSnapshot'

describe('Session snapshot monotonicity', () => {
  it('does not let an older Inventory snapshot roll querying back to idle', () => {
    const current = session('querying', 12, '2026-07-20T08:00:12.000Z')
    const stale = session('idle', 10, '2026-07-20T08:00:10.000Z')

    expect(mergeSessionSnapshot(current, stale)).toMatchObject({ state: 'querying', lastEventSeq: 12 })
  })

  it('accepts a terminal state with a newer journal sequence', () => {
    const current = session('querying', 12, '2026-07-20T08:00:12.000Z')
    const terminal = session('idle', 15, '2026-07-20T08:00:15.000Z')

    expect(mergeSessionSnapshot(current, terminal)).toMatchObject({ state: 'idle', lastEventSeq: 15 })
  })
})

function session(state: CodeverSession['state'], lastEventSeq: number, updatedAt: string): CodeverSession {
  return {
    id: 'session-1', gatewayId: 'gateway-1', projectId: 'project-1', provider: 'codex',
    state, lastEventSeq, updatedAt, createdAt: '2026-07-20T08:00:00.000Z', config: {},
  }
}
