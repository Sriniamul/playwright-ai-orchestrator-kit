/// <reference types="node" />

import fs = require("node:fs/promises");
import path = require("node:path");
import { spawn } from "node:child_process";
import process = require("node:process");
import "dotenv/config";
import { CopilotClient } from "./tools/copilot-client.js";
import { formatProjectSummary, scanProject } from "./tools/project.js";
import { loadAgentDefinition, type AgentDefinition } from "./tools/agent-definition.js";

export interface PlanTarget {
  file: string;
  scope: string;
}

export interface OrchestratorConfig {
  projectFolder?: string;
  appUrl: string;
  /**
   * Path to the Playwright auth/seed setup file (e.g. tests/seed.spec.ts).
   * Optional — omit entirely for apps that require no authentication.
   * When omitted, generated tests import directly from '@playwright/test'.
   */
  seedFile?: string;
  /** Single-module fallback. Ignored when planFiles is provided. */
  planFile?: string;
  planFiles?: PlanTarget[];
  generatedTestsFolder: string;
  reportsFolder: string;
  maxHealAttempts: number;
  testCommand: string;
  /**
   * Import path written into every generated test for { test, expect }.
   * Defaults to '../../fixtures' (2-level subfolder inside generatedTestsFolder).
   * Override if your fixtures file lives at a different relative depth.
   */
  fixturesImport?: string;
  /**
   * Number of Playwright --retries to attempt before invoking the AI healer.
   * Filters out flaky tests cheaply — healer only runs if failures persist after retries.
   * Defaults to 0 (disabled).
   */
  retryBeforeHeal?: number;
  /**
   * Maximum milliseconds allowed for one module’s full pipeline (plan + generate + test + heal).
   * When exceeded the module is marked failed and the orchestrator moves on to the next module
   * immediately — no more 40-min black-box hangs that kill the entire run.
   * Defaults to undefined (no per-module cap; the Copilot CLI’s own 40-min limit still applies
   * per individual agent call). Example: 1500000 = 25 minutes per module.
   */
  moduleTimeoutMs?: number;
  /**
   * Folder containing the agent .md definition files.
   * Defaults to ".github/agents" (GitHub Copilot standard location).
   * Override if your agent files live elsewhere in the repo.
   */
  agentsFolder?: string;
  /**
   * Folder where plan files are written during auto-discovery and where planFile paths are resolved.
   * Defaults to "specs".
   */
  specsFolder?: string;
  /**
   * Maximum milliseconds for a single Copilot CLI agent call (planner, generator, or healer).
   * Defaults to 2 400 000 ms (40 minutes) — the Copilot CLI’s own limit.
   * Lower this if you want individual agent calls to time-out sooner.
   * Example: 900000 = 15 minutes per agent call.
   */
  agentTimeoutMs?: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

interface ModuleResult {
  planFile: string;
  generatedSpecs: number;
  status: 'passed' | 'failed' | 'skipped';
  healAttempts: number;
}

interface RunSummary {
  startedAt: string;
  finishedAt?: string;
  planned: boolean;
  generatedFiles: string[];
  testRuns: number;
  healAttempts: number;
  successful: boolean;
  lastTestOutput?: string;
  error?: string;
  modules: ModuleResult[];
}

const REQUIRED_CONFIG_KEYS: ReadonlyArray<keyof OrchestratorConfig> = [
  "appUrl",
  "generatedTestsFolder",
  "reportsFolder",
  "maxHealAttempts",
  "testCommand",
];

export class PlaywrightOrchestrator {
  private config!: OrchestratorConfig;
  private readonly orchestratorRoot: string;
  private projectRoot = "";
  private projectSummary = "";
  private moduleRoutes = "";
  private copilot?: CopilotClient;
  private agents?: { planner: AgentDefinition; generator: AgentDefinition; healer: AgentDefinition };
  private readonly summary: RunSummary = {
    startedAt: new Date().toISOString(),
    planned: false,
    generatedFiles: [],
    testRuns: 0,
    healAttempts: 0,
    successful: false,
    modules: [],
  };

  public constructor(
    private readonly configPath = path.resolve(process.cwd(), "orchestrator.config.json"),
    private readonly injectedClient?: CopilotClient,
  ) {
    this.orchestratorRoot = path.dirname(this.configPath);
  }

