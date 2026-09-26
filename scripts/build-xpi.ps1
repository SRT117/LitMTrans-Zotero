[CmdletBinding()]
param(
    [switch]$SkipValidate
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $SkipValidate) {
    Push-Location $projectRoot
    try {
        & node "scripts/validate.js"
        if ($LASTEXITCODE -ne 0) { throw "Validation failed, aborting XPI build." }
    }
    finally {
        Pop-Location
    }
}
$manifest = Get-Content (Join-Path $projectRoot "manifest.json") -Raw -Encoding utf8 | ConvertFrom-Json
$dist = Join-Path $projectRoot "dist"
$stage = Join-Path $dist ".xpi-release-stage"
$xpi = Join-Path $dist ("litmtrans-{0}.xpi" -f $manifest.version)

New-Item -ItemType Directory -Path $dist -Force | Out-Null

try {
Remove-Item -LiteralPath $xpi -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($entry in @("manifest.json", "src", "assets", "locale", "README.md", "CHANGELOG.md", "PRIVACY.md", "SECURITY.md", "LICENSE", "THIRD_PARTY_NOTICES.md")) {
    $entryPath = Join-Path $projectRoot $entry
    if (Test-Path -LiteralPath $entryPath) {
        Copy-Item -LiteralPath $entryPath -Destination $stage -Recurse -Force
    }
}
New-Item -ItemType Directory -Path (Join-Path $stage "docs") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "docs/licensing") -Destination (Join-Path $stage "docs/licensing") -Recurse -Force
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

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Compress-Archive stores Windows path separators in ZIP entry names. Zotero
# can read the root manifest from such an XPI, but jar: URLs for nested files
# then fail with "invalid filename" and abort bootstrap startup. Create every
# entry explicitly with the forward-slash names required by the ZIP format.
$archive = [System.IO.Compression.ZipFile]::Open($xpi, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $stage -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            $entryName = $_.FullName.Substring($stage.Length).TrimStart("\", "/").Replace("\", "/")
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $_.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
}
finally {
    $archive.Dispose()
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($xpi)
try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    $invalidEntries = @($entries | Where-Object { $_ -match '\\' -or $_ -match '(^|/)\.\.(/|$)' -or $_ -match '^/' })
    if ($invalidEntries.Count) {
        throw "XPI contains invalid ZIP path: $($invalidEntries -join ', ')"
    }
    $requiredEntries = @("manifest.json", "bootstrap.js", "prefs.js", "src/ported-core.js", "src/controller.js", "src/caj-worker.js", "src/caj-converter.js", "assets/icon-48.png", "assets/icon-96.png", "assets/docs/token-guide.pdf", "assets/fonts/SourceHanSerifCN-Regular.ttf", "assets/fonts/LICENSE-SourceHanSerif.txt", "assets/vendor/katex/LICENSE.txt", "assets/vendor/licenses/KaTeX-Fonts-OFL-1.1.txt", "assets/vendor/mermaid/mermaid.min.js", "assets/vendor/mermaid/LICENSE", "assets/vendor/licenses/npm/pako@2.1.0/LICENSE", "assets/vendor/licenses/npm/pako@2.1.0/LICENSE-ZLIB.txt", "assets/vendor/licenses/zotero-mcp-MIT.txt", "native/caj2pdf/caj2pdf.wasm", "native/caj2pdf/LICENSE", "native/caj2pdf/UPSTREAM.md", "docs/licensing/third-party-inventory.md", "docs/licensing/acquisition-runtime.md", "docs/licensing/caj-backend.md", "PRIVACY.md", "THIRD_PARTY_NOTICES.md")
    $licenseRoot = Join-Path $projectRoot "assets/vendor/licenses"
    foreach ($licenseFile in Get-ChildItem -LiteralPath $licenseRoot -Recurse -File) {
        $relative = $licenseFile.FullName.Substring($projectRoot.Length).TrimStart("\", "/").Replace("\", "/")
        $requiredEntries += $relative
    }
    foreach ($required in $requiredEntries) {
        if ($entries -notcontains $required) {
            throw "XPI missing required runtime file: $required"
        }
    }
    $forbidden = @($entries | Where-Object {
        $_ -match '(^|/)\.env(?:\.[^/]*)?$' -or
        $_ -match '(^|/)\.mutagen(?:\.yml(?:\.lock)?)?$' -or
        $_ -match '(^|/)(?:\.zotero-dev|\.serena|\.vscode|\.npm-cache|\.playwright-cli|node_modules|profile|cookies?|sessions?|session-storage|runtime|runtime-state)(/|$)' -or
        $_ -match '(^|/)node_modules/' -or
        ($_.ToLowerInvariant().EndsWith('.pdf') -and $_ -ne 'assets/docs/token-guide.pdf') -or
        $_ -match '\.(?:py|pyc)$'
    })
    if ($forbidden.Count) {
        throw "XPI contains forbidden file: $($forbidden -join ', ')"
    }
    if (@($entries | Where-Object { $_ -like "native/caj-backend/*" }).Count) {
        throw "XPI must contain the CAJ WASM distribution, not the Rust source tree."
    }
    $fileEntries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith("/") })
    $licenseEntries = @($entries | Where-Object { $_ -like "assets/vendor/licenses/*" })
    Write-Output "Actual files: $($fileEntries.Count)"
    Write-Output "Bundled vendor license files: $($licenseEntries.Count)"
    Write-Output "Forbidden entries: $($forbidden.Count)"
}
finally {
    $archive.Dispose()
}
}
catch {
    Remove-Item -LiteralPath $xpi -Force -ErrorAction SilentlyContinue
    throw
}
finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($xpi)
try {
    $digest = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
}
finally {
    $stream.Dispose()
    $sha256.Dispose()
}
$size = (Get-Item -LiteralPath $xpi).Length
Write-Output "Built: $xpi"
Write-Output "Size: $size bytes"
Write-Output "SHA256: $digest"
