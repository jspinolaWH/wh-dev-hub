# Installs the WasteHero Dev Hub daemon on this machine (the session host):
# builds it, registers an auto-starting logon task with a crash-restart loop,
# and starts it. Run from an ELEVATED PowerShell (task registration, firewall
# and power settings need admin):
#   powershell -ExecutionPolicy Bypass -File deploy\install-daemon.ps1
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 misdecodes UTF-8
# without BOM, and a stray smart-quote/em-dash breaks the whole parse.
param(
    [string]$DataDir = "$env:USERPROFILE\.wh-dev-hub",
    [string]$TaskName = "WasteHero Dev Hub Daemon"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host "== WasteHero Dev Hub daemon install ==" -ForegroundColor Cyan
Write-Host "repo:     $repoRoot"
Write-Host "data dir: $DataDir"
Write-Host "elevated: $isAdmin"

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

# 2. Stop a previous instance if any. Route schtasks through cmd so a
#    missing task (every first install) cannot throw a NativeCommandError.
cmd /c "schtasks /End /TN `"$TaskName`" >nul 2>&1"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*daemon\dist\index.cjs*' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction Stop } catch {} }

# 3. Register logon task (runs as the current user, hidden window)
$runner = Join-Path $repoRoot 'deploy\run-daemon.ps1'
$action = "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -DataDir `"$DataDir`""
cmd /c "schtasks /Create /F /TN `"$TaskName`" /TR `"$($action -replace '"','\"')`" /SC ONLOGON /RL LIMITED >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    if (-not $isAdmin) {
        Write-Warning "Could not register the logon task (needs an elevated PowerShell)."
        Write-Warning "Re-run this script as Administrator to finish: task + firewall + power settings."
    } else {
        throw "schtasks /Create failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host "registered logon task '$TaskName'" -ForegroundColor Green
}

# 4. Firewall + power settings (admin only; skipped otherwise)
if ($isAdmin) {
    if (-not (Get-NetFirewallRule -DisplayName "WH Dev Hub" -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName "WH Dev Hub" -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort 7811, 7812 -RemoteAddress 100.64.0.0/10 | Out-Null
        Write-Host "firewall rule added (7811/7812 from Tailscale subnet only)" -ForegroundColor Green
    } else {
        Write-Host "firewall rule already present"
    }
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
    Write-Host "power settings: machine will not sleep on AC" -ForegroundColor Green
} else {
    Write-Warning "Skipped firewall rule and power settings (need admin)."
}

# 5. Start it now
Start-Process powershell -WindowStyle Hidden -ArgumentList "-ExecutionPolicy Bypass -File `"$runner`" -DataDir `"$DataDir`""
Start-Sleep -Seconds 3

$configPath = Join-Path $DataDir 'config.json'
if (Test-Path $configPath) {
    Write-Host ""
    Write-Host "Daemon is up. Config: $configPath" -ForegroundColor Green
    Write-Host "Next steps (see DEPLOY.md):"
    Write-Host "  - set host to 0.0.0.0 (or the Tailscale IP) so clients can reach it"
    Write-Host "  - set slack.publicHost to this machine's Tailscale hostname"
    Write-Host "  - update the Slack app redirect URL to match"
} else {
    Write-Warning "daemon did not write $configPath yet - check $DataDir\daemon.log"
}
