# One-time (ELEVATED) setup so the daemon can be restarted WITHOUT a UAC
# prompt - needed to apply daemon updates remotely (the Restart-Service UAC
# dialog only appears on this PC's secure desktop, unclickable from home).
#
# It registers a pre-elevated on-demand scheduled task. Afterwards, restart the
# daemon from ANY hub session (no elevation, no prompt) with:
#     schtasks /Run /TN "WH Restart Daemon"
#
# Keep this file ASCII-only (Windows PowerShell 5.1 + UTF-8 no BOM).
param([string]$TaskName = 'WH Restart Daemon')

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this once from an elevated (Administrator) PowerShell." }

$svc = (Get-Service -DisplayName 'WasteHero Dev Hub' -ErrorAction Stop).Name
# Point at the robust restart script (self-heals the winsw orphan wedge)
# rather than a plain Restart-Service.
$restartScript = Join-Path $PSScriptRoot 'restart-daemon.ps1'
$action = "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$restartScript`""

# Run level HIGHEST + run as the current (admin) user: Task Scheduler stores
# the elevation, so a later `schtasks /Run` triggers it elevated with no UAC.
cmd /c "schtasks /Create /F /TN `"$TaskName`" /TR `"$action`" /SC ONCE /ST 00:00 /RL HIGHEST /RU `"$env:USERNAME`""
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed ($LASTEXITCODE)" }

Write-Host ""
Write-Host "Done. From now on, restart the daemon (no UAC, from any session) with:" -ForegroundColor Green
Write-Host "    schtasks /Run /TN `"$TaskName`""
Write-Host ""
Write-Host "Verify now (should restart the service without a prompt):"
Write-Host "    schtasks /Run /TN `"$TaskName`" ; Start-Sleep 4 ; Get-Service $svc"
