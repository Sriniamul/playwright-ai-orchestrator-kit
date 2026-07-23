# Architecture

## Overview

The Playwright AI Orchestrator creates and maintains end-to-end tests for an already-running web application. The target application source is read-only. All plans, generated tests, reports, agent definitions, and orchestration code live in the orchestrator workspace.

---

## Component diagram

```mermaid
flowchart TB
    User[User / CI Pipeline] -->|npm run generate| Orchestrator

    subgraph Workspace[Playwright AI Orchestrator Workspace]
        Config[orchestrator.config.json\n+ .env]
        Orchestrator[PlaywrightOrchestrator\norchestrator.ts]
        Scanner[Project Scanner\ntools/project.ts]
        Modules[Module Discoverer\ndiscoverModules]
        AgentLoader[Agent Definition Loader\ntools/agent-definition.ts]
        Planner[Planner Agent\n.github/agents/]
        Generator[Generator Agent\n.github/agents/]
        Healer[Healer Agent\n.github/agents/]
        Copilot[GitHub Copilot CLI\ntools/copilot-client.ts]
        MCP[Playwright Test MCP Server]
        LoginHelper[tests/helpers/login.ts]
        Fixture[tests/fixtures.ts]
        Seed[tests/seed.spec.ts]
        Plans[specs/plan-*.md]
        Generated[tests/generated/**]
        Runner[Playwright Test Runner]
        Reports[reports/orchestrator-summary.json]
        Export[export-last-run.ps1]
    end

    subgraph Target[Target Application — Read Only]
        Source[Source Files\nroutes, components, config]
        LiveApp[Running UI\nhttps://localhost]
    end

    Config --> Orchestrator
    Orchestrator --> Scanner
    Scanner -->|read file paths and metadata| Source
    Orchestrator --> Modules
    Modules -->|find routes.ts / app-routing.module.ts| Source

    Orchestrator --> AgentLoader
    AgentLoader --> Planner
    AgentLoader --> Generator
    AgentLoader --> Healer

    Orchestrator -->|per plan target| Planner
    Planner --> Copilot
    Copilot --> MCP
    MCP <-->|browser exploration| LiveApp
    Planner -->|write| Plans

    Orchestrator -->|per plan target| Generator
    Plans --> Generator
    Generator --> Copilot
    MCP -->|verify interactions| Generator
    Generator -->|write spec files| Generated

    Orchestrator --> Runner
    Generated --> Runner
    Runner <-->|execute tests| LiveApp
    Runner -->|pass| Reports
    Runner -->|failure + error-context.md| Healer
    Healer --> Copilot
    Healer -->|repair tests| Generated
    Healer -->|rerun| Runner

    Runner --> Reports
    Reports --> Export

    subgraph AuthFlow[Authentication — per test]
        Fixture --> LoginHelper
        LoginHelper -->|fill credentials| LiveApp
        Seed --> LoginHelper
    end

    Generated -->|import test, expect| Fixture
```

---

## Orchestrator execution flow

```mermaid
flowchart TD
    A([Start: npm run generate]) --> B[loadConfig\norchestrator.config.json]
    B --> C[validateInputs\ncheck projectFolder, appUrl, seedFile, agents]
    C --> D[scanProjectFolder\nfile paths, frameworks, dependencies]
    D --> E[discoverModules\nfind routing file in source]
    E --> F{planFiles\nconfigured?}

    F -->|Yes: array of PlanTargets| G[Use planFiles array]
    F -->|No| H[Use single planFile as default target]
    G --> I
    H --> I

    I[Clear tests/generated/ folder] --> J

    subgraph Loop[For each PlanTarget]
        J[runPlanner\nAI explores live app → writes plan-*.md] --> K[runGenerator\nAI reads plan, executes steps in browser\nwrites .spec.ts files]
        K --> L{Generator\nsucceeded?}
        L -->|Yes| M[Accumulate generatedFiles]
        L -->|No — timeout or error| N{Partial files\nwritten?}
        N -->|Yes| M
        N -->|No and no files yet| O([Throw — abort])
        M --> P{More\ntargets?}
        P -->|Yes| J
        P -->|No| Q
    end

    Q{Any spec files\ngenerated?} -->|No| R([Throw — no tests])
    Q -->|Yes| S[runTests\nnpx playwright test tests/generated]
    S --> T{All\npassed?}
    T -->|Yes| U[successful = true]
    T -->|No| V{healAttempts\n< maxHealAttempts?}
    V -->|Yes| W[runHealer\nAI reads error-context.md, fixes tests]
    W --> S
    V -->|No| X[successful = false]
    U --> Y[showFinalSummary\nreports/orchestrator-summary.json]
    X --> Y
    Y --> Z([End])
```

