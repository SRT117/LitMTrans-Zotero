[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$mjsScript = Join-Path $PSScriptRoot "register-vscode-shortcuts.mjs"
node $mjsScript
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
