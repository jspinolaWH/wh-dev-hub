# Convert the WasteHero Dev Hub daemon into a real Windows service.
# Run from an ELEVATED PowerShell on the office (host) PC:
#   powershell -ExecutionPolicy Bypass -File deploy\install-service.ps1
#
# The service runs as the CURRENT user account (so the Claude CLI, its login
# profile, and PATH all match the working interactive setup), with no console
# to Ctrl-C, and auto-restarts on crash / after reboot. You will be prompted
# once for this account's Windows password (required to run a service as a
# user rather than LocalSystem).
#
# Keep this file ASCII-only (Windows PowerShell 5.1 + UTF-8 no BOM).
param(
    [string]$DataDir = "$env:USERPROFILE\.wh-dev-hub"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this from an elevated (Administrator) PowerShell." }

Write-Host "== WasteHero Dev Hub service install ==" -ForegroundColor Cyan
Write-Host "repo:     $repoRoot"
Write-Host "data dir: $DataDir"

# 1. Build the daemon bundle the service will run.
Push-Location $repoRoot
npm install
npm run build -w daemon
Pop-Location

# 2. Retire the old logon task so the two don't both run.
cmd /c "schtasks /End /TN `"WasteHero Dev Hub Daemon`" >nul 2>&1"
cmd /c "schtasks /Delete /F /TN `"WasteHero Dev Hub Daemon`" >nul 2>&1"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*daemon\dist\index.cjs*' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }

# 3. Credentials to run the service as this user (not LocalSystem).
$account = "$env:USERDOMAIN\$env:USERNAME"
Write-Host ""
Write-Host "The service will run as: $account" -ForegroundColor Yellow
$sec = Read-Host "Enter the Windows password for $account" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

# 4. Install via node-windows.
$env:WH_HUB_DATA = $DataDir
$env:WH_SVC_ACCOUNT = $account
$env:WH_SVC_PASSWORD = $plain
try {
    node (Join-Path $repoRoot 'deploy\service\install-service.js')
} finally {
    Remove-Item Env:WH_SVC_PASSWORD -ErrorAction SilentlyContinue
    $plain = $null
}

Start-Sleep -Seconds 4
$svc = Get-Service -Name 'WasteHero Dev Hub' -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host ""
    Write-Host "Service '$($svc.Name)' status: $($svc.Status)" -ForegroundColor Green
    Write-Host "It now runs regardless of login, cannot be Ctrl-C'd, and auto-restarts."
    Write-Host "Logs: $DataDir (daemonwrapper.log / daemon.err.log / daemon.out.log)"
    Write-Host "Verify it listens: netstat -ano | findstr `":7811`""
} else {
    Write-Warning "Service not found after install - check the node-windows output above."
}
