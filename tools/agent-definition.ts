/// <reference types="node" />

import fs = require("node:fs/promises");
import path = require("node:path");

export interface AgentDefinition {
  name: string;
  instructions: string;
  sourceFile: string;
}

/** Loads the name and instruction body from a GitHub `.agent.md` file. */
export async function loadAgentDefinition(file: string): Promise<AgentDefinition> {
  const sourceFile = path.resolve(file);
  const source = await fs.readFile(sourceFile, "utf8");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Agent file has invalid front matter: ${sourceFile}`);

  const name = match[1]!.match(/^name:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim();
  const instructions = match[2]!.trim();
  if (!name) throw new Error(`Agent file is missing a name: ${sourceFile}`);
  if (!instructions) throw new Error(`Agent file has no instruction body: ${sourceFile}`);
  return { name, instructions, sourceFile };
}
