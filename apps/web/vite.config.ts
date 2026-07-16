import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'tauri-classic-bootstrap',
      enforce: 'post',
      transformIndexHtml(html) {
        return html.replace('<script type="module" crossorigin', '<script defer')
      },
    },
  ],
  server: { port: 4173 },
})
