// @vitest-environment jsdom
import { isProxy, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { readCached, toCacheSnapshot, writeCached } from '../src/state/localCache'

describe('local cache snapshots', () => {
  it('turns nested Vue proxies into values accepted by structured clone', () => {
    const source = reactive([{ id: 'session-1', config: { model: 'codex' } }])

    const snapshot = toCacheSnapshot(source) as typeof source

    expect(isProxy(snapshot)).toBe(false)
    expect(isProxy(snapshot[0]?.config)).toBe(false)
    expect(() => structuredClone(snapshot)).not.toThrow()
    expect(snapshot).toEqual(source)
  })

  it('keeps an immutable plain snapshot in the memory cache', async () => {
    const key = `proxy-cache-${crypto.randomUUID()}`
    const source = reactive({ state: 'idle', nested: { count: 1 } })

    writeCached(key, source)
    source.state = 'querying'
    source.nested.count = 2

    expect(await readCached(key)).toEqual({ state: 'idle', nested: { count: 1 } })
  })
})
