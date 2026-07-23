/// <reference types="node" />

import fs = require("node:fs/promises");
import path = require("node:path");

export interface ProjectScanOptions {
  maxDepth?: number;
  maxFiles?: number;
  ignoredDirectories?: Iterable<string>;
}

export interface ProjectSummary {
  root: string;
  packageManager?: string;
  framework: string[];
  scripts: Record<string, string>;
  dependencies: string[];
  routes: string[];
  sourceFiles: string[];
  testFiles: string[];
  configFiles: string[];
  truncated: boolean;
}

const DEFAULT_IGNORES = [
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
];

export async function scanProject(
  projectFolder: string,
  options: ProjectScanOptions = {},
): Promise<ProjectSummary> {
  const root = path.resolve(projectFolder);
  const rootStat = await fs.stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) throw new Error(`Project folder does not exist: ${root}`);

  const maxDepth = options.maxDepth ?? 7;
  const maxFiles = options.maxFiles ?? 750;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error("maxDepth must be a non-negative integer.");
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be a positive integer.");

  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORES);
  const allFiles: string[] = [];
  let truncated = false;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) { truncated = true; return; }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && ignored.has(entry.name))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (entry.isFile()) allFiles.push(toPosix(path.relative(root, absolute)));
      if (allFiles.length >= maxFiles) { truncated = true; return; }
    }
  };
  await walk(root, 0);

  const packageJson = await readPackageJson(root);
  const dependencyNames = [...new Set([
    ...Object.keys(stringRecord(packageJson?.dependencies)),
    ...Object.keys(stringRecord(packageJson?.devDependencies)),
  ])].sort();
  const packageManager = detectPackageManager(allFiles);

  return {
    root,
    ...(packageManager ? { packageManager } : {}),
    framework: detectFrameworks(dependencyNames, allFiles),
    scripts: stringRecord(packageJson?.scripts),
    dependencies: dependencyNames,
    routes: allFiles.filter(isRouteFile),
    sourceFiles: allFiles.filter(isImportantSourceFile),
    testFiles: allFiles.filter(isTestFile),
    configFiles: allFiles.filter(isConfigFile),
    truncated,
  };
}

export function formatProjectSummary(summary: ProjectSummary): string {
  const section = (title: string, values: string[]): string =>
    `${title}:\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- none detected"}`;
  const scripts = Object.entries(summary.scripts).map(([name, command]) => `${name}: ${command}`);

  return [
    `Project root: ${summary.root}`,
    `Package manager: ${summary.packageManager ?? "not detected"}`,
    `Scan truncated: ${summary.truncated ? "yes" : "no"}`,
    section("Frameworks", summary.framework),
    section("Package scripts", scripts),
    section("Routes/pages", summary.routes),
    section("Important source files", summary.sourceFiles),
    section("Test files", summary.testFiles),
    section("Configuration files", summary.configFiles),
  ].join("\n\n");
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Unable to parse package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function detectPackageManager(files: string[]): string | undefined {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  return undefined;
}

function detectFrameworks(dependencies: string[], files: string[]): string[] {
  const found = new Set<string>();
  const mappings: Array<[string, string]> = [
    ["@angular/core", "Angular"], ["@playwright/test", "Playwright"], ["@sveltejs/kit", "SvelteKit"],
    ["astro", "Astro"], ["express", "Express"], ["next", "Next.js"], ["nuxt", "Nuxt"],
    ["react", "React"], ["vite", "Vite"], ["vue", "Vue"],
  ];
  for (const [dependency, framework] of mappings) if (dependencies.includes(dependency)) found.add(framework);
  if (files.some((file) => file === "playwright.config.ts" || file === "playwright.config.js")) found.add("Playwright");
  return [...found].sort();
}

function isRouteFile(file: string): boolean {
  // Matches files inside common routing/page directories across all frameworks
  return /(^|\/)(pages|routes|screens|views|navigation)(\/.+)\.(tsx?|jsx?|vue|svelte|py|rb|php)$/.test(file)
    || /\/(router|routing|routes|app\.routes?|app-routing)\.(ts|js|tsx|jsx)$/.test(file);
}

function isImportantSourceFile(file: string): boolean {
  return /(^|\/)(src|app|lib|components|services|utils|hooks|store|views|screens|controllers|handlers|middleware)(\/.+)\.(tsx?|jsx?|vue|svelte)$/.test(file);
}

function isTestFile(file: string): boolean {
  return /(^|\/)(__tests__|tests?|e2e)(\/|$)/.test(file) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(file);
}

function isConfigFile(file: string): boolean {
  return /(^|\/)(package\.json|tsconfig(?:\.[^.]+)?\.json|[^/]+\.config\.[cm]?[jt]s|\.env\.example)$/.test(file);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
