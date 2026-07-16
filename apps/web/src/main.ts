import { createApp } from 'vue'
import App from './App.vue'
import { createCodeverRouter } from './router'
import { relayApiKey, RelayApi } from './api/relayApi'
import { registerCodeverServiceWorker } from './pwa/serviceWorker'
import './styles.css'

const apiBaseUrl = window.__CODEVER_CONFIG__?.apiBaseUrl
  ?? import.meta.env.VITE_RELAY_API_URL
  ?? window.location.origin

const app = createApp(App)
app.provide(relayApiKey, new RelayApi({ baseUrl: apiBaseUrl }))
app.use(createCodeverRouter())
app.mount('#app')

void registerCodeverServiceWorker().catch((error: unknown) => {
  console.warn('Codever service worker registration failed', error)
})
