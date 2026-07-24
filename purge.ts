/// <reference types="node" />

/**
 * Purge script — removes everything that should NOT be committed to GitHub.
 *
 * Removes:
 *   - node_modules/          (reinstall with: npm install)
 *   - dist/                  (rebuilt with: npm run build)
 *   - tests/generated/       (AI-generated test files)
 *   - specs/*.md             (AI-generated plan files)
 *   - reports/               (orchestrator summary JSON)
 *   - logs/                  (execution logs)
 *   - exports/               (exported run artifacts)
 *   - test-results/          (Playwright failure artifacts)
 *   - playwright-report/     (Playwright HTML report)
 *   - playwright/.auth/      (saved auth state)
 *   - .playwright-mcp/       (MCP runtime cache)
 *   - *.log                  (root-level log files)
 *
 * Files NOT touched:
 *   - Source code (.ts files, tsconfig, package.json, etc.)
 *   - orchestrator.config.json
 *   - .github/ (agent definitions)
 *   - tests/ source (fixtures.ts, seed.spec.ts, helpers/)
 *   - .env  (kept — but already in .gitignore)
 *   - README.md, docs/, setup scripts
 *
 * Usage:
 *   npm run purge
 */

import fs = require("node:fs/promises");
import path = require("node:path");
import process = require("node:process");

async function remove(target: string, label: string): Promise<void> {
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat) {
    console.log(`  skip     ${label} (not found)`);
    return;
  }
  await fs.rm(target, { recursive: true, force: true });
  console.log(`  removed  ${label}`);
}

async function removeGlob(dir: string, pattern: RegExp, label: string): Promise<void> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const matches = entries.filter((e) => pattern.test(e));
  if (matches.length === 0) {
    console.log(`  skip     ${label} (none found)`);
    return;
  }
  for (const match of matches) {
    await fs.rm(path.join(dir, match), { recursive: true, force: true });
  }
  console.log(`  removed  ${label} (${matches.length} file${matches.length > 1 ? "s" : ""})`);
}

async function main(): Promise<void> {
  const root = process.cwd();

  console.log("\nPurging — removing all generated artifacts and dependencies...\n");

  // Generated test artifacts
  await remove(path.join(root, "tests", "generated"),  "tests/generated/");
  await remove(path.join(root, "reports"),             "reports/");
  await remove(path.join(root, "test-results"),        "test-results/");
  await remove(path.join(root, "playwright-report"),   "playwright-report/");
  await remove(path.join(root, "exports"),             "exports/");

  // AI-generated plan files (specs/*.md, excluding specs/README.md)
  await removeGlob(
    path.join(root, "specs"),
    /^plan-.+\.md$/i,
    "specs/plan-*.md",
  );

  // Logs
  await remove(path.join(root, "logs"),               "logs/");
  await removeGlob(root, /^.+\.log$/i,               "*.log (root level)");

  // Runtime caches
  await remove(path.join(root, "playwright", ".auth"), "playwright/.auth/");
  await remove(path.join(root, ".playwright-mcp"),     ".playwright-mcp/");

  // Build output and dependencies — removed last so the script runs to completion
  await remove(path.join(root, "dist"),               "dist/");
  await remove(path.join(root, "node_modules"),       "node_modules/");

  console.log("\nPurge complete.");
  console.log("To restore: run  npm install  then  npm run generate\n");
}

main().catch((err: unknown) => {
  console.error("Purge failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
