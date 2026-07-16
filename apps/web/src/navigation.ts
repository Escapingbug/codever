import { onBackButtonPress } from '@tauri-apps/api/app'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { LocationQuery, RouteLocationRaw, RouteParamsGeneric, Router } from 'vue-router'

export function parentRoute(
  name: unknown,
  params: RouteParamsGeneric,
  query: LocationQuery = {},
): RouteLocationRaw | null {
  switch (name) {
    case 'session':
      return { name: 'project', params: { gatewayId: params.gatewayId, projectId: params.projectId } }
    case 'project':
      return { name: 'gateway', params: { gatewayId: params.gatewayId } }
    case 'gateway':
    case 'settings':
      return { name: 'gateways' }
    case 'onboarding':
      return query.add === '1' ? { name: 'login' } : null
    default:
      return null
  }
}

export async function navigateToParent(router: Router): Promise<boolean> {
  const route = router.currentRoute.value
  const target = parentRoute(route.name, route.params, route.query)
  if (target === null) return false
  await router.push(target)
  return true
}

export async function installAndroidBackHandler(router: Router): Promise<void> {
  if (!isTauri()) return

  let handlingBack = false
  await onBackButtonPress(() => {
    if (handlingBack) return
    handlingBack = true
    void navigateToParent(router)
      .then(async (handled) => {
        if (!handled) await invoke('plugin:app|exit')
      })
      .catch((error: unknown) => {
        console.error('Codever Android back navigation failed', error)
      })
      .finally(() => {
        handlingBack = false
      })
  })
}
