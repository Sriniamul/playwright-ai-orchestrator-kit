/// <reference types="node" />

/**
 * Status reporter — shows completion state of every module without running anything.
 *
 * Usage:
 *   npm run status
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
  reportsFolder: string;
}
interface ModuleResult {
  planFile: string;
  generatedSpecs: number;
  status: string;
  healAttempts: number;
}
interface RunSummary {
  startedAt?: string;
  finishedAt?: string;
  successful?: boolean;
  error?: string;
  testRuns?: number;
  healAttempts?: number;
  modules?: ModuleResult[];
}

/** Count generated spec files whose first line references the given plan file. */
async function countSpecsForPlan(specRoot: string, planFile: string): Promise<number> {
  let count = 0;
  const normalized = planFile.replace(/\\/g, '/');
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
        const firstLine = await fs.readFile(path.join(dir, entry.name), 'utf8')
          .then((c) => c.split('\n')[0] ?? '')
          .catch(() => '');
        const match = /^\/\/ spec:\s*(.+)$/.exec(firstLine);
        if (match?.[1]?.trim().replace(/\\/g, '/') === normalized) count++;
      }
    }
  };
  await walk(specRoot).catch(() => { /* folder may not exist yet */ });
  return count;
}

async function main(): Promise<void> {
  const root = process.cwd();

  let config: OrchestratorConfig;
  try {
    config = JSON.parse(
      await fs.readFile(path.join(root, 'orchestrator.config.json'), 'utf8'),
    ) as OrchestratorConfig;
  } catch {
    console.error('Cannot read orchestrator.config.json');
    process.exitCode = 1;
    return;
  }

  const specsFolder = (config as unknown as Record<string, unknown>).specsFolder as string | undefined ?? 'specs';
  const targets: PlanTarget[] = config.planFiles?.length
    ? config.planFiles
    : [{ file: config.planFile ?? `${specsFolder}/plan.md`, scope: '' }];

  // Load last run summary (may not exist on first run)
  let summary: RunSummary | undefined;
  try {
    summary = JSON.parse(
      await fs.readFile(path.join(root, config.reportsFolder, 'orchestrator-summary.json'), 'utf8'),
    ) as RunSummary;
  } catch { /* no summary yet */ }

  const specRoot = path.join(root, config.generatedTestsFolder);
  const W = 80;
  const SEP = '─'.repeat(W);

  console.log(`\n${SEP}`);
  console.log('  ORCHESTRATOR STATUS');

  if (summary?.startedAt) {
    const started  = new Date(summary.startedAt).toLocaleString();
    const finished = summary.finishedAt
      ? new Date(summary.finishedAt).toLocaleString()
      : 'in progress';
    const overall  = summary.successful === true
      ? '✓ PASSED'
      : summary.error
        ? '✗ FAILED'
        : '~ INCOMPLETE';
    console.log(`  Last run : ${started} → ${finished}  [${overall}]`);
    if (summary.testRuns)     console.log(`  Test runs: ${summary.testRuns}   Heal attempts: ${summary.healAttempts ?? 0}`);
    if (summary.error)        console.log(`  Error    : ${summary.error}`);
  } else {
    console.log('  No previous run found.');
  }

  console.log(SEP);
  console.log(
    `  ${'#'.padEnd(3)} ${'Module'.padEnd(24)} ${'Planned'.padEnd(9)} ${'Specs'.padEnd(7)} ${'Status'.padEnd(11)} Heals`,
  );
  console.log(SEP);

  for (const [idx, target] of targets.entries()) {
    const planKey  = target.file.replace(/\\/g, '/');
    const name     = path.basename(target.file, '.md').padEnd(24);
    const num      = `[${idx + 1}]`.padEnd(3);

    // Plan file on disk?
    const planned  = await fs.stat(path.join(root, target.file))
      .then((s) => s.isFile()).catch(() => false);
    const planMark = planned ? '✓ yes  ' : '✗ no   ';

    // Generated spec count (from disk, fresh truth)
    const diskSpecs = await countSpecsForPlan(specRoot, planKey);
    const specStr  = diskSpecs > 0 ? String(diskSpecs).padEnd(7) : '─'.padEnd(7);

    // Status from last summary (if recorded) or inferred
    const modResult = summary?.modules?.find((m) => m.planFile.replace(/\\/g, '/') === planKey);
    let   status: string;
    if (modResult) {
      status = modResult.status;
    } else if (diskSpecs > 0) {
      status = 'generated';
    } else if (planned) {
      status = 'planned';
    } else {
      status = 'pending';
    }

    const icon   = status === 'passed' ? '✓' : status === 'failed' ? '✗' : status === 'skipped' ? '-' : ' ';
    const heals  = modResult?.healAttempts ? String(modResult.healAttempts) : '─';
    console.log(`  ${num} ${name} ${planMark} ${specStr} ${icon} ${status.padEnd(10)} ${heals}`);
  }

  console.log(SEP);
  console.log('');

  console.log('  Next steps:');
  console.log('    npm run status          — refresh this view');
  console.log('    npm run generate        — full fresh run (wipes everything)');
  console.log('    npm run resume          — continue from last incomplete module');
  console.log('    npm run heal            — re-heal all generated tests');
  console.log('    npm run heal -- <mod>   — re-heal a specific module (e.g. accounts)');
  console.log('    npm run cleanup         — wipe all generated artifacts');
  console.log('');
}

void main().catch((err: unknown) => {
  console.error('Status error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
