[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
    & node "scripts/validate.js"
    if ($LASTEXITCODE -ne 0) { throw "Validation failed, aborting XPI build." }
}
finally {
    Pop-Location
}
$manifest = Get-Content (Join-Path $projectRoot "manifest.json") -Raw | ConvertFrom-Json
$dist = Join-Path $projectRoot "dist"
$stage = Join-Path $dist "addon"
$xpi = Join-Path $dist ("litmtrans-{0}.xpi" -f $manifest.version)

Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $xpi -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($entry in @("manifest.json", "src", "assets", "locale", "README.md", "CHANGELOG.md", "PRIVACY.md", "SECURITY.md", "LICENSE", "THIRD_PARTY_NOTICES.md")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $entry) -Destination $stage -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot "src/bootstrap.js") -Destination (Join-Path $stage "bootstrap.js") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "src/prefs.js") -Destination (Join-Path $stage "prefs.js") -Force

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
    foreach ($required in @("manifest.json", "bootstrap.js", "prefs.js", "src/ported-core.js", "src/controller.js", "assets/icon-48.png", "assets/icon-96.png", "assets/docs/token-guide.pdf", "assets/fonts/SourceHanSerifCN-Regular.ttf", "assets/fonts/LICENSE-SourceHanSerif.txt", "assets/vendor/katex/LICENSE.txt", "assets/vendor/mermaid/mermaid.min.js", "assets/vendor/mermaid/LICENSE", "PRIVACY.md", "THIRD_PARTY_NOTICES.md")) {
        if ($entries -notcontains $required) {
            throw "XPI missing required runtime file: $required"
        }
    }
    $forbidden = @($entries | Where-Object {
        $_ -match '(^|/)\.env$' -or
        $_ -match '(^|/)node_modules/' -or
        ($_.ToLowerInvariant().EndsWith('.pdf') -and $_ -ne 'assets/docs/token-guide.pdf') -or
        $_ -match '\.(?:py|pyc)$'
    })
    if ($forbidden.Count) {
        throw "XPI contains forbidden file: $($forbidden -join ', ')"
    }
}
finally {
    $archive.Dispose()
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
