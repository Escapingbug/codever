import { createRouter, createWebHistory, type Router } from 'vue-router'
import GatewayListView from './views/GatewayListView.vue'
import GatewayView from './views/GatewayView.vue'
import ProjectView from './views/ProjectView.vue'
import SessionView from './views/SessionView.vue'

export function createCodeverRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', redirect: '/gateways' },
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
}
