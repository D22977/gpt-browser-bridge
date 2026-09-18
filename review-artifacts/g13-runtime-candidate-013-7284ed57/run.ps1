$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
& 'C:\Program Files\nodejs\node.exe' (Join-Path $PSScriptRoot 'watcher.mjs') --loop *>> (Join-Path $logDir 'watcher.log')
exit $LASTEXITCODE
