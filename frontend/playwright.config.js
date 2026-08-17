import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8002',
    channel: 'chrome',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'cd .. && BBP_PORT=8002 BBP_DEBUG=1 .venv/bin/python3 app.py',
    url: 'http://127.0.0.1:8002/health',
    reuseExistingServer: true,
    timeout: 15_000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
})

