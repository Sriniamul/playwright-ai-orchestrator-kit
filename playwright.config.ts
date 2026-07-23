import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,                          // limit parallel logins to avoid auth race conditions
  timeout: 60_000,                     // per-test timeout (login + test body)
  expect: { timeout: 10_000 },         // assertion timeout
  reporter: [
    ['line'],
    ['html', { open: 'never' }],
  ],
  use: {
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
