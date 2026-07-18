import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

const installedEdge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  ?? (existsSync(installedEdge) ? installedEdge : undefined)

export default defineConfig({
  testDir: './ui-e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173/e2e.html',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{
    name: 'mobile-chromium',
    use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 } },
  }],
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/e2e.html',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
