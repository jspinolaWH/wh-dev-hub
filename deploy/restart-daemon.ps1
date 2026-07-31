# Robust daemon restart, run ELEVATED by the "WH Restart Daemon" scheduled
# task. Unlike a plain Restart-Service, this self-heals the winsw wedge: if a
# previous stop crashed and orphaned the daemon (still holding 7811/7812/7813),
# it force-frees the ports before starting, so the new process can bind.
# Keep ASCII-only (Windows PowerShell 5.1).
$ErrorActionPreference = 'SilentlyContinue'

$svc = (Get-Service -DisplayName 'WasteHero Dev Hub').Name
if (-not $svc) { Write-Output 'service not found'; exit 1 }

# 1. Ask the service to stop (triggers the daemon's graceful shutdown).
Stop-Service -Name $svc -Force
Start-Sleep -Seconds 3

# 2. Force-free the ports: kill any daemon node process still running (orphan
#    from a crashed winsw stop, or a stuck child). Matches the daemon bundle.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*daemon\dist\index.cjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1

# 3. Start the service cleanly (ports are now free -> new bundle binds).
Start-Service -Name $svc
Start-Sleep -Seconds 3
$s = Get-Service -Name $svc
Write-Output "WasteHero Dev Hub: $($s.Status)"
