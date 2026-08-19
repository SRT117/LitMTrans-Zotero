[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("7", "8", "9", "10")]
    [string]$Major
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$devRoot = Join-Path $projectRoot ".zotero-dev"
$versionsRoot = Join-Path $devRoot "versions"
$compatRoot = Join-Path $devRoot "compat"
$compatArchiveRoot = Join-Path $devRoot "compat-archive"

function Assert-ChildPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Parent
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if (-not $resolvedPath.StartsWith("$resolvedParent\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作测试根目录之外的路径：$resolvedPath"
    }
}

function Get-ZoteroApplicationVersion {
    param([Parameter(Mandatory)][string]$BinaryPath)

    $applicationIni = Join-Path (Split-Path -Parent $BinaryPath) "app\application.ini"
    if (-not (Test-Path -LiteralPath $applicationIni -PathType Leaf)) {
        throw "Zotero 运行目录缺少 app/application.ini：$applicationIni"
    }
    $match = Select-String -LiteralPath $applicationIni -Pattern '^Version=(?<version>.+)$' | Select-Object -First 1
    if (-not $match) {
        throw "无法从 $applicationIni 读取 Zotero 版本。"
    }
    return $match.Matches[0].Groups['version'].Value.Trim()
}

function Find-InstalledZotero {
    $candidates = @(
        "C:\Program Files\Zotero\zotero.exe",
        "C:\Program Files (x86)\Zotero\zotero.exe"
    )
    return $candidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}

function Restore-ZoteroRuntime {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$DownloadUrl
    )

    New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
    $archivePath = Join-Path $versionsRoot "Zotero-$Version`_win-x64.zip"
    $versionRoot = Join-Path $versionsRoot $Version
    $runtimeRoot = Join-Path $versionRoot "Zotero_win-x64"
    $binaryPath = Join-Path $runtimeRoot "zotero.exe"

    $runtimeVersion = $null
    if (Test-Path -LiteralPath $binaryPath -PathType Leaf) {
        try { $runtimeVersion = Get-ZoteroApplicationVersion -BinaryPath $binaryPath } catch { $runtimeVersion = $null }
    }
    if ($runtimeVersion -ne $Version) {
        if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
            $partialArchive = "$archivePath.partial"
            Assert-ChildPath -Path $partialArchive -Parent $versionsRoot
            Write-Host "下载 Zotero $Version 测试运行时..." -ForegroundColor Cyan
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $partialArchive
            Move-Item -LiteralPath $partialArchive -Destination $archivePath -Force
        }

        $runningRuntime = Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" |
            Where-Object {
                $commandLine = [string]$_.CommandLine
                $executablePath = [string]$_.ExecutablePath
                $executablePath.StartsWith($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
                    $commandLine.IndexOf($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            } |
            Select-Object -First 1
        if ($runningRuntime) {
            throw "Zotero $Version 仍在运行（PID $($runningRuntime.ProcessId)）。请先关闭测试窗口再重试。"
        }

        $temporaryRoot = Join-Path $versionsRoot (".extract-{0}-{1}" -f $Version, [guid]::NewGuid().ToString("N"))
        Assert-ChildPath -Path $temporaryRoot -Parent $versionsRoot
        try {
            Write-Host "恢复 Zotero $Version 测试运行时..." -ForegroundColor Cyan
            Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryRoot -Force
            $temporaryRuntime = Join-Path $temporaryRoot "Zotero_win-x64"
            $temporaryBinary = Join-Path $temporaryRuntime "zotero.exe"
            if ((Get-ZoteroApplicationVersion -BinaryPath $temporaryBinary) -ne $Version) {
                throw "本地压缩包不是预期的 Zotero $Version：$archivePath"
            }

            New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
            Assert-ChildPath -Path $runtimeRoot -Parent $versionsRoot
            if (Test-Path -LiteralPath $runtimeRoot) {
                Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
            }
            Move-Item -LiteralPath $temporaryRuntime -Destination $runtimeRoot
        }
        finally {
            if (Test-Path -LiteralPath $temporaryRoot) {
                Assert-ChildPath -Path $temporaryRoot -Parent $versionsRoot
                Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
            }
        }
    }

    # Firefox enterprise policy is honored before profile preferences are read.
    # Keep old test binaries pinned even if Zotero's updater checks immediately.
    $distributionRoot = Join-Path $runtimeRoot "distribution"
    New-Item -ItemType Directory -Path $distributionRoot -Force | Out-Null
    @{
        policies = @{
            DisableAppUpdate = $true
        }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $distributionRoot "policies.json") -Encoding utf8

    return $binaryPath
}

$matrix = @{
    "7" = @{
        Version = "7.0.32"
        Url = "https://www.zotero.org/download/client/dl?channel=release&platform=win-x64-zip&version=7.0.32"
    }
    "8" = @{
        Version = "8.0.4"
        Url = "https://www.zotero.org/download/client/dl?channel=release&platform=win-x64-zip&version=8.0.4"
    }
    "9" = @{
        Version = "9.0.6"
        Url = "https://www.zotero.org/download/client/dl?channel=release&platform=win-x64-zip&version=9.0.6"
    }
    "10" = @{
        Version = "10.0"
        Url = "https://www.zotero.org/download/client/dl?channel=release&platform=win-x64-zip&version=10.0"
    }
}

if ($matrix.ContainsKey($Major)) {
    $target = $matrix[$Major]
    $version = $target.Version
    $binary = Restore-ZoteroRuntime -Version $version -DownloadUrl $target.Url
}
else {
    $binary = Find-InstalledZotero
    if (-not $binary) {
        throw "未找到 Zotero $Major。请安装 Zotero $Major，或使用已配置的测试任务。"
    }
    $version = Get-ZoteroApplicationVersion -BinaryPath $binary
    if (-not $version.StartsWith("$Major.", [System.StringComparison]::Ordinal)) {
        throw "系统 Zotero 不是 $Major.x，而是 $version：$binary"
    }
}

$compatPath = Join-Path $compatRoot $version
$profilePath = Join-Path $compatPath "profile"
$dataPath = Join-Path $compatPath "data"
$compatibilityIni = Join-Path $profilePath "compatibility.ini"
if (Test-Path -LiteralPath $compatibilityIni -PathType Leaf) {
    $lastVersionLine = Select-String -LiteralPath $compatibilityIni -Pattern '^LastVersion=(?<version>\d+)\.' | Select-Object -First 1
    $lastMajor = if ($lastVersionLine) { $lastVersionLine.Matches[0].Groups['version'].Value } else { $null }
    if ($lastMajor -and $lastMajor -ne $Major) {
        New-Item -ItemType Directory -Path $compatArchiveRoot -Force | Out-Null
        $archiveName = "{0}-opened-by-{1}-{2}" -f $version, $lastMajor, (Get-Date -Format "yyyyMMdd-HHmmss")
        $archivedCompat = Join-Path $compatArchiveRoot $archiveName
        Assert-ChildPath -Path $compatPath -Parent $compatRoot
        Assert-ChildPath -Path $archivedCompat -Parent $compatArchiveRoot
        Write-Host "归档已被 Zotero $lastMajor 打开的 Zotero $Major 测试库：$archivedCompat" -ForegroundColor Yellow
        Move-Item -LiteralPath $compatPath -Destination $archivedCompat
    }
}

New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null

[pscustomobject]@{
    Major = $Major
    Version = $version
    BinaryPath = $binary
    ProfilePath = $profilePath
    DataPath = $dataPath
}
