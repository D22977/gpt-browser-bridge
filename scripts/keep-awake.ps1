# GPT_BROWSER_BRIDGE - keep-awake (minimal skeleton)

# Prevents the system from sleeping while a Supervisor session is running.
# Does NOT modify power plans; does NOT prevent screen off.

param([switch]$Release)

if (-not ('Win32.ThreadExecutionState' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Win32 {
    public class ThreadExecutionState {
        [DllImport("kernel32.dll")]
        public static extern uint SetThreadExecutionState(uint esFlags);
    }
}
'@
}

# ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001
$ES_CONTINUOUS = [uint32]::Parse("80000000", [System.Globalization.NumberStyles]::HexNumber)
$ES_SYSTEM_REQUIRED = [uint32]::Parse("00000001", [System.Globalization.NumberStyles]::HexNumber)

if ($Release) {
    $null = [Win32.ThreadExecutionState]::SetThreadExecutionState($ES_CONTINUOUS)
    Write-Output "keep-awake: execution state released"
} else {
    $null = [Win32.ThreadExecutionState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    Write-Output "keep-awake: system sleep suppressed (continuous)"
}
