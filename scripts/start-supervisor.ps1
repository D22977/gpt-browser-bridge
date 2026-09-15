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
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    $full = [IO.Path]::GetFullPath($Value)
    if ($full.Length -gt 3) { $full = $full.TrimEnd([char[]]@([char]92, [char]47)) }
    return $full.ToLowerInvariant()
  } catch {
    return ""
  }
}

function Resolve-GbbCanonicalPath([string]$Value) {
  try {
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    $resolved = @(Resolve-Path -LiteralPath $Value -ErrorAction Stop)
    if ($resolved.Count -ne 1) { return "" }
    return Normalize-GbbPath $resolved[0].Path
  } catch {
    return ""
  }
}

function Test-GbbPathWithin([string]$Child, [string]$Parent) {
  $childPath = Normalize-GbbPath $Child
  $parentPath = Normalize-GbbPath $Parent
  if ([string]::IsNullOrWhiteSpace($childPath) -or [string]::IsNullOrWhiteSpace($parentPath)) {
    return $false
  }
  return $childPath -ceq $parentPath -or $childPath.StartsWith($parentPath + [char]92, [StringComparison]::Ordinal)
}

function Get-GbbGitValue {
  param([string]$RepoRoot, [string[]]$Arguments)
  try {
    if ([string]::IsNullOrWhiteSpace($RepoRoot)) { return "" }
    $raw = @(& git -C $RepoRoot @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -or $raw.Count -ne 1) { return "" }
    $value = ([string]$raw[0]).Trim()
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\r\n]') { return "" }
    return $value
  } catch {
    return ""
  }
}

function Get-GbbRuntimeIdentity {
  param(
    [string]$RepoRoot,
    [string]$Ref,
    [string]$Head,
    [string]$Entrypoint,
    [string]$RuntimeRoot
  )
  try {
    $payload = "repo=$RepoRoot" + [Environment]::NewLine + "ref=$Ref" + [Environment]::NewLine + "head=$Head" + [Environment]::NewLine + "entrypoint=$Entrypoint" + [Environment]::NewLine + "runtime=$RuntimeRoot"
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
      $digest = $sha.ComputeHash($bytes)
    } finally {
      $sha.Dispose()
    }
    return "GBB_RUNTIME_IDENTITY_V1:" + (($digest | ForEach-Object { $_.ToString("x2") }) -join "")
  } catch {
    return ""
  }
}

function Get-GbbExecutionFacts([string]$RuntimeRoot) {
  $scriptRoot = Resolve-GbbCanonicalPath $PSScriptRoot
  $gitReportedRoot = Get-GbbGitValue $scriptRoot @("rev-parse", "--show-toplevel")
  $actualRepoRoot = Resolve-GbbCanonicalPath $gitReportedRoot
  $actualRef = Get-GbbGitValue $actualRepoRoot @("symbolic-ref", "--quiet", "HEAD")
  $actualHead = Get-GbbGitValue $actualRepoRoot @("rev-parse", "--verify", "HEAD")
  $actualEntrypoint = ""
  if (-not [string]::IsNullOrWhiteSpace($actualRepoRoot)) {
    $entrypointCandidate = Join-Path $actualRepoRoot "src\supervisor.mjs"
    if (Test-Path -LiteralPath $entrypointCandidate -PathType Leaf) {
      $actualEntrypoint = Resolve-GbbCanonicalPath $entrypointCandidate
    }
  }
  $actualRuntimeRoot = ""
  if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot) -and (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
    $actualRuntimeRoot = Resolve-GbbCanonicalPath $RuntimeRoot
  }
  $scriptWithinRepo = Test-GbbPathWithin $scriptRoot $actualRepoRoot
  $trustedRuntimeIdentity = ""
  if (-not [string]::IsNullOrWhiteSpace($actualRepoRoot) -and -not [string]::IsNullOrWhiteSpace($actualRef) -and -not [string]::IsNullOrWhiteSpace($actualHead) -and -not [string]::IsNullOrWhiteSpace($actualEntrypoint) -and -not [string]::IsNullOrWhiteSpace($actualRuntimeRoot) -and $scriptWithinRepo) {
    $trustedRuntimeIdentity = Get-GbbRuntimeIdentity -RepoRoot $actualRepoRoot -Ref $actualRef -Head $actualHead -Entrypoint $actualEntrypoint -RuntimeRoot $actualRuntimeRoot
  }
  $observationStatus = if (-not [string]::IsNullOrWhiteSpace($scriptRoot) -and -not [string]::IsNullOrWhiteSpace($actualRepoRoot) -and -not [string]::IsNullOrWhiteSpace($actualRef) -and -not [string]::IsNullOrWhiteSpace($actualHead) -and -not [string]::IsNullOrWhiteSpace($actualEntrypoint) -and -not [string]::IsNullOrWhiteSpace($actualRuntimeRoot) -and $scriptWithinRepo -and -not [string]::IsNullOrWhiteSpace($trustedRuntimeIdentity)) { "OBSERVED" } else { "FAILED" }
  return [pscustomobject]@{
    ObservationStatus = $observationStatus
    ActualScriptRoot = $scriptRoot
    ActualRepoRoot = $actualRepoRoot
    ActualRef = $actualRef
    ActualHead = $actualHead
    ActualEntrypoint = $actualEntrypoint
    ActualRuntimeRoot = $actualRuntimeRoot
    ScriptWithinRepo = $scriptWithinRepo
    TrustedRuntimeIdentity = $trustedRuntimeIdentity
  }
}

