import { afterEach, describe, expect, it, vi } from 'vitest'
import { installLifecycleRecovery } from '../src/lifecycleRecovery'

describe('mobile lifecycle recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('marks a hidden app stale and reconnects durable consumers when it resumes', () => {
    vi.useFakeTimers()
    let state: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state)
    const suspend = vi.fn()
    const resume = vi.fn()
    const remove = installLifecycleRecovery({ document, window, suspend, resume, minimumHiddenMs: 0 })

    state = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    vi.runAllTimers()
    state = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))

    expect(suspend).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
    remove()
  })

  it('does not leave the app reconnecting after a brief visibility transition', () => {
    vi.useFakeTimers()
    let state: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state)
    const suspend = vi.fn()
    const resume = vi.fn()
    const remove = installLifecycleRecovery({ document, window, suspend, resume, minimumHiddenMs: 1_000 })

    state = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(250)
    state = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    vi.runAllTimers()

    expect(suspend).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    remove()
  })
})
