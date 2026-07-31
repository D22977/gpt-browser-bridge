# GPT_BROWSER_BRIDGE - keep-awake (minimal skeleton)

# Prevents the system from sleeping while a Supervisor session is running.
# Does NOT modify power plans; does NOT prevent screen off.

param([switch]$Release)

$sig = @'
[DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$type = Add-Type -MemberDefinition $sig -Name "ThreadExecutionState" -Namespace "Win32" -PassThru

# ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001
$ES_CONTINUOUS = 0x80000000
$ES_SYSTEM_REQUIRED = 0x00000001

if ($Release) {
    $null = $type::SetThreadExecutionState($ES_CONTINUOUS)
    Write-Output "keep-awake: execution state released"
} else {
    $null = $type::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    Write-Output "keep-awake: system sleep suppressed (continuous)"
}
