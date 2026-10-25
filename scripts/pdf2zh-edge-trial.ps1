[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PdfPath,
    [string]$Pages = "",
    [string]$OutputDirectory = "output/pdf/pdf2zh-edge-trial"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$trialPython = Join-Path $projectRoot ".zotero-dev/pdf2zh-edge/.venv/Scripts/python.exe"
Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath $trialPython)) {
        & uv venv .zotero-dev/pdf2zh-edge/.venv --python 3.13
        if ($LASTEXITCODE -ne 0) { throw "无法创建独立 Python 环境" }
        & uv pip install --python $trialPython -r scripts/pdf2zh-edge-trial-requirements.txt
        if ($LASTEXITCODE -ne 0) { throw "无法安装试验依赖" }
    }
    $trialArguments = @("scripts/pdf2zh-edge-trial.py", $PdfPath, "--output", $OutputDirectory)
    if ($Pages) { $trialArguments += @("--pages", $Pages) }
    & $trialPython @trialArguments
    if ($LASTEXITCODE -ne 0) { throw "试验未完成，请检查输出目录的 pipeline.log" }
}
finally {
    Pop-Location
}
