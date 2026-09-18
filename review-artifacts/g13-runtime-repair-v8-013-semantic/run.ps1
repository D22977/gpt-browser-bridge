$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& 'C:\Program Files\nodejs\node.exe' (Join-Path $PSScriptRoot 'watcher.mjs') --loop
exit $LASTEXITCODE
