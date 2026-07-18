import { afterEach, describe, expect, it, vi } from 'vitest'
import { installLifecycleRecovery } from '../src/lifecycleRecovery'

describe('mobile lifecycle recovery', () => {
  afterEach(() => vi.restoreAllMocks())

  it('marks a hidden app stale and reconnects durable consumers when it resumes', () => {
    let state: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state)
    const suspend = vi.fn()
    const resume = vi.fn()
    const remove = installLifecycleRecovery({ document, window, suspend, resume, minimumHiddenMs: 0 })

    state = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    state = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))

    expect(suspend).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
    remove()
  })
})
