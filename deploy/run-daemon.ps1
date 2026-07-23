# Keeps the WasteHero Dev Hub daemon alive: restarts it if it ever crashes.
# Installed as a logon task by install-daemon.ps1 — do not run two copies.
param(
    [string]$DataDir = "$env:USERPROFILE\.wh-dev-hub"
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$env:WH_HUB_DATA = $DataDir
$log = Join-Path $DataDir 'daemon.log'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

while ($true) {
    "[$(Get-Date -Format s)] starting daemon" | Add-Content $log
    & node (Join-Path $repoRoot 'daemon\dist\index.cjs') 2>&1 | Add-Content $log
    "[$(Get-Date -Format s)] daemon exited, restarting in 5s" | Add-Content $log
    Start-Sleep -Seconds 5
}
