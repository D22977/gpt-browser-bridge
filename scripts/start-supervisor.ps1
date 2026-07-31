# GPT_BROWSER_BRIDGE - start supervisor
param(
  [string]$Runtime = "D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE",
  [string]$Orca = "C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe"
)

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$supervisor = Join-Path $repo "src\supervisor.mjs"
$stateDir = Join-Path $Runtime "state"
$logsDir = Join-Path $Runtime "logs"
New-Item -ItemType Directory -Force -Path $stateDir, $logsDir | Out-Null

$env:GBB_RUNTIME = $Runtime
$env:GBB_ORCA = $Orca

$logId = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$stdoutLog = Join-Path $logsDir "supervisor-$logId.log"
$stderrLog = Join-Path $logsDir "supervisor-$logId.err.log"
$process = Start-Process node -ArgumentList "`"$supervisor`"" -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

$heartbeat = Join-Path $stateDir "heartbeat.json"
$deadline = (Get-Date).AddSeconds(5)
$heartbeatOwned = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $heartbeat) {
    try {
      $heartbeatState = Get-Content -LiteralPath $heartbeat -Raw | ConvertFrom-Json
      if ([int]$heartbeatState.pid -eq $process.Id) {
        $heartbeatOwned = $true
        break
      }
    } catch {
      # The Supervisor writes atomically; retry if an external stale file is unreadable.
    }
  }
  Start-Sleep -Milliseconds 100
}

Write-Output "supervisor_start pid=$($process.Id) heartbeat_owned=$heartbeatOwned stdout=$stdoutLog stderr=$stderrLog"
Get-Content -LiteralPath $heartbeat -ErrorAction SilentlyContinue
