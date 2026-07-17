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
| `tools/codex-client.ts` | Runs Codex non-interactively and attaches Playwright Test MCP. |
| `tools/project.ts` | Scans and summarizes the target application. |
| `.github/agents/` | Source-of-truth planner, generator, and healer instructions. |
| `tests/seed.spec.ts` | Establishes the initial browser state and application URL. |
| `playwright.config.ts` | Defines browsers and Playwright execution behavior. |

## 4. Directory structure

```text
playwright-agent-orchestrator/
|-- .github/
|   `-- agents/
|       |-- playwright-test-planner.agent.md
|       |-- playwright-test-generator.agent.md
|       `-- playwright-test-healer.agent.md
|-- docs/
|   `-- PLAYWRIGHT_AI_ORCHESTRATOR.md
|-- reports/
|   `-- orchestrator-summary.json       # generated
|-- scripts/
|   |-- export-deliverable.sh
|   `-- setup-deliverable.sh
|-- specs/
|   |-- README.md
|   `-- app-plan.md                     # generated
|-- tests/
|   |-- generated/                      # generated
|   `-- seed.spec.ts
|-- tools/
|   |-- agent-definition.ts
|   |-- codex-client.ts
|   |-- codex-clients.ts
|   |-- project.ts
|   `-- scan-project.ts
|-- target-app/                         # portable-kit placeholder
|-- orchestrator.config.json
|-- orchestrator.ts
|-- package.json
|-- playwright.config.ts
`-- tsconfig.json
```

## 5. Configuration

Example `orchestrator.config.json`:

```json
{
  "projectFolder": "./target-app",
  "appUrl": "http://localhost:4200",
  "seedFile": "tests/seed.spec.ts",
  "planFile": "specs/app-plan.md",
  "generatedTestsFolder": "tests/generated",
  "reportsFolder": "reports",
  "maxHealAttempts": 3,
  "testCommand": "npx playwright test tests/generated --reporter=line"
}
```

### Path rules

- `projectFolder` identifies the read-only target application.
- `seedFile`, `planFile`, `generatedTestsFolder`, and `reportsFolder` are relative to the orchestrator root.
- Generated paths may not escape the orchestrator workspace.
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

The planner:

1. Runs `planner_setup_page` using `tests/seed.spec.ts`.
2. Explores the live application through browser tools.
3. May use the target source summary to clarify routes and features.
4. Saves a structured plan to `specs/app-plan.md`.

### Generator

The generator:

1. Reads the plan and seed test.
2. Sets up a browser page for each scenario.
3. Performs and verifies scenario steps against the live UI.
4. Reads Playwright's generator action log.
5. Writes `.spec.ts` files beneath `tests/generated`.

### Healer

The healer is invoked only after the configured test command fails. It may inspect the browser and generated files, but orchestration instructions prohibit it from modifying pre-existing tests outside `tests/generated` or changing the target application.

## 7. End-to-end workflow

```text
Load config
  -> Validate target folder, seed, agents, URL syntax, and output folders
  -> Scan target application
  -> Run planner
  -> Confirm plan exists
  -> Run generator
  -> Confirm generated specs exist
  -> Run generated tests
  -> If failed: heal and rerun up to maxHealAttempts
  -> Write final summary and process exit status
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

   Leave this terminal running. Verify that `http://localhost:4200` opens before
   starting orchestration. For another target application, use that project's
   normal start command and update `appUrl` accordingly.

8. Return to the orchestrator directory in the first terminal and run:

   ```powershell
   npm run orchestrate
   ```

9. Review the generated artifacts:

   ```text
   specs\app-plan.md
   tests\generated\*.spec.ts
   reports\orchestrator-summary.json
   playwright-report\
   ```

10. Run generated tests again or open the HTML report when needed:

    ```powershell
    npm run test:generated
    npm run report
    ```

The target application must remain running while the planner, generator,
Playwright runner, and healer use it.

### Run orchestration

```bash
npm run orchestrate
```

### Other commands

```bash
npm run build
npm run test:generated
npm run report
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
| `specs/app-plan.md` | Application-specific plan generated by the planner. It is intentionally absent from a clean export. |
| `tests/generated/**/*.spec.ts` | Generated Playwright test cases. |
| `reports/orchestrator-summary.json` | Final status, generated files, run count, healing attempts, output excerpt, and error. |
| `playwright-report/` | Playwright HTML report when enabled. |
| `test-results/` | Failure artifacts such as traces and error context. |
| `logs/setup.log` | Portable-kit setup log. |
| `logs/export.log` | Deliverable-export log. |

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
