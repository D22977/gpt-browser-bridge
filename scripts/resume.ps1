# GPT_BROWSER_BRIDGE - resume supervisor (skeleton)
# Runs from Task Scheduler every 5 min. Only restarts supervisor when heartbeat is stale.
param(
  [string]$Runtime = "D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE",
  [string]$Orca = "C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe"
)

$heartbeatFile = Join-Path $Runtime "state\heartbeat.json"
$log = Join-Path $Runtime "logs\scheduler.log"

function Write-Log($msg) {
  "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') $msg" | Add-Content $log
}

# heartbeat stale threshold: supervisor beats every 15s; 3x stale -> restart
$staleAfter = (Get-Date).AddSeconds(-45)

if (Test-Path $heartbeatFile) {
  $hb = Get-Content $heartbeatFile -Raw | ConvertFrom-Json
  $hbTime = [datetime]::Parse($hb.at)
  if ($hbTime -gt $staleAfter) {
    Write-Log "heartbeat fresh (${hb.at}); no action"
    exit 0
  }
  Write-Log "heartbeat stale (${hb.at}); restarting supervisor"
} else {
  Write-Log "no heartbeat file; starting supervisor"
}

# Double-start protection handled by supervisor.lock inside supervisor.mjs
Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\start-supervisor.ps1" -WindowStyle Hidden
exit 0
