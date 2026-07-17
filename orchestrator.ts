/// <reference types="node" />

import fs = require("node:fs/promises");
import path = require("node:path");
import { spawn } from "node:child_process";
import process = require("node:process");
import "dotenv/config";
import { CodexClient } from "./tools/codex-client.js";
import { formatProjectSummary, scanProject } from "./tools/project.js";
import { loadAgentDefinition, type AgentDefinition } from "./tools/agent-definition.js";

export interface OrchestratorConfig {
  projectFolder: string;
  appUrl: string;
  seedFile: string;
  planFile: string;
  generatedTestsFolder: string;
  reportsFolder: string;
  maxHealAttempts: number;
  testCommand: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
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
}

const REQUIRED_CONFIG_KEYS: ReadonlyArray<keyof OrchestratorConfig> = [
  "projectFolder",
  "appUrl",
  "seedFile",
  "planFile",
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
  private codex?: CodexClient;
  private agents?: { planner: AgentDefinition; generator: AgentDefinition; healer: AgentDefinition };
  private readonly summary: RunSummary = {
    startedAt: new Date().toISOString(),
    planned: false,
    generatedFiles: [],
    testRuns: 0,
    healAttempts: 0,
    successful: false,
  };

  public constructor(
    private readonly configPath = path.resolve(process.cwd(), "orchestrator.config.json"),
    private readonly injectedClient?: CodexClient,
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
    this.projectRoot = path.resolve(this.orchestratorRoot, this.config.projectFolder);
    this.codex = this.injectedClient ?? new CodexClient({
      cwd: this.orchestratorRoot,
      env: { APP_URL: this.config.appUrl },
    });
  }

  public async validateInputs(): Promise<void> {
    await this.validateProjectFolder();
    try {
      new URL(this.config.appUrl);
    } catch {
      throw new Error(`Invalid appUrl: ${this.config.appUrl}`);
    }

    await this.assertFile(this.resolveWorkspacePath(this.config.seedFile), "seed file");
    const [planner, generator, healer] = await Promise.all([
      this.loadAgent("playwright-test-planner.agent.md"),
      this.loadAgent("playwright-test-generator.agent.md"),
      this.loadAgent("playwright-test-healer.agent.md"),
    ]);
    this.agents = { planner, generator, healer };

    await fs.mkdir(this.resolveWorkspacePath(this.config.generatedTestsFolder), { recursive: true });
    await fs.mkdir(this.resolveWorkspacePath(this.config.reportsFolder), { recursive: true });
    await fs.mkdir(path.dirname(this.resolveWorkspacePath(this.config.planFile)), { recursive: true });
  }

  public async validateProjectFolder(): Promise<void> {
    const stat = await fs.stat(this.projectRoot).catch(() => undefined);
    if (!stat?.isDirectory()) throw new Error(`Project folder does not exist: ${this.projectRoot}`);
  }

  public async scanProjectFolder(): Promise<string> {
    this.projectSummary = formatProjectSummary(await scanProject(this.projectRoot));
    return this.projectSummary;
  }

  public async runPlanner(): Promise<void> {
    await this.requireCodex().runPlanner(this.requireAgents().planner, `<plan>
  <task-text>Explore ${this.config.appUrl} and create comprehensive end-to-end test coverage.</task-text>
  <seed-file>${this.config.seedFile}</seed-file>
  <plan-file>${this.config.planFile}</plan-file>
</plan>

The application source folder is ${path.relative(this.orchestratorRoot, this.projectRoot)}. Treat it as read-only.
The application is already running; do not start, stop, build, or modify it.
Project summary:
${this.projectSummary}`);
    await this.assertFile(this.resolveWorkspacePath(this.config.planFile), "planner output");
    this.summary.planned = true;
  }

  public async runGenerator(): Promise<void> {
    const generatorOutput = await this.requireCodex().runGenerator(this.requireAgents().generator, `Generate every scenario from ${this.config.planFile}, one at a time.
Seed file: ${this.config.seedFile}
Application URL: ${this.config.appUrl}
The application is already running; do not start, stop, build, or modify it.
Write every test beneath ${this.config.generatedTestsFolder} using generator_write_test.`);
    this.summary.generatedFiles = (await this.generatedSpecFiles()).map((file) => path.relative(this.orchestratorRoot, file));
    if (this.summary.generatedFiles.length === 0) {
      throw new Error(`Generator created no .spec.ts files. Agent response: ${truncate(generatorOutput, 2_000)}`);
    }
  }

  public async runTests(): Promise<CommandResult> {
    this.summary.testRuns += 1;
    const result = await runShellCommand(this.config.testCommand, this.orchestratorRoot);
    this.summary.lastTestOutput = truncate(result.output, 20_000);
    return result;
  }

  public async runHealerLoop(initialFailure: CommandResult): Promise<CommandResult> {
    let result = initialFailure;
    for (let attempt = 1; attempt <= this.config.maxHealAttempts && result.exitCode !== 0; attempt += 1) {
      this.summary.healAttempts = attempt;
      await this.requireCodex().runHealer(this.requireAgents().healer, `Run and heal the failing tests under ${this.config.generatedTestsFolder}.
Do not run, edit, heal, or otherwise modify any pre-existing spec outside ${this.config.generatedTestsFolder}.
Application URL: ${this.config.appUrl}
The application is already running; do not start, stop, build, or modify it.
Failure from the orchestrator:
${truncate(result.output, 20_000)}`);
      result = await this.runTests();
    }
    return result;
  }

  public async showFinalSummary(): Promise<void> {
    this.summary.finishedAt = new Date().toISOString();
    const reportPath = this.resolveWorkspacePath(path.join(this.config.reportsFolder, "orchestrator-summary.json"));
    await fs.writeFile(reportPath, JSON.stringify(this.summary, null, 2) + "\n", "utf8");
    console.log(`\nOrchestration ${this.summary.successful ? "completed successfully" : "failed"}.`);
    console.log(`Generated files: ${this.summary.generatedFiles.length}; test runs: ${this.summary.testRuns}; heal attempts: ${this.summary.healAttempts}`);
    console.log(`Summary: ${reportPath}`);
  }

  public async main(): Promise<void> {
    try {
      await this.loadConfig();
      await this.validateInputs();
      await this.scanProjectFolder();
      await this.runPlanner();
      await this.runGenerator();
      let result = await this.runTests();
      if (result.exitCode !== 0) result = await this.runHealerLoop(result);
      this.summary.successful = result.exitCode === 0;
      if (!this.summary.successful) throw new Error(`Tests still fail after ${this.summary.healAttempts} healing attempt(s).`);
    } catch (error) {
      this.summary.error = messageOf(error);
      process.exitCode = 1;
      console.error(`Orchestration error: ${this.summary.error}`);
    } finally {
      if (this.config) await this.showFinalSummary().catch((error) => console.error(`Could not write summary: ${messageOf(error)}`));
    }
  }

  private requireCodex(): CodexClient {
    if (!this.codex) throw new Error("Codex client is not initialized; load config first.");
    return this.codex;
  }

  private requireAgents(): { planner: AgentDefinition; generator: AgentDefinition; healer: AgentDefinition } {
    if (!this.agents) throw new Error("Agent definitions are not loaded; validate inputs first.");
    return this.agents;
  }

  private loadAgent(name: string): Promise<AgentDefinition> {
    return loadAgentDefinition(path.resolve(this.orchestratorRoot, ".github", "agents", name));
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

  private async generatedSpecFiles(): Promise<string[]> {
    const root = this.resolveWorkspacePath(this.config.generatedTestsFolder);
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
      .map((entry) => path.join(entry.parentPath, entry.name));
  }
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
