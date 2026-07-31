# GPT_BROWSER_BRIDGE - bootstrap the repo from scratch (GBB-001)
# Recreates this repo on a fresh machine. Idempotent: safe to re-run.
# Does NOT install missing CLIs (node/git are required; orca etc. are only recorded).
param(
  [string]$RepoRoot = "D:\AIWORK\GPT_BROWSER_BRIDGE"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
  "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')] $msg"
}

Write-Step "bootstrap: target=$RepoRoot"

# 1. Prerequisite CLIs (fail loudly for the ones we actually need)
foreach ($tool in @("node", "npm", "git")) {
  $cmd = Get-Command $tool -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Step "BLOCKER: required CLI '$tool' not found on PATH. Install it first."
    exit 1
  }
  Write-Step "$tool -> $($cmd.Source)"
}
& node --version
& npm --version
& git --version

# 2. Repo layout
$dirs = @(
  "plans", "skills", "src", "src\adapters", "scripts", "tests", "docs", "fixtures\chatgpt", "fixtures\orca"
)
foreach ($d in $dirs) {
  $p = Join-Path $RepoRoot $d
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
Write-Step "directories ensured"

# 3. Dependencies
if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
  Write-Step "BLOCKER: package.json missing. Commit it before running bootstrap."
  exit 1
}
Push-Location $RepoRoot
try {
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Step "BLOCKER: npm install failed."; exit 1 }
} finally {
  Pop-Location
}
Write-Step "npm install ok"

# 4. Smoke tests (node --check on every .mjs, then node:test)
$mjs = Get-ChildItem -Path $RepoRoot -Recurse -Filter *.mjs -File
foreach ($f in $mjs) {
  & node --check $f.FullName
  if ($LASTEXITCODE -ne 0) { Write-Step "BLOCKER: node --check failed on $($f.FullName)"; exit 1 }
}
Write-Step "node --check ok ($($mjs.Count) files)"

Push-Location $RepoRoot
try {
  npm test
  if ($LASTEXITCODE -ne 0) { Write-Step "BLOCKER: npm test failed."; exit 1 }
} finally {
  Pop-Location
}
Write-Step "npm test ok"

# 5. Runtime tree (never committed)
$runtime = "D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE"
foreach ($d in @("state", "locks", "jobs", "runs", "events", "logs")) {
  $p = Join-Path $runtime $d
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
Write-Step "runtime tree ensured ($runtime)"

Write-Step "bootstrap: done. Next: docs\ARCHITECTURE.md -> skills -> contracts -> cards GBB-002.."
