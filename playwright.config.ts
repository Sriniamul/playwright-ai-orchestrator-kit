import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

type VideoMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
const videoMode = (process.env.PLAYWRIGHT_VIDEO ?? 'off') as VideoMode;

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
    screenshot: 'only-on-failure',
    video: videoMode,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