  public async loadConfig(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.configPath, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read valid JSON config at ${this.configPath}: ${messageOf(error)}`);
    }

    if (!isRecord(parsed)) throw new Error("Orchestrator config must be a JSON object.");
    const missing = REQUIRED_CONFIG_KEYS.filter((key) => parsed[key] === undefined);
    if (missing.length > 0) throw new Error(`Missing config properties: ${missing.join(", ")}`);

    for (const key of REQUIRED_CONFIG_KEYS.filter((key) => key !== "maxHealAttempts")) {
      if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
        throw new Error(`Config property "${key}" must be a non-empty string.`);
      }
    }
    if (!Number.isInteger(parsed.maxHealAttempts) || (parsed.maxHealAttempts as number) < 0) {
      throw new Error('Config property "maxHealAttempts" must be a non-negative integer.');
    }

    this.config = parsed as unknown as OrchestratorConfig;
    this.projectRoot = this.config.projectFolder?.trim()
      ? path.resolve(this.orchestratorRoot, this.config.projectFolder)
      : "";
    this.copilot = this.injectedClient ?? new CopilotClient({
      cwd: this.orchestratorRoot,
      env: { APP_URL: this.config.appUrl },
      ...(this.config.agentTimeoutMs !== undefined ? { timeoutMs: this.config.agentTimeoutMs } : {}),
    });
  }

  public async validateInputs(): Promise<void> {
    await this.validateProjectFolder();
    try {
      new URL(this.config.appUrl);
    } catch {
      throw new Error(`Invalid appUrl: ${this.config.appUrl}`);
    }

    if (this.config.seedFile) {
      await this.assertFile(this.resolveWorkspacePath(this.config.seedFile), "seed file");
    }
    const [planner, generator, healer] = await Promise.all([
      this.loadAgent("playwright-test-planner.agent.md"),
      this.loadAgent("playwright-test-generator.agent.md"),
      this.loadAgent("playwright-test-healer.agent.md"),
    ]);
    this.agents = { planner, generator, healer };

    await fs.mkdir(this.resolveWorkspacePath(this.config.generatedTestsFolder), { recursive: true });
    await fs.mkdir(this.resolveWorkspacePath(this.config.reportsFolder), { recursive: true });
    // planFile dir is created per-target inside main(); no upfront mkdir needed.
  }

  /** Lightweight validation for heal-only runs — skips the project folder check. */
  public async validateForHeal(): Promise<void> {
    try {
      new URL(this.config.appUrl);
    } catch {
      throw new Error(`Invalid appUrl: ${this.config.appUrl}`);
    }
    const [planner, generator, healer] = await Promise.all([
      this.loadAgent("playwright-test-planner.agent.md"),
      this.loadAgent("playwright-test-generator.agent.md"),
      this.loadAgent("playwright-test-healer.agent.md"),
    ]);
    this.agents = { planner, generator, healer };
    await fs.mkdir(this.resolveWorkspacePath(this.config.generatedTestsFolder), { recursive: true });
    await fs.mkdir(this.resolveWorkspacePath(this.config.reportsFolder), { recursive: true });
  }

  public async validateProjectFolder(): Promise<void> {
    if (!this.projectRoot) {
      console.log("  Source scan   : skipped (no projectFolder configured) — planning from live app only.");
      return;
    }
    console.log(`  Source scan   : checking ${this.config.projectFolder} ...`);
    const stat = await fs.stat(this.projectRoot).catch(() => undefined);
    if (!stat?.isDirectory()) {
      console.warn(`  Source scan   : ⚠ path not accessible (${this.projectRoot}) — source scan will be skipped, planning from live app only.`);
      this.projectRoot = "";
    } else {
      console.log(`  Source scan   : ✓ path accessible — will scan before planning starts.`);
    }
  }

  public async scanProjectFolder(): Promise<string> {
    if (!this.projectRoot) return this.projectSummary;
    console.log(`\n  Scanning project source at ${this.config.projectFolder} ...`);
    this.projectSummary = formatProjectSummary(await scanProject(this.projectRoot));
    console.log(`  Source scan complete — context passed to planner.\n`);
    return this.projectSummary;
  }

  public async discoverModules(): Promise<void> {
    if (!this.projectRoot) return;
    // Generic routing/navigation file patterns — framework-agnostic.
    // Covers Angular, React, Vue, Next.js, Svelte, Nuxt, SvelteKit, Astro, Express, and custom setups.
    const ROUTE_FILE = /^(routes?|app[-.]routes?|app-routing(\.[^.]+)?|router|routing|navigation|sitemap|pages|app)\.(ts|js|tsx|jsx|json)$/i;
    const ROUTE_DIR_NAMES = new Set(["router", "routes", "routing", "navigation", "pages", "screens", "views"]);
    const IGNORED = new Set(["node_modules", "dist", "build", "out", ".git", ".cache", "coverage", "playwright-report", "test-results"]);

    const candidates: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 7 || candidates.length >= 5) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !IGNORED.has(entry.name)) {
          await walk(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const isNamedRouteFile = ROUTE_FILE.test(entry.name);
          const isIndexInRouteDir = /^index\.(ts|js|tsx|jsx)$/.test(entry.name) && ROUTE_DIR_NAMES.has(path.basename(dir));
          if (isNamedRouteFile || isIndexInRouteDir) candidates.push(path.join(dir, entry.name));
        }
      }
    };
    await walk(this.projectRoot, 0);

    const parts: string[] = [];
    let remaining = 8_000;
    for (const filePath of candidates) {
      const content = await fs.readFile(filePath, "utf8").catch(() => null);
      if (content && content.length > 100) {
        const snippet = truncate(content, Math.min(remaining, 3_000));
        parts.push(`// ${path.relative(this.projectRoot, filePath).replace(/\\/g, "/")}\n${snippet}`);
        remaining -= snippet.length;
        if (remaining <= 0) break;
      }
    }
    this.moduleRoutes = parts.join("\n\n");
  }

  /**
   * Launches a headless browser, navigates to appUrl, and extracts top-level navigation
   * items to auto-generate PlanTarget[] without any manual config.
   * Falls back to a single catch-all plan when no nav items are found.
   */
  /**
   * Writes auto-discovered planFiles back into orchestrator.config.json.
   * Merges with any existing planFiles already in the config — never replaces them.
   * After the first run the config is self-complete — no re-discovery needed.
   */
  private async persistPlanTargets(targets: PlanTarget[]): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      // Preserve any manually configured planFiles — only add genuinely new entries.
      const existing: PlanTarget[] = Array.isArray(config["planFiles"]) ? config["planFiles"] as PlanTarget[] : [];
      const existingKeys = new Set(existing.map((t) => t.file.replace(/\\/g, "/")));
      const newOnly = targets.filter((t) => !existingKeys.has(t.file.replace(/\\/g, "/")));
      const merged = [...existing, ...newOnly];
      config["planFiles"] = merged;
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
      if (newOnly.length > 0) {
        console.log(`  Saved ${newOnly.length} newly discovered module(s) to ${path.basename(this.configPath)}.`);
        console.log("  Edit the 'scope' values to refine what each module's planner focuses on.\n");
      } else {
        console.log(`  No new modules found beyond the ${existing.length} already in config.\n`);
      }
    } catch (err) {
      console.warn(`  Could not save planFiles to config: ${messageOf(err)}`);
    }
  }

  private async discoverPlanTargetsFromUI(): Promise<PlanTarget[]> {
    console.log(`\n  Auto-discovering modules from UI at ${this.config.appUrl} ...`);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const username = process.env.APP_USERNAME ?? "";
    const password = process.env.APP_PASSWORD ?? "";

    // httpCredentials handles NTLM / Basic auth dialogs automatically.
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(username && password ? { httpCredentials: { username, password } } : {}),
    });
    const page = await context.newPage();

    try {
      await page.goto(this.config.appUrl, { waitUntil: "networkidle", timeout: 30_000 });

      // Detect form-based login (SPA apps that redirect to a login page).
      const pwdInput = page.locator('input[type="password"]').first();
      if (username && password && (await pwdInput.isVisible({ timeout: 3_000 }).catch(() => false))) {
        console.log("  Login form detected — filling credentials...");
        const userInput = page
          .locator('input[type="text"], input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i]')
          .first();
        if (await userInput.isVisible({ timeout: 2_000 }).catch(() => false)) await userInput.fill(username);
        await pwdInput.fill(password);
        await page.locator('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      }

      // Wait a bit for SPA routing to settle.
      await page.waitForTimeout(2_000);

      // Extract unique nav links using progressively broader selectors.
      const navItems = await page.evaluate(() => {
        const SKIP = new Set(["/", "", "#"]);
        const seen = new Set<string>();
        const results: { text: string; href: string }[] = [];

        const SELECTORS = [
          "nav a",
          "[role='navigation'] a",
          "[class*='sidebar'] a",
          "[class*='nav'] a",
          "[class*='menu'] a",
          "aside a",
          // Angular-style router links
          "[routerLink]",
        ];

        for (const sel of SELECTORS) {
          const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
          if (els.length === 0) continue;
          for (const el of els) {
            const raw = (el.getAttribute("href") ?? el.getAttribute("routerlink") ?? "").trim();
            const pathname = raw.startsWith("/") ? raw : "/" + raw;
            const text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
            if (!text || text.length > 60) continue;
            if (SKIP.has(raw) || raw.startsWith("#") || raw.startsWith("mailto")) continue;
            if (seen.has(pathname)) continue;
            seen.add(pathname);
            results.push({ text, href: pathname });
          }
          if (results.length >= 2) break; // Stop at first selector that yields results
        }
        return results;
      });

      const specsFolder = this.config.specsFolder ?? "specs";
      if (navItems.length === 0) {
        console.warn("  No navigation items found — falling back to single catch-all plan.");
        return [{ file: `${specsFolder}/plan-app.md`, scope: "all features and modules visible in the application — explore every navigable page, form, widget, and workflow" }];
      }

      console.log(`  Discovered ${navItems.length} module(s): ${navItems.map((n) => n.text).join(", ")}`);

      return navItems.map(({ text, href }) => {
        const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return {
          file: `${specsFolder}/plan-${slug}.md`,
          scope: `${text} module (${href}): all features, workflows, and states visible in this section of the application`,
        };
      });
    } finally {
      await browser.close();
    }
  }

  public async runPlanner(target: PlanTarget): Promise<void> {
    const moduleSection = this.moduleRoutes
      ? `\nApplication routes discovered from source (supplementary reference only — see UI-trust note below):\n<routes>\n${this.moduleRoutes}\n</routes>`
      : "";
    await this.requireCopilot().runPlanner(this.requireAgents().planner, `<plan>
  <task-text>Explore ${this.config.appUrl} and create comprehensive end-to-end test coverage focused on: ${target.scope}.
  Cover happy paths, edge cases, error states, form validations, empty/loading states, and cross-module navigation workflows.
  Aim for at least 8-12 distinct test scenarios per module section.</task-text>
${this.config.seedFile ? `  <seed-file>${this.config.seedFile}</seed-file>\n` : ''}  <plan-file>${target.file}</plan-file>
</plan>

${this.projectRoot ? `The application source folder is ${this.config.projectFolder}. Treat it as read-only.` : 'No application source folder is configured.'}
The application is already running; do not start, stop, build, or modify it.
Project summary:
${this.projectSummary}${moduleSection}

IMPORTANT — UI IS THE SOURCE OF TRUTH: The project summary and source routes above are supplementary context only and may not reflect the current state of the running application (e.g., features may be disabled, routes may redirect, labels may differ). Always explore the live application at ${this.config.appUrl} first. If anything in the source code conflicts with what you observe in the browser — different routes, missing UI elements, different labels, or different behaviour — discard the source code information and rely exclusively on what the live application shows.`);
    await this.assertFile(this.resolveWorkspacePath(target.file), "planner output");
    this.summary.planned = true;
  }

  public async runGenerator(planFile: string): Promise<void> {
    const existingFiles = new Set(
      (await this.generatedSpecFiles()).map((f) => path.relative(this.orchestratorRoot, f)),
    );
    const generatorOutput = await this.requireCopilot().runGenerator(this.requireAgents().generator, `Generate every scenario from ${planFile}, one at a time.
${this.config.seedFile ? `Seed file: ${this.config.seedFile}` : ''}
Application URL: ${this.config.appUrl}
The application is already running; do not start, stop, build, or modify it.
Write every test using generator_write_test. Every file path MUST start with "${this.config.generatedTestsFolder}/" — never write to any other folder (e.g. do NOT write to "tests/dashboard/", write to "${this.config.generatedTestsFolder}/dashboard/" instead).

${this.config.seedFile
  ? `IMPORTANT - Authentication: Every generated test MUST import { test, expect } from '${this.config.fixturesImport ?? '../../fixtures'}' (NOT from '@playwright/test'). This fixture handles authentication automatically before each test \u2014 do NOT add manual login steps in the tests.`
  : `IMPORTANT - No authentication: Every generated test MUST import { test, expect } from '@playwright/test' directly. Tests need no login \u2014 navigate to ${this.config.appUrl} to begin each test.`}

${this.projectRoot ? `The application source folder is ${this.config.projectFolder}. Treat it as read-only.` : 'No application source folder is configured.'}
Project summary:
${this.projectSummary}

IMPORTANT - UI IS THE SOURCE OF TRUTH: Use the running application at ${this.config.appUrl} to verify selectors, labels, and behaviour before writing each test. If the project summary or plan steps conflict with what you observe in the live UI (e.g., element not found, label differs, route redirects), adapt the test to match the actual UI rather than the source code or plan description.`);
    const allFiles = (await this.generatedSpecFiles()).map((f) => path.relative(this.orchestratorRoot, f));
    const newFiles = allFiles.filter((f) => !existingFiles.has(f));
    this.summary.generatedFiles = [...this.summary.generatedFiles, ...newFiles];
    if (newFiles.length === 0) {
      throw new Error(`Generator created no new .spec.ts files for ${planFile}. Agent response: ${truncate(generatorOutput, 2_000)}`);
    }
  }

  public async runTests(): Promise<CommandResult> {
    this.summary.testRuns += 1;
    const result = await runShellCommand(this.config.testCommand, this.orchestratorRoot);
    this.summary.lastTestOutput = truncate(result.output, 20_000);
    return result;
  }

  public async runTestsForFiles(files: string[]): Promise<CommandResult> {
    this.summary.testRuns += 1;
    const command = this.buildScopedTestCommand(files);
    const result = await runShellCommand(command, this.orchestratorRoot);
    this.summary.lastTestOutput = truncate(result.output, 20_000);
    return result;
  }

  private async runTestsWithRetries(retries: number, files?: string[]): Promise<CommandResult> {
    this.summary.testRuns += 1;
    const base = files ? this.buildScopedTestCommand(files) : this.config.testCommand;
    const result = await runShellCommand(`${base} --retries ${retries}`, this.orchestratorRoot);
    this.summary.lastTestOutput = truncate(result.output, 20_000);
    return result;
  }

  public async runHealerLoop(initialFailure: CommandResult, files?: string[]): Promise<CommandResult> {
    let result = initialFailure;

    // Retry with Playwright's --retries first to filter out flaky tests cheaply.
    const retryCount = this.config.retryBeforeHeal ?? 0;
    if (retryCount > 0) {
      console.log(`  Re-running with --retries ${retryCount} to filter flaky failures...`);
      const retried = await this.runTestsWithRetries(retryCount, files);
      if (retried.exitCode === 0) {
        console.log('  All tests passed on retry — healer not needed.');
        return retried;
      }
      result = retried;
    }

    const scope = files
      ? files.map((f) => (path.isAbsolute(f) ? path.relative(this.orchestratorRoot, f) : f).replace(/\\/g, '/'))
             .join('\n')
      : this.config.generatedTestsFolder;
    for (let attempt = 1; attempt <= this.config.maxHealAttempts && result.exitCode !== 0; attempt += 1) {
      this.summary.healAttempts += 1;
      await this.requireCopilot().runHealer(this.requireAgents().healer, `Run and heal the failing tests under ${scope}.
Do not run, edit, heal, or otherwise modify any pre-existing spec outside ${this.config.generatedTestsFolder}.
Application URL: ${this.config.appUrl}
The application is already running; do not start, stop, build, or modify it.
Failure from the orchestrator:
${truncate(result.output, 20_000)}`);
      result = files ? await this.runTestsForFiles(files) : await this.runTests();
    }
    return result;
  }

  public async showFinalSummary(): Promise<void> {
    this.summary.finishedAt = new Date().toISOString();
    const reportPath = this.resolveWorkspacePath(path.join(this.config.reportsFolder, "orchestrator-summary.json"));
    await fs.writeFile(reportPath, JSON.stringify(this.summary, null, 2) + "\n", "utf8");
    console.log(`\nOrchestration ${this.summary.successful ? "completed successfully" : "failed"}.`);
    console.log(`Generated files: ${this.summary.generatedFiles.length}; test runs: ${this.summary.testRuns}; heal attempts: ${this.summary.healAttempts}`);
    if (this.summary.modules.length > 0) {
      console.log('\nModule results:');
      for (const m of this.summary.modules) {
        const icon = m.status === 'passed' ? '\u2713' : m.status === 'failed' ? '\u2717' : '-';
        const heals = m.healAttempts > 0 ? ` (${m.healAttempts} heal${m.healAttempts > 1 ? 's' : ''})` : '';
        console.log(`  [${icon}] ${path.basename(m.planFile, '.md').padEnd(22)} ${m.status.padEnd(8)} ${m.generatedSpecs} spec(s)${heals}`);
      }
    }
    console.log(`Summary: ${reportPath}`);
  }

  public async main(): Promise<void> {
    try {
      await this.loadConfig();
      await this.validateInputs();
      await this.scanProjectFolder();
      await this.discoverModules();

      const preconfigured = (this.config.planFiles?.length ?? 0) > 0;
      let targets: PlanTarget[];
      if (preconfigured) {
        targets = this.config.planFiles!;
      } else if (this.config.planFile) {
        targets = [{ file: this.config.planFile, scope: "all features and modules visible in the application — explore every navigable page, form, widget, and workflow" }];
      } else {
        // Neither planFiles nor planFile configured — auto-discover from the live UI.
        targets = await this.discoverPlanTargetsFromUI();
        // Persist discovered targets back into the config file so subsequent runs
        // use the saved list directly (and the user can edit scopes manually).
        await this.persistPlanTargets(targets);
      }

      const resume = process.argv.includes('--resume');
      const planArg = (() => {
        const i = process.argv.indexOf('--plan');
        return i !== -1 ? process.argv[i + 1]?.toLowerCase() : undefined;
      })();

      // --plan filters to a single matching module by basename (e.g. "accounts" matches "specs/plan-accounts.md").
      if (planArg) {
        const match = targets.find((t) => path.basename(t.file, '.md').toLowerCase().includes(planArg));
        if (!match) throw new Error(`No plan found matching "${planArg}". Available: ${targets.map((t) => path.basename(t.file, '.md')).join(', ')}`);
        targets = [match];
      }

      console.log(`\nOrchestrating ${targets.length} module(s)${resume ? ' [RESUME MODE — completed modules will be skipped]' : ''}${planArg ? ` [PLAN MODE — ${planArg}]` : ''}`);

      const generatedFolder = this.resolveWorkspacePath(this.config.generatedTestsFolder);
      if (planArg) {
        // Scoped cleanup — only remove the target module's subfolder, leave all others intact.
        const moduleSlug = planArg.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const moduleFolder = path.join(generatedFolder, moduleSlug);
        await fs.rm(moduleFolder, { recursive: true, force: true });
      } else if (!resume) {
        await fs.rm(generatedFolder, { recursive: true, force: true });
      }
      await fs.mkdir(generatedFolder, { recursive: true });

      // In resume mode detect which plan files already have generated spec files.
      const completedPlans = resume ? await this.completedPlanFiles() : new Set<string>();

      let overallExitCode = 0;
      overallExitCode = await this.runModuleList(targets, completedPlans, overallExitCode, 0, resume);

      // After processing pre-configured planFiles, discover the live UI for any new
      // modules that weren't in the original list and run the pipeline for each one.
      if (preconfigured && !planArg) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log('Post-run UI discovery — checking for new modules...');
        console.log('─'.repeat(60));
        const discovered = await this.discoverPlanTargetsFromUI();
        const existingKeys = new Set(targets.map((t) => t.file.replace(/\\/g, '/')));
        const newTargets = discovered.filter((t) => !existingKeys.has(t.file.replace(/\\/g, '/')));
        if (newTargets.length > 0) {
          console.log(`Found ${newTargets.length} new module(s): ${newTargets.map((t) => path.basename(t.file, '.md')).join(', ')}`);
          await this.persistPlanTargets([...targets, ...newTargets]);
          overallExitCode = await this.runModuleList(newTargets, completedPlans, overallExitCode, targets.length);
        } else {
          console.log('No new modules found.');
        }
      }

      if (this.summary.generatedFiles.length === 0) throw new Error("No test files were generated across all plan targets.");

      this.summary.successful = overallExitCode === 0;
      if (!this.summary.successful) throw new Error(`Tests still fail after ${this.summary.healAttempts} healing attempt(s).`);
    } catch (error) {
      this.summary.error = messageOf(error);
      process.exitCode = 1;
      console.error(`Orchestration error: ${this.summary.error}`);
    } finally {
      if (this.config) await this.showFinalSummary().catch((error) => console.error(`Could not write summary: ${messageOf(error)}`));
    }
  }

  private async runModuleList(
    targets: PlanTarget[],
    completedPlans: Set<string>,
    exitCode: number,
    indexOffset: number,
    resume = false,
  ): Promise<number> {
    let overallExitCode = exitCode;
    const total = targets.length + indexOffset;

    for (const [i, target] of targets.entries()) {
      const idx = i + indexOffset;
      const planKey = target.file.replace(/\\/g, '/');
      if (completedPlans.has(planKey)) {
        console.log(`\n  [✓] Module [${idx + 1}/${total}] already done — skipping ${path.basename(target.file, '.md')}`);
        this.summary.modules.push({ planFile: target.file, generatedSpecs: 0, status: 'skipped', healAttempts: 0 });
        continue;
      }

      // In resume mode, a module that is NOT in completedPlans was either never
      // reached or failed mid-run. Remove any partial spec files from the previous
      // interrupted run so the generator starts clean for this module.
      if (resume) {
        await this.removePartialSpecsForPlan(planKey);
      }
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Module [${idx + 1}/${total}]: ${path.basename(target.file, '.md')}`);
      console.log(`Scope : ${target.scope.slice(0, 120)}${target.scope.length > 120 ? '…' : ''}`);
      if (this.config.moduleTimeoutMs) console.log(`Timeout: ${Math.round(this.config.moduleTimeoutMs / 60_000)} min`);
      console.log('─'.repeat(60));

      const healsBefore = this.summary.healAttempts;
      let moduleStatus: ModuleResult['status'] = 'failed';
      let moduleSpecs = 0;

      const processModule = async (): Promise<void> => {
        await fs.mkdir(path.dirname(this.resolveWorkspacePath(target.file)), { recursive: true });
        await this.runPlanner(target);
        const filesBefore = new Set(this.summary.generatedFiles);
        try {
          await this.runGenerator(target.file);
        } catch (generatorError) {
          console.warn(`Generator failed for ${target.file}: ${messageOf(generatorError)}. Checking for partially generated tests...`);
          const allFiles = (await this.generatedSpecFiles()).map((f) => path.relative(this.orchestratorRoot, f));
          const partialFiles = allFiles.filter((f) => !this.summary.generatedFiles.includes(f));
          if (partialFiles.length > 0) {
            this.summary.generatedFiles = [...this.summary.generatedFiles, ...partialFiles];
            console.warn(`Found ${partialFiles.length} partially generated spec file(s) for ${target.file}. Continuing.`);
          } else if (this.summary.generatedFiles.length === 0) {
            throw generatorError;
          }
        }
        const newFiles = this.summary.generatedFiles.filter((f) => !filesBefore.has(f));
        moduleSpecs = newFiles.length;
        console.log(`Generated ${newFiles.length} spec file(s) for module [${idx + 1}/${total}].`);
        if (newFiles.length > 0) {
          let result = await this.runTestsForFiles(newFiles);
          if (result.exitCode !== 0) result = await this.runHealerLoop(result, newFiles);
          moduleStatus = result.exitCode === 0 ? 'passed' : 'failed';
          if (result.exitCode !== 0) overallExitCode = result.exitCode;
        } else {
          moduleStatus = 'skipped';
        }
      };

      try {
        const modulePromise = processModule();
        await (this.config.moduleTimeoutMs
          ? withTimeout(modulePromise, this.config.moduleTimeoutMs, path.basename(target.file, '.md'))
          : modulePromise);
      } catch (moduleError) {
        console.warn(`\n  ⚠ Module ${path.basename(target.file, '.md')} failed: ${messageOf(moduleError)}`);
        overallExitCode = 1;
      }

      this.summary.modules.push({
        planFile: target.file,
        generatedSpecs: moduleSpecs,
        status: moduleStatus,
        healAttempts: this.summary.healAttempts - healsBefore,
      });
    }

    return overallExitCode;
  }

  /**
   * Discovers modules from the live UI and persists them to planFiles in the config.
   * Exits without running the planner or generator — use `npm run generate` to continue.
   */
  public async discover(): Promise<void> {
    try {
      new URL(this.config.appUrl);
    } catch {
      throw new Error(`Invalid appUrl: ${this.config.appUrl}`);
    }
    const targets = await this.discoverPlanTargetsFromUI();
    await this.persistPlanTargets(targets);
    console.log("\nDiscovery complete. Edit scopes in orchestrator.config.json if needed, then run: npm run generate\n");
  }

  private requireCopilot(): CopilotClient {
    if (!this.copilot) throw new Error("Copilot client is not initialized; load config first.");
    return this.copilot;
  }

  private requireAgents(): { planner: AgentDefinition; generator: AgentDefinition; healer: AgentDefinition } {
    if (!this.agents) throw new Error("Agent definitions are not loaded; validate inputs first.");
    return this.agents;
  }

  private loadAgent(name: string): Promise<AgentDefinition> {
    const agentsFolder = this.config.agentsFolder ?? path.join(".github", "agents");
    return loadAgentDefinition(path.resolve(this.orchestratorRoot, agentsFolder, name));
  }

  private resolveWorkspacePath(configuredPath: string): string {
    const resolved = path.resolve(this.orchestratorRoot, configuredPath);
    const relative = path.relative(this.orchestratorRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes orchestrator workspace: ${configuredPath}`);
    return resolved;
  }

  private async assertFile(file: string, label: string): Promise<void> {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) throw new Error(`Configured ${label} does not exist: ${file}`);
  }

  private buildScopedTestCommand(files: string[]): string {
    const dirs = [...new Set(
      files.map((f) => {
        const rel = (path.isAbsolute(f) ? path.relative(this.orchestratorRoot, f) : f).replace(/\\/g, '/');
        // If the path already points to a directory (no file extension), use it directly.
        // If it points to a file, take its parent directory.
        return (path.extname(rel) ? path.dirname(rel) : rel).replace(/\\/g, '/');
      }),
    )];
    const genFolder = this.config.generatedTestsFolder.replace(/\\/g, '/');
    const baseCmd = this.config.testCommand.replace(
      new RegExp(`\\s+${genFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`),
      '',
    );
    return `${baseCmd} ${dirs.join(' ')}`;
  }

  private async completedPlanFiles(): Promise<Set<string>> {
    // A module is considered complete only when its last recorded status is
    // 'passed' or 'skipped'. A 'failed' status (including partial generation
    // interrupted mid-run) means the module must be re-run.
    const summaryPath = path.join(
      this.resolveWorkspacePath(this.config.reportsFolder),
      'orchestrator-summary.json',
    );
    try {
      const raw = await fs.readFile(summaryPath, 'utf8');
      const summary = JSON.parse(raw) as { modules?: Array<{ planFile: string; status: string }> };
      const completed = new Set<string>();
      for (const m of summary.modules ?? []) {
        if (m.status === 'passed' || m.status === 'skipped') {
          completed.add(m.planFile.replace(/\\/g, '/'));
        }
      }
      return completed;
    } catch {
      // No summary yet — treat all modules as incomplete.
      return new Set<string>();
    }
  }

  private async removePartialSpecsForPlan(planKey: string): Promise<void> {
    const specFiles = await this.generatedSpecFiles().catch(() => []);
    await Promise.all(specFiles.map(async (filePath) => {
      const firstLine = await fs.readFile(filePath, 'utf8')
        .then((c) => c.split('\n')[0] ?? '')
        .catch(() => '');
      const match = /^\/\/ spec:\s*(.+)$/.exec(firstLine);
      if (match?.[1]?.trim().replace(/\\/g, '/') === planKey) {
        await fs.rm(filePath, { force: true });
      }
    }));
  }

  private async generatedSpecFiles(): Promise<string[]> {
    const root = this.resolveWorkspacePath(this.config.generatedTestsFolder);
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
      .map((entry) => path.join(entry.parentPath, entry.name));
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 60_000)} min`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function runShellCommand(command: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr, output: `${stdout}\n${stderr}`.trim() }));
  });
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}\n...[truncated]`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (require.main === module) void new PlaywrightOrchestrator().main();
