import { beforeEach, describe, expect, it, vi } from 'vitest'
import manifestSource from '../public/manifest.webmanifest?raw'

describe('PWA service worker registration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('does not register in development builds', async () => {
    const register = vi.fn()
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register },
    })

    const { registerCodeverServiceWorker } = await import('../src/pwa/serviceWorker')
    expect(await registerCodeverServiceWorker()).toBeUndefined()
    expect(register).not.toHaveBeenCalled()
  })

  it('registers the root-scoped worker when enabled', async () => {
    const registration = Object.assign(new EventTarget(), {
      installing: null,
      waiting: null,
      update: vi.fn().mockResolvedValue(undefined),
    }) as unknown as ServiceWorkerRegistration
    const container = Object.assign(new EventTarget(), {
      controller: null,
      register: vi.fn().mockResolvedValue(registration),
    }) as unknown as ServiceWorkerContainer
    vi.spyOn(window, 'setInterval')
      .mockReturnValue({} as ReturnType<typeof window.setInterval>)

    const { registerCodeverServiceWorker } = await import('../src/pwa/serviceWorker')
    expect(await registerCodeverServiceWorker({ enabled: true, container })).toBe(registration)
    expect(container.register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' })
  })

  it('ships a standalone manifest with regular and maskable icons', () => {
    const manifest = JSON.parse(manifestSource) as {
      display: string
      icons: Array<{ purpose: string }>
    }

    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.map((icon) => icon.purpose)).toEqual(['any', 'maskable'])
  })
})
