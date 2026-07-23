# Installs the WasteHero Dev Hub daemon on this machine (the session host):
# builds it, registers an auto-starting logon task with a crash-restart loop,
# and starts it now. Run from an elevated or normal PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\install-daemon.ps1
param(
    [string]$DataDir = "$env:USERPROFILE\.wh-dev-hub",
    [string]$TaskName = "WasteHero Dev Hub Daemon"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "== WasteHero Dev Hub daemon install ==" -ForegroundColor Cyan
Write-Host "repo:     $repoRoot"
Write-Host "data dir: $DataDir"

# 1. Dependencies + build
Push-Location $repoRoot
try {
    node --version | Out-Null
} catch {
    throw "Node.js is required (v22+). Install it first."
}
npm install
npm run build -w daemon
Pop-Location

# 2. Stop a previous instance if any
schtasks /End /TN $TaskName 2>$null | Out-Null
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*daemon\dist\index.cjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }

# 3. Register logon task (runs as the current user, hidden window)
$runner = Join-Path $repoRoot 'deploy\run-daemon.ps1'
$action = "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -DataDir `"$DataDir`""
schtasks /Create /F /TN $TaskName /TR $action /SC ONLOGON /RL LIMITED | Out-Null
Write-Host "registered logon task '$TaskName'"

# 4. Start it now
Start-Process powershell -WindowStyle Hidden -ArgumentList "-ExecutionPolicy Bypass -File `"$runner`" -DataDir `"$DataDir`""
Start-Sleep -Seconds 3

$configPath = Join-Path $DataDir 'config.json'
if (Test-Path $configPath) {
    Write-Host ""
    Write-Host "Daemon is up. Config: $configPath" -ForegroundColor Green
    Write-Host "Next steps (see DEPLOY.md):"
    Write-Host "  - set `"host`": `"0.0.0.0`" (or the Tailscale IP) so clients can reach it"
    Write-Host "  - set slack.publicHost to this machine's Tailscale hostname"
    Write-Host "  - update the Slack app redirect URL to match"
    Write-Host "  - allow ports 7811/7812 in Windows Firewall for the Tailscale network"
} else {
    Write-Warning "daemon did not write $configPath yet — check $DataDir\daemon.log"
}
