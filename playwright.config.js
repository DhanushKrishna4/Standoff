/* Playwright config for the live-rooms E2E (item 29). Spins up the real server
 * and drives two independent browser contexts. Run: npx playwright test */
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4321', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'node server.js',
    port: 4321,
    reuseExistingServer: false,
    timeout: 15000,
    env: { PORT: '4321', WS_GRACE_MS: '45000' },
  },
});
