import type { Page } from '@playwright/test';

const APP_URL      = process.env.APP_URL      ?? 'https://localhost1';
const APP_USERNAME = process.env.APP_USERNAME ?? '';
const APP_PASSWORD = process.env.APP_PASSWORD ?? '';

/**
 * Reusable login helper — call this from any test's beforeEach or directly.
 * After login the browser is at /dashboard/start (authenticated).
 *
 * Handles intermediate screens that appear between login and the dashboard:
 *   - MFA setup dialog  (/auth/topt/...)   → clicks Skip
 *   - Intro / tour page (any URL)          → clicks Skip link
 * Retries up to 5 navigation steps before giving up.
 */
export async function login(page: Page): Promise<void> {
  await page.goto(APP_URL);
  await page.getByRole('textbox', { name: 'Username@Domain or Domain\\User' }).fill(APP_USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(APP_PASSWORD);
  await page.getByRole('button', { name: 'Login' }).click();

  // Walk through intermediate screens (MFA, tour) until we reach the dashboard.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Wait for any pending navigation to settle before inspecting the page.
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
    } catch {
      // Page may have reloaded; continue and re-check the URL.
    }

    const url = page.url();

    // Successfully authenticated — stop.
    if (url.includes('/dashboard/')) break;

    // MFA setup screen — click its Skip link (href contains "skipsetup").
    const mfaSkip = page.getByRole('link', { name: 'Skip' }).filter({
      has: page.locator('[href*="skipsetup"]'),
    });
    if (await mfaSkip.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await mfaSkip.click();
      continue;
    }

    // Any other Skip link (intro tour, onboarding, etc.)
    const anySkip = page.getByRole('link', { name: 'Skip' });
    if (await anySkip.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await anySkip.click();
      continue;
    }

    // No skip button and not on dashboard — wait a moment and retry.
    await page.waitForTimeout(1_000);
  }

  await page.waitForURL('**/dashboard/**', { timeout: 30_000 });
}
