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

# 3. Install the service as LocalSystem via node-windows (no credentials
#    here, so nothing to echo or write to disk).
$env:WH_HUB_DATA = $DataDir
node (Join-Path $repoRoot 'deploy\service\install-service.js')
Start-Sleep -Seconds 4

$svc = Get-Service -DisplayName 'WasteHero Dev Hub' -ErrorAction SilentlyContinue
if (-not $svc) { throw "Service not registered - check the node-windows output above." }
$svcName = $svc.Name

# 4. Reconfigure it to run as THIS user (so claude / PATH / %USERPROFILE%
#    match the working interactive setup). sc.exe sets the credential straight
#    into the SCM: the password is never echoed and never written to disk.
$account = "$env:USERDOMAIN\$env:USERNAME"
Write-Host ""
Write-Host "The service will run as: $account" -ForegroundColor Yellow
$sec = Read-Host "Enter the Windows password for $account (not echoed anywhere)" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

# Grant "Log on as a service" (SeServiceLogonRight); the SCM won't start the
# service as a user account without it, and node-windows does not grant it.
function Grant-LogonAsService([string]$acct) {
    $sid = (New-Object System.Security.Principal.NTAccount($acct)
        ).Translate([System.Security.Principal.SecurityIdentifier]).Value
    $tmp = [IO.Path]::GetTempFileName()
    secedit /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $content = Get-Content $tmp
    $line = $content | Where-Object { $_ -match '^SeServiceLogonRight' }
    if ($line -and $line -match [regex]::Escape($sid)) { Remove-Item $tmp -Force; return }
    if ($line) { $content = $content -replace [regex]::Escape($line), "$line,*$sid" }
    else { $content += "SeServiceLogonRight = *$sid" }
    Set-Content $tmp $content
    secedit /configure /db "$env:windir\security\database\local.sdb" /cfg $tmp /areas USER_RIGHTS | Out-Null
    Remove-Item $tmp -Force
}
Grant-LogonAsService $account

& sc.exe config $svcName obj= "$account" password= "$plain" | Out-Null
$plain = $null
Restart-Service -Name $svcName -Force
Start-Sleep -Seconds 3

# Register the pre-elevated restart task so future updates can restart the
# daemon with no UAC prompt (see enable-remote-restart.ps1). Points at the
# robust restart-daemon.ps1 (self-heals the winsw orphan wedge) rather than a
# plain Restart-Service.
$restartScript = Join-Path $repoRoot 'deploy\restart-daemon.ps1'
$restartAction = "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$restartScript`""
cmd /c "schtasks /Create /F /TN `"WH Restart Daemon`" /TR `"$restartAction`" /SC ONCE /ST 00:00 /RL HIGHEST /RU `"$env:USERNAME`"" | Out-Null

$svc = Get-Service -Name $svcName
Write-Host ""
Write-Host "Service '$svcName' status: $($svc.Status), running as $account" -ForegroundColor Green
Write-Host "It runs regardless of login, cannot be Ctrl-C'd, and auto-restarts."
Write-Host "Verify it listens: netstat -ano | findstr `":7811`""
Write-Host "Restart with no UAC (from any session): schtasks /Run /TN `"WH Restart Daemon`""
Write-Host "Restart later: Restart-Service $svcName (elevated)"
