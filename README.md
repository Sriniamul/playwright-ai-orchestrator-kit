# Playwright AI Orchestrator Kit

Full documentation: [`docs/PLAYWRIGHT_AI_ORCHESTRATOR.md`](docs/PLAYWRIGHT_AI_ORCHESTRATOR.md)

## Setup

```bash
chmod +x setup.sh
./setup.sh
```

Use `./setup.sh --skip-browsers` when Playwright browsers are already installed.

## Configure and run

1. Place the application source in `target-app/`, or update `projectFolder`.
2. Update `appUrl` and `tests/seed.spec.ts` when required.
3. Start the target application separately.
4. Run `npm run orchestrate`.

Generated plans, tests, reports, and setup logs remain outside the target application.
