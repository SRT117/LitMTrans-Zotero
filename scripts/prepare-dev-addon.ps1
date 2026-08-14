[CmdletBinding()]
param(
    # Supplying this makes the manifest transformation reproducible in CI and
    # lets us cover older supported Zotero majors without launching them.
    [string]$ZoteroVersion
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot "dist\addon\manifest.json"

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "开发临时插件缺少 manifest：$manifestPath"
}

# Bound the staged development copy to the Zotero major version that will load
# it. This lets a developer test a future Zotero beta without broadening the
# compatibility claim in the public XPI.
if (-not $ZoteroVersion) {
    $zoteroBinary = $env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH
    if (-not $zoteroBinary -or -not (Test-Path -LiteralPath $zoteroBinary -PathType Leaf)) {
        throw "无法确定用于临时加载的 Zotero 版本。请设置 ZOTERO_PLUGIN_ZOTERO_BIN_PATH，或传入 -ZoteroVersion。"
    }
    $ZoteroVersion = (Get-Item -LiteralPath $zoteroBinary).VersionInfo.ProductVersion
}

$versionMatch = [regex]::Match($ZoteroVersion, '^(?<major>\d+)\.')
if (-not $versionMatch.Success) {
    throw "无法从 Zotero 版本 '$ZoteroVersion' 提取主版本号。"
}
$strictMaxVersion = "$($versionMatch.Groups['major'].Value).*"

# The update URL is also required by Zotero's temporary-install path. Updates
# are disabled in the isolated profile. Neither field is written to the XPI.
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.applications.zotero | Add-Member -NotePropertyName "update_url" -NotePropertyValue "https://127.0.0.1/litmtrans/updates.json" -Force
$manifest.applications.zotero | Add-Member -NotePropertyName "strict_max_version" -NotePropertyValue $strictMaxVersion -Force
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host "已准备 Zotero $($versionMatch.Groups['major'].Value) 临时加载清单（仅 dist/addon）。" -ForegroundColor DarkGray
