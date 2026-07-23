/**
 * Shared Playwright fixtures.
 * Import { test, expect } from here instead of '@playwright/test'
 * to get a page that is automatically logged in before each test.
 */
import { test as base, expect } from '@playwright/test';
import { login } from './helpers/login';

export const test = base.extend({
  page: async ({ page }, use) => {
    // Log in using the shared seed login flow before every test
    await login(page);
    // Hand the authenticated page to the test
    await use(page);
  },
});

export { expect };
