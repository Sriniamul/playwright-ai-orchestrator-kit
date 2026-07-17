[CmdletBinding()]
param(
  [switch]$SkipBrowsers
)

$ErrorActionPreference = "Stop"
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDirectory = if (Test-Path (Join-Path $ScriptDirectory "package.json")) {
  $ScriptDirectory
} else {
  Split-Path -Parent $ScriptDirectory
}
$LogDirectory = Join-Path $RootDirectory "logs"
$LogFile = Join-Path $LogDirectory "setup.log"

New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

function Write-SetupLog {
  param([string]$Level, [string]$Message)
  $Line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $Level, $Message
  $Line | Tee-Object -FilePath $LogFile -Append
}

function Invoke-LoggedCommand {
  param([string]$Command, [string[]]$Arguments)
  & $Command @Arguments 2>&1 | Tee-Object -FilePath $LogFile -Append
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited with code $LASTEXITCODE."
  }
}

try {
  Write-SetupLog "INFO" "Starting Playwright AI Orchestrator setup in $RootDirectory."

  foreach ($Command in @("node", "npm", "npx")) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
      throw "Required command not found: $Command"
    }
  }


$NodeVersion = (& node --version).Trim()

if ($NodeVersion -match '^v(\d+)') {
    $NodeMajor = [int]$Matches[1]
} else {
    throw "Unable to determine Node.js version."
}
  if ($NodeMajor -lt 20) {
    throw "Node.js 20 or newer is required; found $(& node --version)."
  }

  foreach ($Directory in @("logs", "reports", "specs", "tests/generated", "target-app")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $RootDirectory $Directory) | Out-Null
  }

  $RequiredFiles = @(
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "playwright.config.ts",
    "orchestrator.ts",
    "orchestrator.config.json",
    "tests/seed.spec.ts",
    ".github/agents/playwright-test-planner.agent.md",
    ".github/agents/playwright-test-generator.agent.md",
    ".github/agents/playwright-test-healer.agent.md"
  )
  foreach ($File in $RequiredFiles) {
    if (-not (Test-Path -PathType Leaf (Join-Path $RootDirectory $File))) {
      throw "Missing deliverable file: $File"
    }
  }

  Push-Location $RootDirectory
  try {
    Write-SetupLog "INFO" "Installing locked npm dependencies."
    Invoke-LoggedCommand "npm" @("ci")

    if (-not $SkipBrowsers) {
      Write-SetupLog "INFO" "Installing the Playwright Chromium browser."
      Invoke-LoggedCommand "npx" @("playwright", "install", "chromium")
    } else {
      Write-SetupLog "INFO" "Skipping browser installation by request."
    }

    Write-SetupLog "INFO" "Building the TypeScript orchestrator."
    Invoke-LoggedCommand "npm" @("run", "build")
    Invoke-LoggedCommand "npx" @("codex", "--version")
    Invoke-LoggedCommand "npx" @("playwright", "--version")
  } finally {
    Pop-Location
  }

  Write-SetupLog "INFO" "Setup completed successfully. Update orchestrator.config.json, start appUrl, then run npm run orchestrate."
} catch {
  Write-SetupLog "ERROR" $_.Exception.Message
  exit 1
}
