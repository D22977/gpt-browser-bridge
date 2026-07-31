# GPT_BROWSER_BRIDGE - unregister resume Task Scheduler entry (skeleton)
param(
  [string]$TaskName = "GPT_BROWSER_BRIDGE_RESUME"
)
& schtasks.exe /Delete /F /TN $TaskName 2>&1
$code = $LASTEXITCODE
if ($code -eq 0) {
  "unregistered: $TaskName"
} else {
  "not found or failed: schtasks returned code $code"
  exit 1
}
