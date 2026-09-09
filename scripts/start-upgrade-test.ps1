[CmdletBinding()]
param(
    [ValidateSet("7", "8", "9", "10")]
    [string]$ZoteroMajor = "10",
    [switch]$KeepUpdated,
    [switch]$PrepareOnly,
    [int]$ServerPort = 23129
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$devRoot = Join-Path $projectRoot ".zotero-dev"
$upgradeRoot = Join-Path $devRoot "upgrade-test"
$profilePath = Join-Path $upgradeRoot "profile"
$dataPath = Join-Path $upgradeRoot "data"
$serverRoot = Join-Path $upgradeRoot "server"
$releasesRoot = Join-Path $devRoot "releases"
$releaseXpiPath = Join-Path $releasesRoot "litmtrans-2.0.0.xpi"

# 获取固定的测试运行时二进制
$testVersion = & (Join-Path $PSScriptRoot "prepare-zotero-test-version.ps1") -Major $ZoteroMajor -ErrorAction Stop

Write-Host "==================== 老用户更新体验环境 ====================" -ForegroundColor Green
Write-Host "测试目标：Zotero $($testVersion.Version)" -ForegroundColor Green
Write-Host "持久 Profile：$profilePath" -ForegroundColor DarkGray
Write-Host "持久数据：$dataPath" -ForegroundColor DarkGray
Write-Host "本地更新服务端口：$ServerPort" -ForegroundColor DarkGray

# 确保持久目录与服务目录存在
New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
New-Item -ItemType Directory -Path $serverRoot -Force | Out-Null
New-Item -ItemType Directory -Path $releasesRoot -Force | Out-Null

# 1. 确保已有 GitHub Release 发布的基线版本
if (-not (Test-Path -LiteralPath $releaseXpiPath -PathType Leaf)) {
    Write-Host "本地未找到已发布的 Release XPI，正在从 GitHub 下载 v2.0.0..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri "https://github.com/SRT117/LitMTrans-Zotero/releases/download/v2.0.0/litmtrans-2.0.0.xpi" -OutFile $releaseXpiPath
        Write-Host "Release XPI 下载成功: $releaseXpiPath" -ForegroundColor Green
    }
    catch {
        throw "无法从 GitHub 下载官方 Release v2.0.0 基线版本 ($($_.Exception.Message))。请检查网络连接，或手动将官方 litmtrans-2.0.0.xpi 放置于 '$releaseXpiPath' 后重试。"
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

# 严格校验基线 Release 文件的完整性与版本号，严禁被未提交源码伪造或污染
try {
    $baselineArchive = [System.IO.Compression.ZipFile]::OpenRead($releaseXpiPath)
    $manifestEntry = $baselineArchive.GetEntry("manifest.json")
    if (-not $manifestEntry) { throw "XPI 压缩包缺少 manifest.json。" }
    $reader = New-Object System.IO.StreamReader($manifestEntry.Open(), [System.Text.Encoding]::UTF8)
    $baseManifest = $reader.ReadToEnd() | ConvertFrom-Json
    $reader.Dispose()
    $baselineArchive.Dispose()
    if ($baseManifest.version -ne "2.0.0") {
        throw "本地缓存的 XPI 版本号为 '$($baseManifest.version)'，不是预期的官方基线版本 2.0.0。"
    }
    Write-Host "已校验 Release 基线版本: v$($baseManifest.version) ($releaseXpiPath)" -ForegroundColor DarkGray
}
catch {
    Remove-Item -LiteralPath $releaseXpiPath -Force -ErrorAction SilentlyContinue
    throw "本地 Release 基线版本校验失败: $($_.Exception.Message)。已清理无效文件，请重新运行脚本重试下载。"
}

function Wait-IsolatedZotero {
    param(
        [Parameter(Mandatory)][string]$ProfilePath,
        [int]$StartupTimeoutSeconds = 15
    )
    $profileRoot = [System.IO.Path]::GetFullPath($ProfilePath)
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)

    $runningPids = @()
    while ((Get-Date) -lt $deadline) {
        $processes = Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $cmd = [string]$_.CommandLine
                $cmd -and $cmd.IndexOf($profileRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            }
        if ($processes) {
            $runningPids = @($processes | ForEach-Object { $_.ProcessId })
            break
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $runningPids.Count) {
        Write-Warning "未检测到针对该 Profile 的 Zotero 运行进程，可能已提前退出。"
        return
    }

    Write-Host "监测到隔离 Zotero 实例 (PID: $($runningPids -join ', '))，升级测试会话进行中..." -ForegroundColor DarkGray

    while ($true) {
        Start-Sleep -Milliseconds 500
        $stillRunning = Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $cmd = [string]$_.CommandLine
                $cmd -and $cmd.IndexOf($profileRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            }
        if (-not $stillRunning) {
            break
        }
    }
}

# 辅助函数：将指定 XPI 解包安装为特定扩展，并覆写其 update_url
function Install-BaseReleaseExtension {
    param(
        [string]$XpiPath,
        [string]$TargetProfile,
        [int]$Port
    )
    $extDir = Join-Path $TargetProfile "extensions"
    $addonId = "litmtrans@srt117.github.io"
    $addonDir = Join-Path $extDir $addonId
    $installedXpi = Join-Path $extDir "$addonId.xpi"

    # 清理已有扩展目录或 XPI
    if (Test-Path -LiteralPath $addonDir) { Remove-Item -LiteralPath $addonDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $installedXpi) { Remove-Item -LiteralPath $installedXpi -Force -ErrorAction SilentlyContinue }

    New-Item -ItemType Directory -Path $addonDir -Force | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($XpiPath, $addonDir)

    # 调整该 Release 插件的 update_url 为本地更新服务
    $addonManifestPath = Join-Path $addonDir "manifest.json"
    if (Test-Path -LiteralPath $addonManifestPath) {
        $addonManifest = Get-Content -LiteralPath $addonManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        $addonManifest.applications.zotero.update_url = "http://127.0.0.1:$Port/update.json"
        $addonManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $addonManifestPath -Encoding utf8
    }

    # 清除启动字节码缓存，确保重新加载基线版本
    $startupCache = Join-Path $TargetProfile "startupCache"
    if (Test-Path -LiteralPath $startupCache) { Remove-Item -LiteralPath $startupCache -Recurse -Force -ErrorAction SilentlyContinue }
}

# 2. 构建未发布的最新版本作为待更新目标
Push-Location $projectRoot
$serverProc = $null
try {
    Write-Host "[1/4] 验证并构建待更新的最新未发布版本..." -ForegroundColor Cyan
    & node "scripts/validate.js"
    if ($LASTEXITCODE -ne 0) { throw "静态验证失败，终止启动。" }

    & (Join-Path $PSScriptRoot "build-xpi.ps1")
    if ($LASTEXITCODE -ne 0) { throw "最新插件构建失败，终止启动。" }

    $env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH = $testVersion.BinaryPath
    & (Join-Path $PSScriptRoot "prepare-dev-addon.ps1")

    # 为更新包设置一个更高版本号（如 2.0.1-preview），以便触发升级检测
    $updateStage = Join-Path $serverRoot "stage"
    $updateXpi = Join-Path $serverRoot "litmtrans-dev-update.xpi"
    $updateJson = Join-Path $serverRoot "update.json"

    if (Test-Path -LiteralPath $updateStage) { Remove-Item -LiteralPath $updateStage -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $updateXpi) { Remove-Item -LiteralPath $updateXpi -Force -ErrorAction SilentlyContinue }

    New-Item -ItemType Directory -Path $updateStage -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $projectRoot "dist\addon") | Copy-Item -Destination $updateStage -Recurse -Force

    $stageManifestPath = Join-Path $updateStage "manifest.json"
    $stageManifest = Get-Content -LiteralPath $stageManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    $rawVersion = [string]$stageManifest.version
    $updateVersion = if ($rawVersion -eq "2.0.0") { "2.0.1-preview" } else { "$rawVersion.1-preview" }
    $stageManifest.version = $updateVersion
    $stageManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $stageManifestPath -Encoding utf8

    # 打包为更新 XPI
    $archive = [System.IO.Compression.ZipFile]::Open($updateXpi, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -LiteralPath $updateStage -Recurse -File |
            Sort-Object FullName |
            ForEach-Object {
                $entryName = $_.FullName.Substring($updateStage.Length).TrimStart("\", "/").Replace("\", "/")
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

    # 计算更新 XPI 哈希并生成 update.json
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($updateXpi)
    try {
        $digest = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $sha256.Dispose()
    }

    $updatePayload = @{
        addons = @{
            "litmtrans@srt117.github.io" = @{
                updates = @(
                    @{
                        version = $updateVersion
                        update_link = "http://127.0.0.1:$ServerPort/litmtrans-dev-update.xpi"
                        update_hash = "sha256:$digest"
                        applications = @{
                            zotero = @{
                                strict_min_version = "7.0"
                                strict_max_version = "*"
                            }
                        }
                    }
                )
            }
        }
    }
    $updatePayload | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $updateJson -Encoding utf8

    Write-Host "[2/4] 部署老用户基线 Release 版本并配置更新偏好..." -ForegroundColor Cyan
    Install-BaseReleaseExtension -XpiPath $releaseXpiPath -TargetProfile $profilePath -Port $ServerPort

    # 写入偏好：允许本地 HTTP 更新检查，重置计时器触发即时更新
    $userJs = Join-Path $profilePath "user.js"
    $prefsContent = @"
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.checkUpdateSecurity", false);
user_pref("extensions.update.enabled", true);
user_pref("extensions.update.interval", 5);
user_pref("app.update.lastUpdateTime.addon-background-update-timer", 0);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.checkCompatibility", false);
"@
    Set-Content -LiteralPath $userJs -Value $prefsContent -Encoding utf8

    Write-Host "[3/4] 启动本地更新服务 (端口 $ServerPort)..." -ForegroundColor Cyan
    $serverScript = Join-Path $PSScriptRoot "serve-upgrade-server.mjs"
    $serverProc = Start-Process node -ArgumentList @("`"$serverScript`"", "--port", $ServerPort, "--manifest", "`"$updateJson`"", "--xpi", "`"$updateXpi`"") -PassThru

    $serverReady = $false
    $serverTimeout = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $serverTimeout) {
        if ($serverProc.HasExited) {
            throw "本地更新服务器未能成功启动，进程已退出（退出码 $($serverProc.ExitCode)）。请检查端口 $ServerPort 是否被占用。"
        }
        try {
            $status = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/status" -TimeoutSec 1 -ErrorAction Stop
            if ($status.status -eq "running") {
                $serverReady = $true
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 200
        }
    }
    if (-not $serverReady) {
        throw "等待本地更新服务器就绪超时（端口 $ServerPort）。"
    }
    Write-Host "本地更新服务已就绪 (http://127.0.0.1:$ServerPort)。" -ForegroundColor Green

    if ($PrepareOnly) {
        Write-Host "已完成老用户更新环境准备（PrepareOnly）。" -ForegroundColor Green
        return
    }

    Write-Host "[4/4] 启动老用户 Zotero 实例..." -ForegroundColor Cyan
    Write-Host "提示：当前运行的是 Release 版本，并已指向本地待发布更新源 ($updateVersion)。" -ForegroundColor Yellow
    Write-Host "可以在 Zotero 中体验自动更新弹窗或在“工具 -> 附加组件”中测试更新流程。" -ForegroundColor DarkGray
    Write-Host "老用户的数据（文献、翻译缓存、设置）将永久保留。" -ForegroundColor DarkGray

    $stopScript = Join-Path $PSScriptRoot "stop-isolated-zotero.ps1"
    $zoteroArgs = @("-profile", $profilePath, "--dataDir", $dataPath, "-purgecaches", "-no-remote")

    $proc = Start-Process -FilePath $testVersion.BinaryPath -ArgumentList $zoteroArgs -PassThru
    try {
        Wait-IsolatedZotero -ProfilePath $profilePath
    }
    catch {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript -ProfilePath $profilePath
    }
}
finally {
    Pop-Location

    Write-Host "正在收尾老用户更新测试环境..." -ForegroundColor Cyan

    # 1. 停止本地更新服务
    if ($serverProc -and -not $serverProc.HasExited) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/shutdown" -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null
        } catch {}
        Start-Sleep -Milliseconds 300
        if (-not $serverProc.HasExited) {
            Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Host "本地更新服务已停止。" -ForegroundColor DarkGray
    }

    # 2. 插件状态还原策略
    if ($KeepUpdated) {
        Write-Host "检测到 -KeepUpdated 参数，已保留更新后的插件版本以供后续调试。" -ForegroundColor Yellow
    }
    else {
        Write-Host "正在将插件还原至未触发更新前的 Release 版本（保持所有用户文献与翻译数据不变）..." -ForegroundColor Cyan
        Install-BaseReleaseExtension -XpiPath $releaseXpiPath -TargetProfile $profilePath -Port $ServerPort
        Write-Host "插件已成功恢复为 Release 基线，下次启动可再次体验完整的更新链路。" -ForegroundColor Green
    }

    # 清理更新临时目录
    if (Test-Path -LiteralPath $serverRoot) {
        Remove-Item -LiteralPath $serverRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host "老用户文献、翻译缓存及偏好设置已完整保存在: $upgradeRoot" -ForegroundColor Green
    Write-Host "==================== 老用户更新测试会话已结束 ====================" -ForegroundColor Green
}
