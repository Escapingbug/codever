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

void startCodever().catch(showStartupError)
import { startCodever } from './main'
