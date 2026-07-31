# GPT_BROWSER_BRIDGE - register resume Task Scheduler entry (skeleton)
# Allowed: one project-specific task "GPT_BROWSER_BRIDGE_RESUME".
# - runs only while the current user is logged in
# - no admin requirement
# - every 5 minutes runs resume.ps1
# Uses schtasks.exe so it works from both pwsh and Windows PowerShell 5.1.
param(
  [string]$TaskName = "GPT_BROWSER_BRIDGE_RESUME",
  [string]$ResumeScript = "D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\resume.ps1"
)

$tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ResumeScript`""
$quotedTr = "`"$tr`""

& schtasks.exe /Create /F /TN $TaskName /TR $quotedTr /SC MINUTE /MO 5 /RL LIMITED /IT 2>&1
$code = $LASTEXITCODE
if ($code -eq 0) {
  "registered: $TaskName"
} else {
  "BLOCKER: schtasks returned code $code"
  exit 1
}
