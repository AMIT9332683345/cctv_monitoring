#requires -Version 5.1
<#
  Starts the OPPS CCTV gateway in the foreground.
  Run from anywhere:  powershell -ExecutionPolicy Bypass -File .\scripts\start-gateway.ps1
#>
$ErrorActionPreference = 'Stop'

$gatewayDir = Split-Path -Parent $PSScriptRoot
Set-Location $gatewayDir

if (-not (Test-Path (Join-Path $gatewayDir '.env'))) {
  Write-Host 'Missing gateway/.env — copy .env.example to .env and fill in AUTH_SECRET.' -ForegroundColor Red
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js 20+ is required. Install it from https://nodejs.org' -ForegroundColor Red
  exit 1
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  Write-Host 'FFmpeg was not found on PATH. Install it (winget install Gyan.FFmpeg) and restart the terminal.' -ForegroundColor Yellow
}

Write-Host 'Starting OPPS CCTV gateway...' -ForegroundColor Cyan
node --enable-source-maps .\src\index.mjs
