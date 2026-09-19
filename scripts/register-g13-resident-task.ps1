# G13 resident Task Scheduler installer. Static by default; registration requires -Apply.
param(
  [switch]$Apply,
  [string]$TaskName = "GBB_G13_RESIDENT",
  [string]$RuntimeRoot = "D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE",
  [string]$User = "Lupun"
)

$scriptPath = Join-Path $RuntimeRoot "runtime\control-doorbell\run.ps1"
if (-not [System.IO.Path]::IsPathRooted($scriptPath)) {
  throw "scriptPath must be absolute: $scriptPath"
}

$definition = [ordered]@{
  task_name = $TaskName
  user = $User
  action = [ordered]@{
    executable = "pwsh.exe"
    arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath)
  }
  runtime_root = $RuntimeRoot
  multiple_instances = "IgnoreNew"
  wake_to_run = $true
}

$definition | ConvertTo-Json -Depth 10
if (-not $Apply) {
  return
}

$action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`"" -f $scriptPath)
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -WakeToRun
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
