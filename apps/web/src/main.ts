import { createApp } from 'vue'
import App from './App.vue'
import { createCodeverRouter } from './router'
import { codeverApiKey } from './api/codeverApi'
import { clientSession } from './state/clientSession'
import { registerCodeverServiceWorker } from './pwa/serviceWorker'
import { installAndroidBackHandler } from './navigation'
import './styles.css'

export async function startCodever(): Promise<void> {
  await clientSession.initialize()
  const app = createApp(App)
  app.provide(codeverApiKey, clientSession.api)
  const router = createCodeverRouter(clientSession)
  app.use(router)
  if (window.location.hostname === 'tauri.localhost') await router.push('/')
  await installAndroidBackHandler(router)
  app.mount('#app')

  void registerCodeverServiceWorker().catch((error: unknown) => {
    console.warn('Codever service worker registration failed', error)
  })
}
