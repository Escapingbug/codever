import { createMemoryHistory, createRouter, createWebHashHistory, type Router } from 'vue-router'
import GatewayListView from './views/GatewayListView.vue'
import GatewayView from './views/GatewayView.vue'
import MachineListView from './views/MachineListView.vue'
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
      { path: '/', redirect: '/projects' },
      { path: '/onboarding', name: 'onboarding', component: OnboardingView },
      { path: '/login', name: 'login', component: LoginView },
      { path: '/settings', name: 'settings', component: SettingsView },
      { path: '/projects', name: 'projects', component: GatewayListView },
      { path: '/machines', name: 'machines', component: MachineListView },
      { path: '/gateways/:gatewayId', name: 'gateway', component: GatewayView },
      { path: '/projects/:gatewayId/:projectId', name: 'project', component: ProjectView },
      {
        path: '/projects/:gatewayId/:projectId/sessions/:sessionId',
        name: 'session',
        component: SessionView,
      },
      { path: '/:pathMatch(.*)*', redirect: '/projects' },
    ],
  })
  router.beforeEach(async (to) => {
    await session.initialize()
    if (!session.hasProfiles.value) return to.name === 'onboarding' ? true : { name: 'onboarding' }
    if (session.hasProfiles.value && to.name === 'onboarding') return session.isAuthenticated.value ? { name: 'projects' } : { name: 'login' }
    if (!session.isAuthenticated.value && to.name !== 'login') return { name: 'login', query: { redirect: to.fullPath } }
    if (session.isAuthenticated.value && to.name === 'login') return { name: 'projects' }
    return true
  })
  return router
}
