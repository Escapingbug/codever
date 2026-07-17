import { describe, expect, it, vi } from 'vitest'
import { navigateToParent, parentRoute } from '../src/navigation'

describe('client navigation', () => {
  it('maps nested business pages to their parent', () => {
    expect(parentRoute('session', { gatewayId: 'gateway-1', projectId: 'project-1', provider: 'codex', sessionId: 'session-1' }))
      .toEqual({ name: 'project', params: { gatewayId: 'gateway-1', projectId: 'project-1' } })
    expect(parentRoute('project', { gatewayId: 'gateway-1', projectId: 'project-1' }))
      .toEqual({ name: 'projects' })
    expect(parentRoute('gateway', { gatewayId: 'gateway-1' })).toEqual({ name: 'projects' })
    expect(parentRoute('settings', {})).toEqual({ name: 'projects' })
    expect(parentRoute('onboarding', {}, { add: '1' })).toEqual({ name: 'login' })
  })

  it('leaves root pages for the native app to close', () => {
    expect(parentRoute('projects', {})).toBeNull()
    expect(parentRoute('login', {})).toBeNull()
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
