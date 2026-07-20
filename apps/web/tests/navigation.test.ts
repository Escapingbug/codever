import type { Router } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  isTauri: true,
  onBackButtonPress: vi.fn(async () => undefined),
  invoke: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/app', () => ({
  onBackButtonPress: tauri.onBackButtonPress,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  isTauri: () => tauri.isTauri,
}))

import { installAndroidBackHandler, navigateToParent, parentRoute } from '../src/navigation'

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value })
}

describe('client navigation', () => {
  it('maps nested business pages to their parent', () => {
    expect(parentRoute('session', { gatewayId: 'gateway-1', projectId: 'project-1', provider: 'codex', sessionId: 'session-1' }))
      .toEqual({ name: 'project', params: { gatewayId: 'gateway-1', projectId: 'project-1' } })
    expect(parentRoute('project', { gatewayId: 'gateway-1', projectId: 'project-1' }))
      .toEqual({ name: 'projects' })
    expect(parentRoute('gateway', { gatewayId: 'gateway-1' })).toEqual({ name: 'machines' })
    expect(parentRoute('onboarding', {}, { add: '1' })).toEqual({ name: 'login' })
    expect(parentRoute('login', {})).toEqual({ name: 'onboarding', query: { edit: '1' } })
  })

  it('leaves root pages for the native app to close', () => {
    expect(parentRoute('projects', {})).toBeNull()
    expect(parentRoute('machines', {})).toBeNull()
    expect(parentRoute('settings', {})).toBeNull()
    expect(parentRoute('onboarding', {})).toBeNull()
  })

  it('navigates to a business parent when one exists', async () => {
    const push = vi.fn().mockResolvedValue(undefined)
    const router = {
      currentRoute: { value: { name: 'project', params: { gatewayId: 'gateway-1', projectId: 'project-1' } } },
      push,
    }

    await expect(navigateToParent(router as never)).resolves.toBe(true)
    expect(push).toHaveBeenCalledWith({ name: 'projects' })
  })
})

describe('Android back navigation', () => {
  beforeEach(() => {
    tauri.isTauri = true
    tauri.onBackButtonPress.mockClear()
    tauri.invoke.mockClear()
  })

  it('does not register the Android listener in the desktop shell', async () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

    await installAndroidBackHandler({} as Router)

    expect(tauri.onBackButtonPress).not.toHaveBeenCalled()
  })

  it('registers the listener in the Android shell', async () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36')

    await installAndroidBackHandler({} as Router)

    expect(tauri.onBackButtonPress).toHaveBeenCalledOnce()
    expect(tauri.onBackButtonPress).toHaveBeenCalledWith(expect.any(Function))
  })
})
