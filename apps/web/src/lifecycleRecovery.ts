export function installLifecycleRecovery(options: {
  document: Document
  window: Window
  suspend: () => void
  resume: () => void | Promise<void>
  minimumHiddenMs?: number
}): () => void {
  let hiddenAt: number | undefined
  const minimumHiddenMs = options.minimumHiddenMs ?? 1_000
  const recover = () => { void options.resume() }
  const visibility = () => {
    if (options.document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      options.suspend()
      return
    }
    if (hiddenAt === undefined || Date.now() - hiddenAt >= minimumHiddenMs) recover()
    hiddenAt = undefined
  }
  options.document.addEventListener('visibilitychange', visibility)
  options.window.addEventListener('pageshow', recover)
  options.window.addEventListener('online', recover)
  return () => {
    options.document.removeEventListener('visibilitychange', visibility)
    options.window.removeEventListener('pageshow', recover)
    options.window.removeEventListener('online', recover)
  }
}
