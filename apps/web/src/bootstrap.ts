function showStartupError(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const app = document.getElementById('app')
  if (app) {
    app.innerHTML = ''
    const panel = document.createElement('div')
    panel.style.cssText = 'min-height:100vh;padding:32px;color:#f3f5ee;background:#11130f;font:16px/1.5 system-ui;white-space:pre-wrap'
    panel.textContent = `Codever could not start.\n\n${message}\n\nRestart the app. If this continues, send this message to the developer.`
    app.append(panel)
  }
  console.error('Codever startup failed', error)
}

window.addEventListener('error', event => showStartupError(event.error ?? event.message))
window.addEventListener('unhandledrejection', event => showStartupError(event.reason))

async function bootstrap(): Promise<void> {
  if (import.meta.env.MODE === 'native-e2e') {
    localStorage.clear()
    await deleteDatabase('codever-client-cache')
    await import('./e2e/main')
    return
  }
  const { startCodever } = await import('./main')
  await startCodever()
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise(resolve => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

void bootstrap().catch(showStartupError)
