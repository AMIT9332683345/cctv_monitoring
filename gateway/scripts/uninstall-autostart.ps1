#requires -Version 5.1
<#
  Removes the OPPS CCTV gateway auto-start task and its Windows firewall rule.
  Run in an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-autostart.ps1
#>
param(
  [int]$Port = 8089,
  [string]$TaskName = 'OppsCctvGateway'
)

$ErrorActionPreference = 'Stop'
$ruleName = "OPPS CCTV Gateway TCP $Port (Private)"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
} else {
  Write-Host "Scheduled task '$TaskName' was not present." -ForegroundColor Yellow
}

if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName $ruleName
  Write-Host "Removed firewall rule '$ruleName'." -ForegroundColor Green
} else {
  Write-Host "Firewall rule '$ruleName' was not present." -ForegroundColor Yellow
}
