[CmdletBinding()]
param(
    [ValidateSet("7", "8", "9", "10")]
    [string]$ZoteroMajor = "10",
    [switch]$PrepareOnly,
    [switch]$Validate
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:npm_config_cache = Join-Path $projectRoot ".npm-cache"

# Resolve a pinned runtime and a version-specific profile/data pair. Zotero 7
# and 8 are restored from local ZIPs automatically if their updater replaced
# the extracted runtime with a newer major version.
$testVersion = & (Join-Path $PSScriptRoot "prepare-zotero-test-version.ps1") -Major $ZoteroMajor
$env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH = $testVersion.BinaryPath
$env:ZOTERO_PLUGIN_PROFILE_PATH = $testVersion.ProfilePath
$env:ZOTERO_PLUGIN_DATA_DIR = $testVersion.DataPath

Write-Host "测试目标：Zotero $($testVersion.Version)" -ForegroundColor Green
Write-Host "程序：$($testVersion.BinaryPath)" -ForegroundColor DarkGray
Write-Host "Profile：$($testVersion.ProfilePath)" -ForegroundColor DarkGray
Write-Host "数据：$($testVersion.DataPath)" -ForegroundColor DarkGray

if ($PrepareOnly) {
    return
}

# The scaffold otherwise uses taskkill /im zotero.exe on Ctrl+C, which can
# terminate a normal Zotero session. Scope cleanup to this task's isolated
# profile so task cancellation cannot leave an orphaned test Zotero behind.
if (-not $env:ZOTERO_PLUGIN_KILL_COMMAND) {
    $stopScript = Join-Path $PSScriptRoot "stop-isolated-zotero.ps1"
    $env:ZOTERO_PLUGIN_KILL_COMMAND = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$stopScript`" -ProfilePath `"$env:ZOTERO_PLUGIN_PROFILE_PATH`""
}

Push-Location $projectRoot
try {
    if ($Validate) {
        Write-Host "运行完整静态验证与单测..." -ForegroundColor Cyan
        & node "scripts/validate.js"
        if ($LASTEXITCODE -ne 0) { throw "静态验证失败，未启动Zotero。" }
    }

    Write-Host "同步测试插件 (dist/addon)..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "prepare-dev-addon.ps1") -ZoteroVersion $testVersion.Version

    Write-Host "启动隔离的Zotero测试库..." -ForegroundColor Cyan
    Write-Host "此窗口使用当前源码的构建结果；无需手动安装XPI。" -ForegroundColor DarkGray
    & (Join-Path $projectRoot "node_modules\.bin\zotero-plugin.cmd") serve
}
finally {
    Pop-Location
}
