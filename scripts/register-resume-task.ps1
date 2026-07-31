# GPT_BROWSER_BRIDGE - register resume Task Scheduler entry (skeleton)
# Allowed: one project-specific task "GPT_BROWSER_BRIDGE_RESUME".
# - runs only while the current user is logged in
# - no admin requirement
# - every 5 minutes runs resume.ps1
param(
  [string]$TaskName = "GPT_BROWSER_BRIDGE_RESUME",
  [string]$ResumeScript = "D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\resume.ps1"
)

$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ResumeScript`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
  "registered: $TaskName"
} catch {
  "BLOCKER: could not register task: $($_.Exception.Message)"
  exit 1
}
