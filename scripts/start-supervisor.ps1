# GPT_BROWSER_BRIDGE - start supervisor (skeleton)
param(
  [string]$Runtime = "D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE",
  [string]$Orca = "C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe"
)

$repo = "D:\AIWORK\GPT_BROWSER_BRIDGE"

# Keep-awake: suppress system sleep for this process tree (skeleton).
Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$repo\scripts\keep-awake.ps1" -WindowStyle Hidden

$env:GBB_RUNTIME = $Runtime
$env:GBB_ORCA = $Orca

Start-Process node -ArgumentList "$repo\src\supervisor.mjs" -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput "$Runtime\logs\supervisor.log" -RedirectStandardError "$Runtime\logs\supervisor.err.log"

Start-Sleep -Seconds 3
Get-Content "$Runtime\state\heartbeat.json" -ErrorAction SilentlyContinue
Get-Content "$Runtime\logs\supervisor.log" -ErrorAction SilentlyContinue
