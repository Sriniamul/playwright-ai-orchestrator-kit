# Playwright AI Orchestrator

## 1. Overview

The Playwright AI Orchestrator generates and maintains Playwright end-to-end tests for a separately running web application. It combines three AI agent definitions with Playwright Test MCP:

1. **Planner** explores the application and creates a Markdown test plan.
2. **Generator** executes each planned scenario in the browser and writes Playwright TypeScript tests.
3. **Healer** diagnoses and repairs generated tests that fail.

The target application is treated as read-only. Its source folder may be replaced with another application by changing `orchestrator.config.json`. All plans, tests, reports, agents, and orchestration code remain outside the target application.

## 2. Goals and boundaries

### The orchestrator does

- Scan target-application metadata, routes, components, and configuration filenames.
- Explore an already-running application through Playwright MCP.
- Produce a structured test plan.
- Generate Playwright `.spec.ts` files from verified browser interactions.
- Run only the configured generated-test directory.
- Retry failed tests through a bounded healer loop.
- Write a machine-readable execution summary.

### The orchestrator does not

- Start, stop, build, deploy, or modify the target application.
- Run unit tests or existing `.spec.ts` files inside the target application.
- Copy generated Playwright files into the target application.
- Guarantee that every model-proposed scenario reflects supported product behavior; browser verification and healing reduce this risk.

## 3. Architecture

```text
orchestrator.config.json
          |
          v
PlaywrightOrchestrator
  |-- scan target application (read-only)
  |-- load .github/agents/playwright-test-planner.agent.md
  |-- run planner through Codex + Playwright Test MCP
  |      `-- writes specs/app-plan.md
  |-- load .github/agents/playwright-test-generator.agent.md
  |-- run generator through Codex + Playwright Test MCP
  |      `-- writes tests/generated/**/*.spec.ts
  |-- run configured Playwright command
  |-- on failure, load healer agent and retry
  `-- write reports/orchestrator-summary.json
