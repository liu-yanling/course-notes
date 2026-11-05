import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:43119'
const channel = process.env.PLAYWRIGHT_CHANNEL || ''

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    trace: 'off',
    ...(channel ? { channel } : {}),
  },
  webServer: {
    command: 'rm -rf .tmp/e2e-data && COURSE_NOTES_DATA_DIR=.tmp/e2e-data node server/index.mjs --port 43119 --no-open',
    url: baseURL + '/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
