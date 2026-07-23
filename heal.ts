/// <reference types="node" />

/**
 * Standalone heal runner — skips planning and generation entirely.
 * Runs the existing generated tests and invokes the healer agent for any failures.
 *
 * Usage:
 *   npm run heal                  # heal all tests/generated
 *   npm run heal -- accounts      # heal only tests/generated/accounts
 *   npm run heal -- accounts dashboard  # heal multiple sub-folders
 */

import process = require("node:process");
import "dotenv/config";
import { PlaywrightOrchestrator } from "./orchestrator.js";

async function main(): Promise<void> {
  const orchestrator = new PlaywrightOrchestrator();
  await orchestrator.loadConfig();
  await orchestrator.validateForHeal();

  // Optional sub-folder filter passed as CLI args, e.g. "accounts" or "accounts dashboard"
  const subFolders = process.argv.slice(2).filter(Boolean);

  let result = subFolders.length > 0
    ? await orchestrator.runTestsForFiles(
        subFolders.map((s) => `tests/generated/${s}`),
      )
    : await orchestrator.runTests();

  if (result.exitCode === 0) {
    console.log("\nAll tests passed — nothing to heal.");
    return;
  }

  console.log(`\nTests failed (exit ${result.exitCode}). Starting healer…`);

  result = subFolders.length > 0
    ? await orchestrator.runHealerLoop(
        result,
        subFolders.map((s) => `tests/generated/${s}`),
      )
    : await orchestrator.runHealerLoop(result);

  if (result.exitCode !== 0) {
    console.error("\nHealer exhausted max attempts — some tests still fail.");
    process.exitCode = 1;
  } else {
    console.log("\nAll tests pass after healing.");
  }
}

void main().catch((err: unknown) => {
  console.error("Heal runner error:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