```

### Main components

| Component | Responsibility |
| --- | --- |
| `orchestrator.ts` | Validates configuration and coordinates the complete workflow. |
| `tools/agent-definition.ts` | Parses GitHub `.agent.md` front matter and instruction bodies. |
| `tools/copilot-client.ts` | Runs Copilot CLI non-interactively and attaches Playwright Test MCP. |
| `tools/project.ts` | Scans and summarizes the target application file tree. |
| `.github/agents/` | Source-of-truth planner, generator, and healer instructions. |
| `tests/helpers/login.ts` | Reusable `login(page)` function — handles credentials, MFA, and intermediate screens. |
| `tests/fixtures.ts` | Playwright fixture that calls `login()` before every generated test. |
| `tests/seed.spec.ts` | Smoke test that verifies the login flow and re-exports `login`. |
| `playwright.config.ts` | Defines reporters, timeout, worker count, and the Chromium project. |

## 4. Directory structure

```text
playwright-ai-orchestrator-kit/
├── .env                                  # APP_URL, APP_USERNAME, APP_PASSWORD (git-ignored)
├── .github/
│   └── agents/
│       ├── playwright-test-planner.agent.md
│       ├── playwright-test-generator.agent.md
│       └── playwright-test-healer.agent.md
├── docs/
│   ├── ARCHITECTURE.md
│   └── PLAYWRIGHT_AI_ORCHESTRATOR.md
├── exports/                              # created by npm run export
├── reports/
│   └── orchestrator-summary.json        # generated per run
├── specs/
│   ├── README.md
│   ├── app-plan.md                       # fallback single plan
│   ├── plan-navigation.md               # generated — per-module plan
│   ├── plan-dashboard.md                # generated — per-module plan
│   ├── plan-accounts.md                 # generated — per-module plan
│   ├── plan-resources.md                # generated — per-module plan
│   └── plan-gpo.md                      # generated — per-module plan
├── tests/
│   ├── helpers/
│   │   └── login.ts                     # reusable login function (not a test file)
│   ├── generated/                        # AI-generated specs — cleared before each run
│   │   ├── accounts/
│   │   ├── dashboard/
│   │   └── navigation/
│   ├── fixtures.ts                       # Playwright fixture — auto-login before each test
│   └── seed.spec.ts                     # smoke test for the login flow
├── tools/
│   ├── agent-definition.ts
│   ├── copilot-client.ts
│   ├── project.ts
│   └── scan-project.ts
├── export-last-run.ps1                   # exports artifacts from the last run
├── orchestrator.config.json
├── orchestrator.ts
├── package.json
├── playwright.config.ts
└── tsconfig.json
```

## 5. Configuration

### orchestrator.config.json

```json
{
  "projectFolder": "E:\\arm-arm\\WebClient\\GrantMa.Web",
  "appUrl": "https://localhost",
  "seedFile": "tests/seed.spec.ts",
  "planFile": "specs/app-plan.md",
  "planFiles": [
    { "file": "specs/plan-navigation.md", "scope": "Global navigation and layout..." },
    { "file": "specs/plan-dashboard.md",  "scope": "Dashboard module (...)" },
    { "file": "specs/plan-accounts.md",  "scope": "Accounts module (...)" },
    { "file": "specs/plan-resources.md", "scope": "Resources module (...)" },
    { "file": "specs/plan-gpo.md",       "scope": "GPO module (...)" }
  ],
  "generatedTestsFolder": "tests/generated",
  "reportsFolder": "reports",
  "maxHealAttempts": 3,
  "testCommand": "npx playwright test tests/generated"
}
```

| Field | Description |
| --- | --- |
| `projectFolder` | Path to the read-only target application source. |
| `appUrl` | URL of the already-running application. |
| `seedFile` | Playwright spec used as a reference by the planner and generator. |
| `planFile` | Fallback plan file used when `planFiles` is not set. |
| `planFiles` | Array of `{ file, scope }` objects — one planner + generator run per entry. Enables per-module batching to avoid timeouts. |
| `generatedTestsFolder` | Destination for all generated `.spec.ts` files — cleared before each run. |
| `reportsFolder` | Destination for `orchestrator-summary.json`. |
| `maxHealAttempts` | Maximum healer iterations after a test failure. |
| `testCommand` | Shell command used to run the generated tests. |

### .env (credentials)

Create a `.env` file at the workspace root (git-ignored):

```env
APP_URL=https://localhost
APP_USERNAME=domain\username
APP_PASSWORD=your-password
```

These are read by `tests/helpers/login.ts` via `process.env` and are also passed to the Copilot agent subprocess as environment variables.

### Path rules

- `projectFolder` identifies the read-only target application.
- `seedFile`, `planFile`, `generatedTestsFolder`, and `reportsFolder` are relative to the orchestrator root.
- Generated paths may not escape the orchestrator workspace.
- `.github/agents` is always resolved relative to the orchestrator configuration file.
- `testCommand` executes from the orchestrator root.
- `.github/agents` is always resolved relative to the orchestrator configuration file.
- `testCommand` executes from the orchestrator root.

### Application URL

`appUrl` must already be reachable. It may be:

- A local application running in another terminal.
- A hosted development environment.
- A staging environment authorized for automated testing.

The orchestrator passes this value to agent subprocesses as `APP_URL`. Ensure the URL protocol matches the running application.

## 6. Agent execution

The files under `.github/agents` are actively loaded at runtime. Their instruction bodies are sent to Codex, while Playwright Test MCP supplies browser and test tools.

The `model` field in GitHub agent front matter is not used by this Codex-based adapter. Set `CODEX_MODEL` when a specific available Codex model is required.

### Planner

For each `PlanTarget` in `planFiles` (or the single `planFile` fallback), the planner:

1. Receives the target scope description and the discovered application routes.
2. Runs `planner_setup_page` to open the live application.
3. Explores the UI through browser tools — navigating, clicking, and inspecting.
4. Discards source code details that conflict with the live UI (UI is the source of truth).
5. Saves a structured Markdown plan to the configured `file` path (e.g., `specs/plan-dashboard.md`).

### Generator

For each plan file, the generator:

1. Reads the plan and the seed file reference.
2. Calls `generator_setup_page` to open the live application.
3. Executes each scenario step in the browser and verifies the result.
4. Reads Playwright's generator action log.
5. Writes a single `.spec.ts` file per scenario beneath `tests/generated/<module>/`.
6. Every generated file imports `{ test, expect }` from `../../fixtures` (not from `@playwright/test`) so the auto-login fixture applies automatically.

### Healer

The healer is invoked only after the configured test command fails. It reads `test-results/**/error-context.md` files (page snapshot + error + source at failure point) and repairs the corresponding spec files. It may not modify tests outside `tests/generated` or change the target application.

## 7. End-to-end workflow

```text
Load config (orchestrator.config.json + .env)
  -> Validate: projectFolder, appUrl, seedFile, agent files, output folders
  -> Scan target application (file paths, frameworks, dependencies)
  -> Discover app modules (find routes.ts or app-routing.module.ts)
  -> Determine plan targets (planFiles array or single planFile)
  -> Clear tests/generated/ folder
  -> For each PlanTarget:
       -> Run planner  -> writes specs/plan-<module>.md
       -> Run generator -> writes tests/generated/<module>/*.spec.ts
       -> On generator failure: check for partial files, continue if any found
  -> Confirm at least one spec file was generated
  -> Run: npx playwright test tests/generated
  -> If failed: run healer and rerun, up to maxHealAttempts
  -> Write reports/orchestrator-summary.json
  -> Exit 0 on success, 1 on failure
```

The orchestrator sets a non-zero exit status when configuration, an agent, generation, testing, or healing fails.

## 8. Installation and execution

### Requirements

- Node.js 20 or newer.
- npm.
- Access to Codex authentication.
- A reachable target application.
- Permission to automate the target environment.

### Repository setup

On macOS or Linux:

```bash
npm ci
npx playwright install chromium
npm run build
```

The same npm commands work in Windows PowerShell. A portable kit also includes
`setup.ps1`, which performs installation, browser setup, validation, and build:

```powershell
.\setup.ps1
```

If PowerShell blocks local scripts, run this once in the current terminal only:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

To reuse an existing Playwright browser installation:

```powershell
.\setup.ps1 -SkipBrowsers
```

### Complete Windows walkthrough

Use a normal, non-administrator PowerShell terminal.

1. Install Node.js 20 or newer from the Node.js website. Git is also recommended
   when the project is obtained from source control.
2. Open PowerShell in the repository or portable-kit directory and confirm the
   required commands are available:

   ```powershell
   node --version
   npm --version
   ```

3. Allow the setup script for the current PowerShell process. This does not
   permanently change the machine's execution policy:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   ```

4. Install locked npm dependencies, Chromium, and compile the orchestrator:

   ```powershell
   .\setup.ps1
   ```

   Use `.\setup.ps1 -SkipBrowsers` only when the Playwright Chromium browser is
   already installed. Setup details are written to `logs\setup.log`.

5. Authenticate Codex. For API-key authentication, set the key in the current
   terminal so it is inherited by the Codex agent processes:

   ```powershell
   $env:OPENAI_API_KEY = "your-api-key"
   ```

   Alternatively, use an existing supported Codex CLI login. Never commit an
   API key to this repository.

6. Review `orchestrator.config.json`. Windows accepts the forward-slash relative
   paths shown in the supplied configuration. Set `projectFolder` to the target
   application's source directory and set `appUrl` to its running URL.

7. Start the target application in a separate PowerShell terminal. For the
   included Angular example:

   ```powershell
   Set-Location .\angular-app
   npm ci
   npm start
   ```

   Leave this terminal running. Verify that `http://localhost` opens before
   starting orchestration. For another target application, use that project's
   normal start command and update `appUrl` accordingly.

8. Return to the orchestrator directory and run:

   ```powershell
   npm run generate
   ```

9. Review the generated artifacts:

   ```text
   specs\plan-*.md
   tests\generated\**\*.spec.ts
   reports\orchestrator-summary.json
   playwright-report\
   ```

10. Re-run tests, open the report, or export artifacts:

    ```powershell
    npm run test:generated
    npm run report
    npm run export
    npm run export:zip
    ```

The target application must remain running while the planner, generator,
Playwright runner, and healer use it.

### Run orchestration

```bash
npm run generate
```

### Other commands

```bash
npm run build          # compile TypeScript
npm run test:generated # run generated tests only
npm run report         # open the HTML report
npm run export         # export last-run artifacts to exports/run-<timestamp>/
npm run export:zip     # same, compressed as a .zip
```

## 9. Portable deliverable

Create a clean, source-only distribution:

```bash
./scripts/export-deliverable.sh
```

The default output is:

```text
playwright-ai-orchestrator-kit/
```

The export excludes the sample target application, `node_modules`, compiled output, generated plans, generated tests, and reports. This prevents application-specific artifacts from contaminating the next target.

After copying the kit elsewhere:

macOS/Linux:

```bash
cd playwright-ai-orchestrator-kit
./setup.sh
```

Windows PowerShell:

```powershell
Set-Location playwright-ai-orchestrator-kit
.\setup.ps1
```

To use preinstalled Playwright browsers:

```bash
./setup.sh --skip-browsers
```

Setup actions are recorded in `logs/setup.log`; export actions are recorded in the source repository's `logs/export.log`.

## 10. Outputs

| Output | Description |
| --- | --- |
| `specs/plan-*.md` | Per-module test plans generated by the planner. |
| `tests/generated/**/*.spec.ts` | Generated Playwright test cases (cleared and recreated each run). |
| `reports/orchestrator-summary.json` | Final status, generated file list, test run count, heal attempts, last test output, and error. |
| `playwright-report/` | HTML report updated after every test run (line reporter shows live progress). |
| `test-results/**/error-context.md` | Per-failing-test page snapshot and error — consumed by the healer. |
| `exports/run-<timestamp>/` | Artifact bundle created by `npm run export`. |
| `logs/setup.log` | Portable-kit setup log. |

## 11. Security considerations

Playwright interaction tools require approval. Because orchestration is non-interactive, the Codex subprocess uses `--dangerously-bypass-approvals-and-sandbox`. This is necessary for unattended browser interaction but removes Codex approval prompts and sandboxing.

Consequently:

- Use only trusted agent definitions.
- Run only against applications and environments you are authorized to test.
- Review changes to `.github/agents` before execution.
- Avoid placing secrets in source files, plans, test data, or prompts.
- Prefer isolated development or staging environments.
- Keep the target application under source control or otherwise recoverable.
- Do not run the orchestrator with elevated operating-system privileges.

## 12. Troubleshooting

### `spawn codex ENOENT`

Run `npm ci`. The project includes `@openai/codex`, and the adapter resolves `node_modules/.bin/codex` before falling back to `PATH`.

On Windows, also rebuild after installing dependencies:

```powershell
npm run build
npx codex --version
```

### PowerShell says script execution is disabled

Allow scripts only for the current terminal, then retry setup:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

### `OPENAI_API_KEY` is not recognized or authentication fails

Set the variable and run orchestration in the same PowerShell terminal:

```powershell
$env:OPENAI_API_KEY = "your-api-key"
npx codex --version
npm run orchestrate
```

Opening a new terminal clears a process-scoped environment variable.

### `user cancelled MCP tool call`

Rebuild after confirming the Codex client contains the unattended automation flag:

```bash
npm run build
```

Do not interrupt the agent while it is interacting with the browser.

### Seed test not found or outside `testDir`

Keep the seed under the Playwright `testDir`. The default is `tests/seed.spec.ts`.

### Generator created no `.spec.ts` files

Check, in order:

1. The target URL is reachable.
2. The seed is discovered by `npx playwright test --list tests/seed.spec.ts`.
3. Browser binaries are installed.
4. The planner generated `specs/app-plan.md`.
5. MCP calls were not interrupted or permission-denied.

### Target application specs compile during orchestrator build

The root `tsconfig.json` must include only `orchestrator.ts` and `tools/**/*.ts`. Target source must not be part of the orchestrator build.

### Shell reports `compdef: command not found`

This is a Zsh completion-initialization issue, not an orchestrator failure. Ensure `compinit` runs before completion scripts in the shell profile.

## 13. Reusing with another application

1. Copy the portable kit.
2. Run `./setup.sh`.
3. Put the new application source under `target-app`, or update `projectFolder`.
4. Set the correct `appUrl`.
5. Update the seed when authentication or initial navigation differs.
6. Start the application separately.
7. Run `npm run orchestrate`.
8. Review the generated plan and tests before committing them.

No orchestrator source change should be required for ordinary target-application replacement.
