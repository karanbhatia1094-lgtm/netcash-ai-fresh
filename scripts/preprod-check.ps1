param()

$ErrorActionPreference = "Stop"

Write-Host "== Netcash.ai Pre-Production Check ==" -ForegroundColor Cyan

function Run-Step {
  param(
    [string]$Name,
    [string]$Command
  )
  Write-Host ""
  Write-Host "-> $Name" -ForegroundColor Yellow
  Write-Host "   $Command" -ForegroundColor DarkGray
  Invoke-Expression $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed: $Name (exit code: $LASTEXITCODE)"
  }
}

Run-Step -Name "Build" -Command "npm run build"
Run-Step -Name "Lint" -Command "npm run lint"
Run-Step -Name "Tests" -Command "npm run test"

Write-Host ""
Write-Host "All automated checks completed." -ForegroundColor Green
Write-Host "Manual store-integrated checklist: docs/UAT_PREPROD_RUNBOOK.md" -ForegroundColor Green
