[CmdletBinding()]
param(
    # Supplying this makes the manifest transformation reproducible in CI and
    # lets us cover older supported Zotero majors without launching them.
    [string]$ZoteroVersion,
    [switch]$NoSync
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $projectRoot "dist"
$stage = Join-Path $dist "addon"
$manifestPath = Join-Path $stage "manifest.json"

if (-not $NoSync) {
    $portedCore = Join-Path $projectRoot "src\ported-core.js"
    if (-not (Test-Path -LiteralPath $portedCore -PathType Leaf)) {
        $localTsc = Join-Path $projectRoot "node_modules\typescript\bin\tsc"
        if (Test-Path -LiteralPath $localTsc -PathType Leaf) {
            & node $localTsc -p (Join-Path $projectRoot "tsconfig.core.json")
        }
    }

    if (-not (Test-Path -LiteralPath $stage)) {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
    }

    foreach ($entry in @("manifest.json", "src", "assets", "locale", "README.md", "CHANGELOG.md", "PRIVACY.md", "SECURITY.md", "LICENSE", "THIRD_PARTY_NOTICES.md")) {
        $srcPath = Join-Path $projectRoot $entry
        if (Test-Path -LiteralPath $srcPath) {
            Copy-Item -LiteralPath $srcPath -Destination $stage -Recurse -Force
        }
    }
    Remove-Item -LiteralPath (Join-Path $stage "chrome.manifest") -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $projectRoot "src/bootstrap.js") -Destination (Join-Path $stage "bootstrap.js") -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot "src/prefs.js") -Destination (Join-Path $stage "prefs.js") -Force

    # 分发本地 CAJ 转换器（独立 Rust 组件，随插件包提供）。
    # 先清空旧副本再拷贝：Copy-Item 对已存在目录会把源目录整体嵌套进去，
    # 造成 exe 与 wasm 并存、路径错位（native\dist\caj2pdf\...）。
    $nativeDist = Join-Path $projectRoot "native\dist"
    $nativeStage = Join-Path $stage "native"
    Remove-Item -LiteralPath $nativeStage -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $nativeDist) {
        Copy-Item -LiteralPath $nativeDist -Destination $nativeStage -Recurse -Force
    }

    $generateMap = Join-Path $projectRoot "scripts\generate-repo-map.mjs"
    if (Test-Path -LiteralPath $generateMap -PathType Leaf) {
        & node $generateMap
    }
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Development staged addon missing manifest: $manifestPath"
}

# Bound the staged development copy to the Zotero major version that will load
# it. This lets a developer test a future Zotero beta without broadening the
# compatibility claim in the public XPI.
if (-not $ZoteroVersion) {
    $zoteroBinary = $env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH
    if (-not $zoteroBinary -or -not (Test-Path -LiteralPath $zoteroBinary -PathType Leaf)) {
        throw "Cannot determine Zotero version for staging. Please set ZOTERO_PLUGIN_ZOTERO_BIN_PATH or pass -ZoteroVersion."
    }
    $ZoteroVersion = (Get-Item -LiteralPath $zoteroBinary).VersionInfo.ProductVersion
}

$versionMatch = [regex]::Match($ZoteroVersion, '^(?<major>\d+)\.')
if (-not $versionMatch.Success) {
    throw "Cannot extract major version from Zotero version '$ZoteroVersion'."
}
$strictMaxVersion = "$($versionMatch.Groups['major'].Value).*"

# The update URL is also required by Zotero's temporary-install path. Updates
# are disabled in the isolated profile. Neither field is written to the XPI.
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$manifest.applications.zotero | Add-Member -NotePropertyName "update_url" -NotePropertyValue "https://127.0.0.1/litmtrans/updates.json" -Force
$manifest.applications.zotero | Add-Member -NotePropertyName "strict_max_version" -NotePropertyValue $strictMaxVersion -Force
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host "Prepared Zotero $($versionMatch.Groups['major'].Value) dev manifest (dist/addon)." -ForegroundColor DarkGray
