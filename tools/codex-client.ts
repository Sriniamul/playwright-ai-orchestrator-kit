/// <reference types="node" />

import { spawn } from "node:child_process";
import fs = require("node:fs");
import path = require("node:path");
import process = require("node:process");
import type { AgentDefinition } from "./agent-definition.js";

export interface CodexClientOptions {
  cwd: string;
  executable?: string;
  model?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CodexRequest {
  agent: AgentDefinition;
  task: string;
}

/** Executes `.github/agents` instructions with Codex and Playwright Test MCP. */
export class CodexClient {
  private readonly executable: string;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;

  public constructor(private readonly options: CodexClientOptions) {
    this.executable = options.executable ?? process.env.CODEX_CLI ?? findCodexExecutable(options.cwd);
    this.model = options.model ?? process.env.CODEX_MODEL;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
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

  public complete(request: CodexRequest): Promise<string> {
    if (!request.task.trim()) return Promise.reject(new Error("Agent task cannot be empty."));
    const prompt = `${request.agent.instructions}\n\n# Current task\n${request.task}\n\nUse the Playwright Test MCP tools declared for this agent. Work only inside the current project.`;
    return this.execute(prompt);
  }

  private execute(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        // Browser interaction tools require approval. There is no interactive
        // approver in `codex exec`, so unattended MCP automation must opt in.
        "--dangerously-bypass-approvals-and-sandbox",
        "exec",
        "--skip-git-repo-check",
        "--cd", this.options.cwd,
        "--color", "never",
        "-c", 'mcp_servers.playwright-test.command="npx"',
        "-c", 'mcp_servers.playwright-test.args=["playwright","run-test-mcp-server"]',
      ];
      if (this.model) args.push("--model", this.model);
      args.push("-");

      const child = spawn(this.executable, args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
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
      child.stdin.end(prompt);
    });
  }
}

function findCodexExecutable(cwd: string): string {
  const executable = process.platform === "win32" ? "codex.cmd" : "codex";
  const local = path.join(cwd, "node_modules", ".bin", executable);
  return fs.existsSync(local) ? local : executable;
}

export default CodexClient;
