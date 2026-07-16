import { readonly, ref } from 'vue'

const updateAvailable = ref(false)
let waitingWorker: ServiceWorker | null = null

export const pwaUpdateAvailable = readonly(updateAvailable)

interface ServiceWorkerRegistrationOptions {
  enabled?: boolean
  container?: ServiceWorkerContainer
}

export async function registerCodeverServiceWorker(
  options: ServiceWorkerRegistrationOptions = {},
): Promise<ServiceWorkerRegistration | undefined> {
  const enabled = options.enabled ?? import.meta.env.PROD
  const container = options.container
    ?? ('serviceWorker' in navigator ? navigator.serviceWorker : undefined)
  if (!enabled || !container) return undefined

  let refreshing = false
  container.addEventListener('controllerchange', () => {
    if (refreshing) return
    refreshing = true
    window.location.reload()
  })

  const registration = await container.register('/service-worker.js', { scope: '/' })
  if (registration.waiting) markUpdate(registration.waiting)

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && container.controller) markUpdate(installing)
    })
  })

  window.setInterval(() => void registration.update(), 60 * 60 * 1000)
  return registration
}

export function applyPwaUpdate(): void {
  waitingWorker?.postMessage({ type: 'SKIP_WAITING' })
}

function markUpdate(worker: ServiceWorker): void {
  waitingWorker = worker
  updateAvailable.value = true
}
