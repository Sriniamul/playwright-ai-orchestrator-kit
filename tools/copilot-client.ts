/// <reference types="node" />

import { spawn } from "node:child_process";
import fs = require("node:fs");
import path = require("node:path");
import process = require("node:process");
import type { AgentDefinition } from "./agent-definition.js";

export interface CopilotClientOptions {
  cwd: string;
  executable?: string;
  model?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CopilotRequest {
  agent: AgentDefinition;
  task: string;
}

interface ExecutableResolution {
  executable: string;
  prefixArgs: string[];
  useShell: boolean;
}

/** MCP config passed per-invocation so the CLI never needs a persisted `~/.copilot/mcp-config.json` entry. */
const PLAYWRIGHT_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    "playwright-test": {
      type: "local",
      command: "npx",
      args: ["playwright", "run-test-mcp-server"],
      tools: ["*"],
    },
  },
});

/** Executes `.github/agents` instructions with GitHub Copilot CLI and Playwright Test MCP. */
export class CopilotClient {
  private readonly executable: string;
  private readonly prefixArgs: ReadonlyArray<string>;
  private readonly useShell: boolean;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;

  public constructor(private readonly options: CopilotClientOptions) {
    const resolved = options.executable
      ? { executable: options.executable, prefixArgs: [], useShell: process.platform === "win32" }
      : findCopilotExecutable(options.cwd);
    this.executable = resolved.executable;
    this.prefixArgs = resolved.prefixArgs;
    this.useShell = resolved.useShell;
    this.model = options.model ?? process.env.COPILOT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 40 * 60_000;
  }

  public runPlanner(agent: AgentDefinition, task: string): Promise<string> {
    return this.complete({ agent, task });
  }

  public runGenerator(agent: AgentDefinition, task: string): Promise<string> {
    return this.complete({ agent, task });
  }

  public runHealer(agent: AgentDefinition, task: string): Promise<string> {
    return this.complete({ agent, task });
  }

  public complete(request: CopilotRequest): Promise<string> {
    if (!request.task.trim()) return Promise.reject(new Error("Agent task cannot be empty."));
    const prompt = `${request.agent.instructions}\n\n# Current task\n${request.task}\n\nUse the Playwright Test MCP tools declared for this agent. Work only inside the current project.`;
    return this.execute(prompt);
  }

  private execute(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        ...this.prefixArgs,
        "-C", this.options.cwd,
        // Non-interactive, unattended automation: approve every tool call and
        // never pause for user input, mirroring Codex's bypass-approvals mode.
        "--allow-all",
        "--no-ask-user",
        "--disable-builtin-mcps",
        "--additional-mcp-config", PLAYWRIGHT_MCP_CONFIG,
        "--no-color",
        "--silent",
      ];
      if (this.model) args.push("--model", this.model);
      args.push("--prompt", prompt);

      const child = spawn(this.executable, args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        // A locally resolved npm-loader.js entry point runs directly under
        // Node without a shell. Falling back to the global `copilot` command
        // on Windows requires cmd.exe because npm exposes it as a .cmd launcher.
        shell: this.useShell,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`Agent timed out after ${this.timeoutMs}ms.`)));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); process.stdout.write(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); process.stderr.write(chunk); });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code, signal) => finish(() => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`Agent exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}: ${stderr.trim()}`));
      }));
    });
  }
}

function findCopilotExecutable(cwd: string): ExecutableResolution {
  if (process.platform === "win32") {
    const loader = path.join(cwd, "node_modules", "@github", "copilot", "npm-loader.js");
    if (fs.existsSync(loader)) return { executable: process.execPath, prefixArgs: [loader], useShell: false };
    return { executable: "copilot.cmd", prefixArgs: [], useShell: true };
  }
  const local = path.join(cwd, "node_modules", ".bin", "copilot");
  return { executable: fs.existsSync(local) ? local : "copilot", prefixArgs: [], useShell: false };
}
