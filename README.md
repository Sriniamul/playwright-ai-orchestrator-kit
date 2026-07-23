# Playwright AI Orchestrator Kit

Full documentation: [`docs/PLAYWRIGHT_AI_ORCHESTRATOR.md`](docs/PLAYWRIGHT_AI_ORCHESTRATOR.md)

Architecture and flow diagrams: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Setup

macOS/Linux:

```bash
chmod +x setup.sh
./setup.sh
```

Windows PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

## Configure and run

1. Set the target application path and credentials in `orchestrator.config.json` and `.env`.
2. Define per-module plan targets in `planFiles` (or use the single `planFile` fallback).
3. Start the target application separately.
4. Run `npm run generate`.

```bash
# Full orchestration: plan → generate → test → heal
npm run generate

# Run only the generated tests
npm run test:generated

# Open the HTML report from the last test run
npm run report

# Export artifacts from the last run (logs, specs, test results)
npm run export          # folder
npm run export:zip      # compressed ZIP
```

## Key files

| File | Purpose |
|---|---|
| `orchestrator.config.json` | Target app path, URLs, plan targets, heal attempts |
| `.env` | `APP_URL`, `APP_USERNAME`, `APP_PASSWORD` (git-ignored) |
| `tests/helpers/login.ts` | Reusable login function used by all tests |
| `tests/fixtures.ts` | Playwright fixture — auto-logs in before every test |
| `tests/seed.spec.ts` | Smoke test that verifies the login flow works |
| `tests/generated/` | AI-generated spec files (cleared before each run) |
| `specs/` | Test plan Markdown files (one per module) |
| `reports/orchestrator-summary.json` | Machine-readable run summary |

See [`docs/PLAYWRIGHT_AI_ORCHESTRATOR.md`](docs/PLAYWRIGHT_AI_ORCHESTRATOR.md) for the complete walkthrough.

