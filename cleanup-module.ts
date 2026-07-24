/// <reference types="node" />

/**
 * Per-module cleanup script — removes generated artifacts for a single plan module.
 *
 * Removes:
 *   - The plan .md file for the matched module (e.g. specs/plan-dashboard.md)
 *   - The generated specs subfolder for the matched module (e.g. tests/generated/dashboard/)
 *
 * Everything else is left untouched: other modules' tests, reports, playwright-report, etc.
 *
 * Usage:
 *   npm run cleanup:module -- <slug>
 *
 * Examples:
 *   npm run cleanup:module -- dashboard
 *   npm run cleanup:module -- recent-changes-last-24-hours
 *
 * The slug is matched case-insensitively against the basename of each planFiles entry
 * (e.g. "dashboard" matches "specs/plan-dashboard.md").
 */

import fs = require("node:fs/promises");
import path = require("node:path");
import process = require("node:process");
import "dotenv/config";

interface PlanTarget { file: string; scope: string; }
interface OrchestratorConfig {
  planFile?: string;
  planFiles?: PlanTarget[];
  generatedTestsFolder: string;
}

async function remove(target: string, label: string): Promise<void> {
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat) {
    console.log(`  skip     ${label} (not found)`);
    return;
  }
  await fs.rm(target, { recursive: true, force: true });
  console.log(`  removed  ${label}`);
}

async function main(): Promise<void> {
  const slug = process.argv[process.argv.indexOf("--") + 1]?.toLowerCase().trim()
    ?? process.argv.slice(2).find((a) => !a.startsWith("-"))?.toLowerCase().trim();

  if (!slug) {
    console.error("\nUsage: npm run cleanup:module -- <slug>");
    console.error("Example: npm run cleanup:module -- dashboard\n");
    process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const configPath = path.join(root, "orchestrator.config.json");

  let config: OrchestratorConfig;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as OrchestratorConfig;
  } catch {
    console.error(`Cannot read orchestrator.config.json at ${configPath}`);
    process.exitCode = 1;
    return;
  }

  const allPlanFiles: string[] = [
    ...(config.planFiles?.map((p) => p.file) ?? []),
    ...(config.planFile ? [config.planFile] : []),
  ];

  // Find the plan file whose basename (without plan- prefix and .md suffix) matches the slug.
  const matched = allPlanFiles.find((f) => {
    const base = path.basename(f, ".md").toLowerCase().replace(/^plan-/, "");
    return base.includes(slug) || slug.includes(base);
  });

  if (!matched) {
    const available = allPlanFiles
      .map((f) => path.basename(f, ".md").replace(/^plan-/, ""))
      .join(", ");
    console.error(`\nNo plan found matching "${slug}".`);
    console.error(`Available slugs: ${available}\n`);
    process.exitCode = 1;
    return;
  }

  const moduleSlug = path.basename(matched, ".md").toLowerCase().replace(/^plan-/, "");
  console.log(`\nCleaning module: ${moduleSlug}  (matched: ${matched})\n`);

  // Remove the plan file.
  await remove(path.resolve(root, matched), `plan   ${matched}`);

  // Remove the generated specs subfolder.
  const specsFolder = path.resolve(root, config.generatedTestsFolder, moduleSlug);
  await remove(specsFolder, `specs  ${config.generatedTestsFolder}/${moduleSlug}/`);

  console.log(`\nDone. Other modules are untouched.\n`);
}

main().catch((err) => {
  console.error("cleanup-module error:", err);
  process.exitCode = 1;
});
