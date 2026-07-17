import { test, expect } from '@playwright/test';

test.describe('Generator seed', () => {
  test('opens the target application', async ({ page }) => {
    await page.goto(process.env.APP_URL ?? 'http://localhost:4200');
    await expect(page).toHaveURL(/.+/);
  });
});