function Get-GbbBindingDecision {
  param(
    [string]$TrustedRepoRoot,
    [string]$ExpectedRepoRoot,
    [string]$ExpectedRef,
    [string]$BoundRef,
    [string]$ExpectedHead,
    [string]$BoundHead,
    [string]$ExpectedEntrypoint,
    [string]$BoundEntrypoint,
    [string]$ExpectedRuntimeRoot,
    [string]$BoundRuntimeRoot,
    [string]$ExpectedRuntimeIdentity,
    [string]$BoundRuntimeIdentity,
    [pscustomobject]$ObservedFacts
  )

  $reasons = [System.Collections.Generic.List[string]]::new()
  if ($ObservedFacts.ObservationStatus -ne "OBSERVED") { $reasons.Add("ACTUAL_EXECUTION_FACTS_UNAVAILABLE") }
  $actualRepoRoot = [string]$ObservedFacts.ActualRepoRoot
  $actualRef = [string]$ObservedFacts.ActualRef
  $actualHead = [string]$ObservedFacts.ActualHead
  $actualEntrypoint = [string]$ObservedFacts.ActualEntrypoint
  $actualRuntimeRoot = [string]$ObservedFacts.ActualRuntimeRoot
  $trustedRuntimeIdentity = [string]$ObservedFacts.TrustedRuntimeIdentity
  if ([string]::IsNullOrWhiteSpace($actualRepoRoot)) { $reasons.Add("ACTUAL_REPO_ROOT_UNOBSERVED") }
  if ([string]::IsNullOrWhiteSpace($actualRef)) { $reasons.Add("ACTUAL_REF_UNOBSERVED_OR_DETACHED") }
  if ([string]::IsNullOrWhiteSpace($actualHead)) { $reasons.Add("ACTUAL_HEAD_UNOBSERVED") }
  if ([string]::IsNullOrWhiteSpace($actualEntrypoint)) { $reasons.Add("ACTUAL_ENTRYPOINT_UNOBSERVED") }
  if ([string]::IsNullOrWhiteSpace($actualRuntimeRoot)) { $reasons.Add("ACTUAL_RUNTIME_ROOT_UNOBSERVED") }
  if ([string]::IsNullOrWhiteSpace($trustedRuntimeIdentity)) { $reasons.Add("TRUSTED_RUNTIME_IDENTITY_UNOBSERVED") }
  if (-not $ObservedFacts.ScriptWithinRepo) { $reasons.Add("ACTUAL_SCRIPT_OUTSIDE_REPO") }
  if ([string]::IsNullOrWhiteSpace($TrustedRepoRoot) -or (Normalize-GbbPath $TrustedRepoRoot) -ne (Normalize-GbbPath $ExpectedRepoRoot) -or (Normalize-GbbPath $TrustedRepoRoot) -ne (Normalize-GbbPath $actualRepoRoot)) { $reasons.Add("REPO_ROOT_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedRef) -or $ExpectedRef -cne $BoundRef -or $ExpectedRef -notmatch '^refs/heads/[A-Za-z0-9._/-]+$' -or $ExpectedRef -cne $actualRef) { $reasons.Add("REF_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedHead) -or $ExpectedHead -cne $BoundHead -or $ExpectedHead -notmatch '^[0-9a-fA-F]{40}$' -or $ExpectedHead -cne $actualHead) { $reasons.Add("HEAD_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedEntrypoint) -or (Normalize-GbbPath $ExpectedEntrypoint) -ne (Normalize-GbbPath $BoundEntrypoint) -or (Normalize-GbbPath $ExpectedEntrypoint) -ne (Normalize-GbbPath $actualEntrypoint)) { $reasons.Add("ENTRYPOINT_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedRuntimeRoot) -or (Normalize-GbbPath $ExpectedRuntimeRoot) -ne (Normalize-GbbPath $BoundRuntimeRoot) -or (Normalize-GbbPath $ExpectedRuntimeRoot) -ne (Normalize-GbbPath $actualRuntimeRoot)) { $reasons.Add("RUNTIME_ROOT_MISMATCH") }
  if ([string]::IsNullOrWhiteSpace($ExpectedRuntimeIdentity) -or $ExpectedRuntimeIdentity -cne $BoundRuntimeIdentity -or $ExpectedRuntimeIdentity -cne $trustedRuntimeIdentity) { $reasons.Add("RUNTIME_IDENTITY_MISMATCH") }

  if ($reasons.Count -gt 0) {
    return [pscustomobject]@{
      State = "BLOCKED"
      Code = "CONTROL_REQUIRED_TRUSTED_BINDING_MISMATCH"
      StartAllowed = $false
      Reasons = @($reasons)
      ObservedFacts = $ObservedFacts
    }
  }

  return [pscustomobject]@{
    State = "READY"
    Code = "TRUSTED_BINDING_MATCH"
    StartAllowed = $true
    Reasons = @()
    ObservedFacts = $ObservedFacts
  }
}

