<#
.SYNOPSIS
    Exports all artifacts from the last orchestrator run into a timestamped folder and optional ZIP.

.DESCRIPTION
    Collects and packages:
      - reports/orchestrator-summary.json  (run metadata)
      - tests/generated/**/*.spec.ts       (generated spec files listed in the summary)
      - specs/*.md                         (test plan files, excluding README.md)
      - test-results/**/error-context.md  (healer context for each failing test)
      - playwright-report/**              (HTML test report)
      - logs/setup.log                    (setup log)

.PARAMETER OutputDir
    Directory where the export folder is created. Defaults to 'exports/' inside the workspace.

.PARAMETER Zip
    If set, compresses the export folder into a .zip file and removes the folder.

.EXAMPLE
    .\export-last-run.ps1
    .\export-last-run.ps1 -Zip
    .\export-last-run.ps1 -OutputDir "C:\exports" -Zip
#>
param(
    [string]$OutputDir = "exports",
    [switch]$Zip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot

# ---------------------------------------------------------------------------
# 1. Read orchestrator-summary.json
# ---------------------------------------------------------------------------
$SummaryPath = Join-Path $Root "reports\orchestrator-summary.json"
if (-not (Test-Path $SummaryPath)) {
    Write-Error "No orchestrator-summary.json found at '$SummaryPath'. Run the orchestrator first."
    exit 1
}

$Summary = Get-Content $SummaryPath -Raw | ConvertFrom-Json

# Build export folder name from the run's startedAt timestamp
$Timestamp   = ($Summary.startedAt -replace '[:\.]', '-').Substring(0, 19)
$ExportName  = "run-$Timestamp"
$ExportRoot  = Join-Path (Join-Path $Root $OutputDir) $ExportName

Write-Host ""
Write-Host "=== Playwright AI Orchestrator - Export Last Run ===" -ForegroundColor Cyan
Write-Host "Run started : $($Summary.startedAt)"
Write-Host "Successful  : $($Summary.successful)"
Write-Host "Test runs   : $($Summary.testRuns)   Heal attempts: $($Summary.healAttempts)"
Write-Host "Export to   : $ExportRoot"
Write-Host ""

New-Item -ItemType Directory -Path $ExportRoot -Force | Out-Null

$script:Copied  = @()
$script:Missing = @()

function Copy-Artifact {
    param([string]$Source, [string]$DestRelative)
    $Dest    = Join-Path $ExportRoot $DestRelative
    $DestDir = Split-Path $Dest -Parent
    if (Test-Path $Source) {
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
        Copy-Item -Path $Source -Destination $Dest -Force
        $script:Copied += $DestRelative
    }
    else {
        $script:Missing += $Source
    }
}

function Copy-Tree {
    param([string]$SourceDir, [string]$Filter = "*")
    if (-not (Test-Path $SourceDir)) { return }
    $Items = Get-ChildItem -Path $SourceDir -Recurse -File -Filter $Filter -ErrorAction SilentlyContinue
    foreach ($Item in $Items) {
        $Relative = $Item.FullName.Substring($Root.Length).TrimStart('\', '/')
        $Dest     = Join-Path $ExportRoot $Relative
        $DestDir  = Split-Path $Dest -Parent
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
        Copy-Item -Path $Item.FullName -Destination $Dest -Force
        $script:Copied += $Relative
    }
}

# ---------------------------------------------------------------------------
# 2. orchestrator-summary.json
# ---------------------------------------------------------------------------
Copy-Artifact (Join-Path $Root "reports\orchestrator-summary.json") "reports\orchestrator-summary.json"

# ---------------------------------------------------------------------------
# 3. Generated spec files (from generatedFiles list in summary)
# ---------------------------------------------------------------------------
Write-Host "[ Spec files ]" -ForegroundColor Yellow
if ($Summary.generatedFiles -and $Summary.generatedFiles.Count -gt 0) {
    foreach ($RelPath in $Summary.generatedFiles) {
        $Src = Join-Path $Root $RelPath
        Copy-Artifact $Src $RelPath
    }
    Write-Host "  $($Summary.generatedFiles.Count) spec file(s) listed in summary." -ForegroundColor Green
}
else {
    $GenFolder = Join-Path $Root "tests\generated"
    Write-Host "  No generatedFiles in summary - scanning $GenFolder ..." -ForegroundColor DarkYellow
    Copy-Tree $GenFolder "*.spec.ts"
    Write-Host "  Copied all .spec.ts files found in tests\generated." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 4. Test plan files (specs/*.md, excluding README.md)
# ---------------------------------------------------------------------------
Write-Host "[ Plan files ]" -ForegroundColor Yellow
$PlanFiles = Get-ChildItem -Path (Join-Path $Root "specs") -Filter "*.md" -File -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -ne "README.md" }
foreach ($Plan in $PlanFiles) {
    Copy-Artifact $Plan.FullName "specs\$($Plan.Name)"
}
Write-Host "  $($PlanFiles.Count) plan file(s)." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 5. Test result error-context.md files (one per failing test)
# ---------------------------------------------------------------------------
Write-Host "[ Test results - error contexts ]" -ForegroundColor Yellow
$ErrorContextFiles = Get-ChildItem -Path (Join-Path $Root "test-results") -Recurse -Filter "error-context.md" -ErrorAction SilentlyContinue
foreach ($Ec in $ErrorContextFiles) {
    $Rel = $Ec.FullName.Substring($Root.Length).TrimStart('\', '/')
    Copy-Artifact $Ec.FullName $Rel
}
Write-Host "  $($ErrorContextFiles.Count) error-context.md file(s)." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 6. Playwright HTML report
# ---------------------------------------------------------------------------
Write-Host "[ Playwright HTML report ]" -ForegroundColor Yellow
Copy-Tree (Join-Path $Root "playwright-report")
Write-Host "  Playwright report copied." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 7. Setup log
# ---------------------------------------------------------------------------
Write-Host "[ Logs ]" -ForegroundColor Yellow
Copy-Artifact (Join-Path $Root "logs\setup.log") "logs\setup.log"
Write-Host "  Logs copied." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 8. Write export manifest
# ---------------------------------------------------------------------------
$SpecCount = ($script:Copied | Where-Object { $_ -match '\.spec\.ts$' }).Count
$Manifest  = [ordered]@{
    exportedAt    = (Get-Date -Format "o")
    runStartedAt  = $Summary.startedAt
    runFinishedAt = $Summary.finishedAt
    successful    = $Summary.successful
    specFileCount = $SpecCount
    totalFiles    = $script:Copied.Count
    missingFiles  = $script:Missing
    files         = $script:Copied
}
$ManifestPath = Join-Path $ExportRoot "export-manifest.json"
$Manifest | ConvertTo-Json -Depth 5 | Set-Content $ManifestPath -Encoding UTF8
Write-Host ""
Write-Host "Manifest written: export-manifest.json" -ForegroundColor DarkCyan

# ---------------------------------------------------------------------------
# 9. Optional ZIP
# ---------------------------------------------------------------------------
if ($Zip) {
    $ZipPath = "$ExportRoot.zip"
    Write-Host ""
    Write-Host "Compressing to $ZipPath ..." -ForegroundColor Cyan
    Compress-Archive -Path $ExportRoot -DestinationPath $ZipPath -Force
    Remove-Item -Path $ExportRoot -Recurse -Force
    Write-Host "ZIP created: $ZipPath" -ForegroundColor Green
    $FinalOutput = $ZipPath
}
else {
    $FinalOutput = $ExportRoot
}

# ---------------------------------------------------------------------------
# 10. Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Export complete ===" -ForegroundColor Cyan
Write-Host "  Copied  : $($script:Copied.Count) file(s)"
if ($script:Missing.Count -gt 0) {
    Write-Host "  Missing : $($script:Missing.Count) file(s) (listed in manifest)" -ForegroundColor DarkYellow
}
Write-Host "  Output  : $FinalOutput" -ForegroundColor Green
Write-Host ""
