#requires -Version 5.1
<#
  Registers the OPPS CCTV gateway to start automatically at Windows logon and
  opens the gateway port on the Private firewall profile only.

  Run in an elevated PowerShell (Administrator) from the gateway folder:
    powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
#>
param(
  [int]$Port = 8089,
  [string]$TaskName = 'OppsCctvGateway'
)

$ErrorActionPreference = 'Stop'

$gatewayDir = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start-gateway.ps1'

if (-not (Test-Path $startScript)) { throw "start-gateway.ps1 not found next to this script" }
if (-not (Test-Path (Join-Path $gatewayDir '.env'))) {
  throw "gateway/.env is missing. Copy .env.example to .env and configure it first."
}

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`"" `
  -WorkingDirectory $gatewayDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'OPPS CCTV local gateway' -Force | Out-Null
Write-Host "Scheduled task '$TaskName' registered (runs at logon as $env:USERNAME)." -ForegroundColor Green

$ruleName = "OPPS CCTV Gateway TCP $Port (Private)"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
  Write-Host "Firewall rule created: inbound TCP $Port allowed on the Private profile only." -ForegroundColor Green
} else {
  Write-Host "Firewall rule already exists: $ruleName" -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host "  1. Start it now:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  2. Local URL:     http://<this-PC-LAN-IP>:$Port"
Write-Host '  3. Remote access: install Tailscale, then open http://<tailscale-ip>:8089 from your phone/laptop.'
Write-Host '  Never port-forward the DVR or gateway on your router.' -ForegroundColor Yellow
