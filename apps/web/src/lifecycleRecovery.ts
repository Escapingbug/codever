export function installLifecycleRecovery(options: {
  document: Document
  window: Window
  suspend: () => void
  resume: () => void | Promise<void>
  minimumHiddenMs?: number
}): () => void {
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined
  let suspended = false
  const minimumHiddenMs = options.minimumHiddenMs ?? 1_000
  const recover = () => {
    if (hiddenTimer) clearTimeout(hiddenTimer)
    hiddenTimer = undefined
    if (!suspended) return
    suspended = false
    void options.resume()
  }
  const visibility = () => {
    if (options.document.visibilityState === 'hidden') {
      if (hiddenTimer) clearTimeout(hiddenTimer)
      hiddenTimer = setTimeout(() => {
        hiddenTimer = undefined
        if (options.document.visibilityState !== 'hidden' || suspended) return
        suspended = true
        options.suspend()
      }, minimumHiddenMs)
      return
    }
    recover()
  }
  options.document.addEventListener('visibilitychange', visibility)
  options.window.addEventListener('pageshow', recover)
  options.window.addEventListener('online', recover)
  return () => {
    if (hiddenTimer) clearTimeout(hiddenTimer)
    options.document.removeEventListener('visibilitychange', visibility)
    options.window.removeEventListener('pageshow', recover)
    options.window.removeEventListener('online', recover)
  }
}
