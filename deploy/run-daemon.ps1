# Keeps the WasteHero Dev Hub daemon alive: restarts it if it ever crashes.
# Installed as a logon task by install-daemon.ps1 - do not run two copies.
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 + UTF-8 no BOM).
param(
    [string]$DataDir = "$env:USERPROFILE\.wh-dev-hub"
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$env:WH_HUB_DATA = $DataDir
$log = Join-Path $DataDir 'daemon.log'
$daemon = Join-Path $repoRoot 'daemon\dist\index.cjs'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

while ($true) {
    Add-Content $log "[$(Get-Date -Format s)] starting daemon"
    # Redirect through cmd so the log file stays readable while the daemon
    # runs (a PowerShell Add-Content pipeline holds an exclusive handle).
    cmd /c "node `"$daemon`" >> `"$log`" 2>&1"
    Add-Content $log "[$(Get-Date -Format s)] daemon exited, restarting in 5s"
    Start-Sleep -Seconds 5
}
