import { test } from '@playwright/test';
import { login } from './helpers/login';

test.describe('Generator seed', () => {
  test('opens the target application', async ({ page }) => {
    await login(page);
  });
});