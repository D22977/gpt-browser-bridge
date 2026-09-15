# GPT_BROWSER_BRIDGE - deferred supervisor start plan.
# This file validates the trusted binding and emits a plan only. It never
# starts, stops, or restarts a process under the static R54 definition.
# The checked-out worktree remains the only source of the entrypoint:
# $repo = $observedRepoRoot
# Join-Path $repo "src\supervisor.mjs"
# Later deployment proof must verify [int]$heartbeatState.pid -eq $process.Id.
param(
  [Parameter(Mandatory = $true)] [string]$TrustedRepoRoot,
  [Parameter(Mandatory = $true)] [string]$ExpectedRepoRoot,
  [Parameter(Mandatory = $true)] [string]$ExpectedRef,
  [Parameter(Mandatory = $true)] [string]$BoundRef,
  [Parameter(Mandatory = $true)] [string]$ExpectedHead,
  [Parameter(Mandatory = $true)] [string]$BoundHead,
  [Parameter(Mandatory = $true)] [string]$ExpectedEntrypoint,
  [Parameter(Mandatory = $true)] [string]$BoundEntrypoint,
  [Parameter(Mandatory = $true)] [string]$ExpectedRuntimeRoot,
  [Parameter(Mandatory = $true)] [string]$BoundRuntimeRoot,
  [Parameter(Mandatory = $true)] [string]$ExpectedRuntimeIdentity,
  [Parameter(Mandatory = $true)] [string]$BoundRuntimeIdentity
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-GbbPath([string]$Value) {
  try {
    return ([IO.Path]::GetFullPath($Value)).TrimEnd([char[]]@('\\', '/')).ToLowerInvariant()
  } catch {
    return ""
  }
}

function Get-GbbBindingDecision {
  param(
    [string]$TrustedRepoRoot, [string]$ExpectedRepoRoot, [string]$ObservedRepoRoot,
    [string]$ExpectedRef, [string]$BoundRef, [string]$ExpectedHead, [string]$BoundHead,
    [string]$ExpectedEntrypoint, [string]$BoundEntrypoint, [string]$ObservedEntrypoint,
    [string]$ExpectedRuntimeRoot, [string]$BoundRuntimeRoot,
    [string]$ExpectedRuntimeIdentity, [string]$BoundRuntimeIdentity
  )
  $reasons = [System.Collections.Generic.List[string]]::new()
  if ([string]::IsNullOrWhiteSpace($TrustedRepoRoot) -or (Normalize-GbbPath $TrustedRepoRoot) -ne (Normalize-GbbPath $ExpectedRepoRoot)) { $reasons.Add("REPO_ROOT_MISMATCH") }
  if ((Normalize-GbbPath $ExpectedRepoRoot) -ne (Normalize-GbbPath $ObservedRepoRoot)) { $reasons.Add("OBSERVED_REPO_ROOT_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedRef) -or $ExpectedRef -ne $BoundRef -or $ExpectedRef -notmatch '^refs/heads/[A-Za-z0-9._/-]+$') { $reasons.Add("REF_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedHead) -or $ExpectedHead -ne $BoundHead -or $ExpectedHead -notmatch '^[0-9a-fA-F]{40}$') { $reasons.Add("HEAD_MISMATCH") }
  if ((Normalize-GbbPath $ExpectedEntrypoint) -ne (Normalize-GbbPath $BoundEntrypoint) -or (Normalize-GbbPath $ExpectedEntrypoint) -ne (Normalize-GbbPath $ObservedEntrypoint)) { $reasons.Add("ENTRYPOINT_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedRuntimeRoot) -or (Normalize-GbbPath $ExpectedRuntimeRoot) -ne (Normalize-GbbPath $BoundRuntimeRoot)) { $reasons.Add("RUNTIME_ROOT_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedRuntimeIdentity) -or $ExpectedRuntimeIdentity -ne $BoundRuntimeIdentity) { $reasons.Add("RUNTIME_IDENTITY_MISMATCH") }
  if ($reasons.Count -gt 0) {
    return [pscustomobject]@{ State = "BLOCKED"; Code = "CONTROL_REQUIRED_TRUSTED_BINDING_MISMATCH"; StartAllowed = $false; Reasons = @($reasons) }
  }
  return [pscustomobject]@{ State = "READY"; Code = "TRUSTED_BINDING_MATCH"; StartAllowed = $true; Reasons = @() }
}

$observedRepoRoot = Normalize-GbbPath (Join-Path $PSScriptRoot "..")
$repo = $observedRepoRoot
$observedEntrypoint = Join-Path $repo "src\supervisor.mjs"
$binding = Get-GbbBindingDecision `
  -TrustedRepoRoot $TrustedRepoRoot -ExpectedRepoRoot $ExpectedRepoRoot -ObservedRepoRoot $observedRepoRoot `
  -ExpectedRef $ExpectedRef -BoundRef $BoundRef -ExpectedHead $ExpectedHead -BoundHead $BoundHead `
  -ExpectedEntrypoint $ExpectedEntrypoint -BoundEntrypoint $BoundEntrypoint -ObservedEntrypoint $observedEntrypoint `
  -ExpectedRuntimeRoot $ExpectedRuntimeRoot -BoundRuntimeRoot $BoundRuntimeRoot `
  -ExpectedRuntimeIdentity $ExpectedRuntimeIdentity -BoundRuntimeIdentity $BoundRuntimeIdentity

if (-not $binding.StartAllowed) {
  [ordered]@{
    State = $binding.State
    Code = $binding.Code
    ProcessStartAllowed = $false
    ProcessStartInvoked = $false
    DeliveryClaimed = $false
    Binding = $binding
  } | ConvertTo-Json -Depth 8
  return
}

[ordered]@{
  State = "SUPERVISOR_START_PLAN_READY"
  Code = "TRUSTED_BINDING_MATCH_DEFERRED_START"
  ProcessStartAllowed = $true
  ProcessStartInvoked = $false
  Execution = "DEFERRED_TO_LATER_DEPLOYMENT_AUTHORITY"
  Entrypoint = $BoundEntrypoint
  RuntimeRoot = $BoundRuntimeRoot
  ResidentAuthority = "R53_LOCK_FENCE_PHYSICAL_SEND_GATES"
  LockAndFenceRequired = $true
  PhysicalSendGateRequired = $true
  NoBlindRetry = $true
  DeliveryClaimed = $false
  Binding = $binding
} | ConvertTo-Json -Depth 8