---

## Authentication flow (per test)

```mermaid
sequenceDiagram
    participant Test as Generated Test
    participant Fixture as tests/fixtures.ts
    participant Login as tests/helpers/login.ts
    participant App as Live App (https://localhost)

    Test->>Fixture: import { test, expect }
    Note over Fixture: page fixture overrides base
    Fixture->>Login: login(page)
    Login->>App: page.goto(APP_URL)
    App-->>Login: redirect to /auth/login
    Login->>App: fill USERNAME + PASSWORD
    Login->>App: click Login
    App-->>Login: MFA dialog or dashboard redirect
    loop Up to 5 attempts
        Login->>Login: waitForLoadState('domcontentloaded')
        Login->>Login: check current URL
        alt URL contains /dashboard/
            Login->>Login: break — authenticated
        else MFA skipsetup link visible
            Login->>App: click MFA Skip
        else any Skip link visible
            Login->>App: click Skip
        else
            Login->>Login: waitForTimeout(1000)
        end
    end
    Login->>App: waitForURL('**/dashboard/**')
    App-->>Login: /dashboard/start loaded
    Login-->>Fixture: authenticated page
    Fixture-->>Test: page (ready to use)
    Test->>App: page.goto('/accounts') etc.
```

---

## Directory structure

```text
playwright-ai-orchestrator-kit/
├── .env                                  # credentials (git-ignored)
├── .github/
│   └── agents/
│       ├── playwright-test-planner.agent.md
│       ├── playwright-test-generator.agent.md
│       └── playwright-test-healer.agent.md
├── docs/
│   ├── ARCHITECTURE.md                   # this file
│   └── PLAYWRIGHT_AI_ORCHESTRATOR.md
├── exports/                              # created by npm run export
├── reports/
│   └── orchestrator-summary.json        # generated
├── specs/
│   ├── app-plan.md                       # fallback single plan
│   ├── plan-navigation.md               # generated (per module)
│   ├── plan-dashboard.md                # generated (per module)
│   ├── plan-accounts.md                 # generated (per module)
│   ├── plan-resources.md                # generated (per module)
│   └── plan-gpo.md                      # generated (per module)
├── tests/
│   ├── helpers/
│   │   └── login.ts                     # reusable login function
│   ├── generated/                        # AI-generated specs (cleared per run)
│   │   ├── accounts/
│   │   ├── dashboard/
│   │   └── navigation/
│   ├── fixtures.ts                       # auto-login Playwright fixture
│   └── seed.spec.ts                     # smoke test for login flow
├── tools/
│   ├── agent-definition.ts
│   ├── copilot-client.ts
│   ├── project.ts
│   └── scan-project.ts
├── export-last-run.ps1                   # artifact export script
├── orchestrator.config.json
├── orchestrator.ts
├── package.json
├── playwright.config.ts
└── tsconfig.json
```

    Reports --> User
```

## Execution flow

1. The orchestrator loads `orchestrator.config.json` and validates the target folder, agent definitions, seed test, and output paths.
2. The project scanner reads the target application structure without modifying it.
3. The planner uses the seed and Playwright MCP browser tools to explore the live application and writes `specs/app-plan.md`.
4. The generator executes every planned scenario against the live UI and writes verified Playwright tests under `tests/generated`.
5. Playwright runs only the generated-test folder.
6. When tests fail, the healer debugs and updates generated tests, then the orchestrator reruns them up to `maxHealAttempts`.
7. The final status is written to `reports/orchestrator-summary.json`.

## Core design decisions

- **Target isolation:** `projectFolder` is read-only application context, not a location for Playwright artifacts.
- **Live verification:** tests are based primarily on real browser interactions rather than source-code guesses.
- **Agent source of truth:** planner, generator, and healer instructions come from `.github/agents`.
- **Portable outputs:** generated plans, tests, reports, and logs stay in the orchestrator workspace.
- **Replaceable target:** another application can be tested by changing `projectFolder`, `appUrl`, and the seed setup.

## Main deliverables

| Deliverable | Purpose |
| --- | --- |
| `specs/app-plan.md` | Generated functional test plan. |
| `tests/generated/*.spec.ts` | Generated Playwright tests. |
| `reports/orchestrator-summary.json` | Workflow status and failure summary. |
| `playwright-report/` | Playwright HTML execution report when enabled. |
| `logs/*.log` | Setup and export activity logs. |
