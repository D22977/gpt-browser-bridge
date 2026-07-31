# GPT_BROWSER_BRIDGE - unregister resume Task Scheduler entry (skeleton)
param(
  [string]$TaskName = "GPT_BROWSER_BRIDGE_RESUME"
)
try {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  "unregistered: $TaskName"
} catch {
  "not found or failed: $($_.Exception.Message)"
  exit 1
}