$observedFacts = Get-GbbExecutionFacts $BoundRuntimeRoot
$repo = $observedFacts.ActualRepoRoot
$observedEntrypoint = Join-Path $repo "src\supervisor.mjs"
$binding = Get-GbbBindingDecision -TrustedRepoRoot $TrustedRepoRoot -ExpectedRepoRoot $ExpectedRepoRoot -ExpectedRef $ExpectedRef -BoundRef $BoundRef -ExpectedHead $ExpectedHead -BoundHead $BoundHead -ExpectedEntrypoint $ExpectedEntrypoint -BoundEntrypoint $BoundEntrypoint -ExpectedRuntimeRoot $ExpectedRuntimeRoot -BoundRuntimeRoot $BoundRuntimeRoot -ExpectedRuntimeIdentity $ExpectedRuntimeIdentity -BoundRuntimeIdentity $BoundRuntimeIdentity -ObservedFacts $observedFacts

if (-not $binding.StartAllowed) {
  [ordered]@{
    State = $binding.State
    Code = $binding.Code
    StartAllowed = $false
    ProcessStartAllowed = $false
    ProcessStartInvoked = $false
    DeliveryClaimed = $false
    Binding = $binding
  } | ConvertTo-Json -Depth 12
  return
}

[ordered]@{
  State = "SUPERVISOR_START_PLAN_READY"
  Code = "TRUSTED_BINDING_MATCH_DEFERRED_START"
  StartAllowed = $true
  ProcessStartAllowed = $true
  ProcessStartInvoked = $false
  Execution = "DEFERRED_TO_LATER_DEPLOYMENT_AUTHORITY"
  Entrypoint = $observedFacts.ActualEntrypoint
  RuntimeRoot = $observedFacts.ActualRuntimeRoot
  ResidentAuthority = "R53_LOCK_FENCE_PHYSICAL_SEND_GATES"
  LockAndFenceRequired = $true
  PhysicalSendGateRequired = $true
  NoBlindRetry = $true
  DeliveryClaimed = $false
  ObservedExecutionFacts = $observedFacts
  Binding = $binding
} | ConvertTo-Json -Depth 12
