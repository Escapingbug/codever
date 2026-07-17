const CACHE_VERSION = 'codever-shell-v1'
const SHELL_URLS = ['/manifest.webmanifest', '/icons/codever.svg', '/icons/codever-maskable.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(cacheApplicationShell())
})

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_VERSION)
  const response = await fetch('/')
  if (!response.ok) throw new Error(`Unable to cache Codever shell: ${response.status}`)

  await cache.put('/', response.clone())
  const html = await response.text()
  const builtAssets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith('/assets/'))
    .map((url) => url.pathname)

  await cache.addAll([...new Set([...SHELL_URLS, ...builtAssets])])
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_VERSION).then((cache) => cache.put('/', copy))
          return response
        })
        .catch(() => caches.match('/')),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy))
      }
      return response
    })),
  )
})
