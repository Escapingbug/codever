import { createMemoryHistory, createRouter, createWebHashHistory, type Router } from 'vue-router'
import GatewayListView from './views/GatewayListView.vue'
import GatewayView from './views/GatewayView.vue'
import ProjectView from './views/ProjectView.vue'
import SessionView from './views/SessionView.vue'
import OnboardingView from './views/OnboardingView.vue'
import LoginView from './views/LoginView.vue'
import SettingsView from './views/SettingsView.vue'
import { clientSession, type ClientSession } from './state/clientSession'

export function createCodeverRouter(session: ClientSession = clientSession): Router {
  const router = createRouter({
    history: window.location.hostname === 'tauri.localhost' ? createMemoryHistory() : createWebHashHistory(),
    routes: [
      { path: '/', redirect: '/gateways' },
      { path: '/onboarding', name: 'onboarding', component: OnboardingView },
      { path: '/login', name: 'login', component: LoginView },
      { path: '/settings', name: 'settings', component: SettingsView },
      { path: '/gateways', name: 'gateways', component: GatewayListView },
      { path: '/gateways/:gatewayId', name: 'gateway', component: GatewayView },
      { path: '/gateways/:gatewayId/projects/:projectId', name: 'project', component: ProjectView },
      {
        path: '/gateways/:gatewayId/projects/:projectId/sessions/:sessionId',
        name: 'session',
        component: SessionView,
      },
      { path: '/:pathMatch(.*)*', redirect: '/gateways' },
    ],
  })
  router.beforeEach(async (to) => {
    await session.initialize()
    const addingRelay = to.name === 'onboarding' && to.query.add === '1'
    if (!session.hasProfiles.value) return to.name === 'onboarding' ? true : { name: 'onboarding' }
    if (session.hasProfiles.value && to.name === 'onboarding' && !addingRelay) return session.isAuthenticated.value ? { name: 'gateways' } : { name: 'login' }
    if (!session.isAuthenticated.value && to.name !== 'login' && !addingRelay) return { name: 'login', query: { redirect: to.fullPath } }
    if (session.isAuthenticated.value && to.name === 'login') return { name: 'gateways' }
    return true
  })
  return router
}
