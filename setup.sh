#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  ROOT_DIR="$SCRIPT_DIR"
else
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/setup.log"
INSTALL_BROWSERS=true

if [[ "${1:-}" == "--skip-browsers" ]]; then
  INSTALL_BROWSERS=false
fi

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

log() {
  local level="$1"
  shift
  printf '%s [%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$level" "$*" | tee -a "$LOG_FILE"
}

on_error() {
  local exit_code=$?
  log ERROR "Setup failed at line ${BASH_LINENO[0]} with exit code $exit_code."
  exit "$exit_code"
}
trap on_error ERR

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log ERROR "Required command not found: $1"
    return 1
  fi
  log INFO "Found $1 at $(command -v "$1")."
}

log INFO "Starting Playwright AI Orchestrator setup in $ROOT_DIR."
require_command node
require_command npm

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  log ERROR "Node.js 20 or newer is required; found $(node --version)."
  exit 1
fi
log INFO "Using Node.js $(node --version) and npm $(npm --version)."

for directory in \
  "$ROOT_DIR/logs" \
  "$ROOT_DIR/reports" \
  "$ROOT_DIR/specs" \
  "$ROOT_DIR/tests/generated" \
  "$ROOT_DIR/target-app"; do
  mkdir -p "$directory"
  log INFO "Ensured directory exists: ${directory#"$ROOT_DIR/"}."
done

for required_file in \
  package.json \
  package-lock.json \
  tsconfig.json \
  playwright.config.ts \
  orchestrator.ts \
  orchestrator.config.json \
  tests/seed.spec.ts \
  .github/agents/playwright-test-planner.agent.md \
  .github/agents/playwright-test-generator.agent.md \
  .github/agents/playwright-test-healer.agent.md; do
  if [[ ! -f "$ROOT_DIR/$required_file" ]]; then
    log ERROR "Missing deliverable file: $required_file"
    exit 1
  fi
  log INFO "Validated deliverable file: $required_file."
done

log INFO "Installing locked npm dependencies."
(cd "$ROOT_DIR" && npm ci) 2>&1 | tee -a "$LOG_FILE"

if [[ "$INSTALL_BROWSERS" == true ]]; then
  log INFO "Installing the Playwright Chromium browser."
  (cd "$ROOT_DIR" && npx playwright install chromium) 2>&1 | tee -a "$LOG_FILE"
else
  log INFO "Skipping browser installation by request."
fi

log INFO "Building the TypeScript orchestrator."
(cd "$ROOT_DIR" && npm run build) 2>&1 | tee -a "$LOG_FILE"

log INFO "Checking local Codex and Playwright executables."
(cd "$ROOT_DIR" && node_modules/.bin/codex --version) 2>&1 | tee -a "$LOG_FILE"
(cd "$ROOT_DIR" && npx playwright --version) 2>&1 | tee -a "$LOG_FILE"

log INFO "Setup completed successfully. Update orchestrator.config.json, place or point to the target app, start appUrl, then run npm run orchestrate."
