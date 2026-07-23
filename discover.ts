/// <reference types="node" />

/**
 * Discover runner — navigates the live application and auto-populates planFiles
 * in orchestrator.config.json without running the planner or generator.
 *
 * Use this when planFiles is empty and you want to preview / seed the module list
 * before committing to a full orchestration run.
 *
 * Usage:
 *   npm run discover
 *
 * After running, review and edit the 'planFiles' scopes in orchestrator.config.json,
 * then kick off the full pipeline with:
 *   npm run generate
 */

import "dotenv/config";
import { PlaywrightOrchestrator } from "./orchestrator.js";

void (async () => {
  const orchestrator = new PlaywrightOrchestrator();
  await orchestrator.loadConfig();
  await orchestrator.discover();
})().catch((err: unknown) => {
  console.error("Discover error:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
