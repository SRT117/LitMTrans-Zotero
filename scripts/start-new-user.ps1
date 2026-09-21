[CmdletBinding()]
param(
    [ValidateSet("7", "8", "9", "10")]
    [string]$ZoteroMajor = "10",
    [switch]$PrepareOnly,
    [switch]$Validate
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$devRoot = Join-Path $projectRoot ".zotero-dev"
$newUserRoot = Join-Path $devRoot "new-user"
$profilePath = Join-Path $newUserRoot "profile"
$dataPath = Join-Path $newUserRoot "data"
$logsRoot = Join-Path $devRoot "logs\new-user"
$stopScript = Join-Path $PSScriptRoot "stop-isolated-zotero.ps1"

function Remove-NewUserRoot {
    if (-not (Test-Path -LiteralPath $newUserRoot)) {
        return
    }

    # 先停止可能残留的隔离实例；否则 Remove-Item 失败时，旧数据可能被
    # -Force 静默保留下来并在下一次测试中继续使用。
    if (Test-Path -LiteralPath $profilePath) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript -ProfilePath $profilePath
        if ($LASTEXITCODE -ne 0) {
            throw "无法停止上一次新用户测试实例，拒绝复用旧测试数据。"
        }
    }

    $deadline = (Get-Date).AddSeconds(10)
    while (Test-Path -LiteralPath $newUserRoot) {
        try {
            Remove-Item -LiteralPath $newUserRoot -Recurse -Force -ErrorAction Stop
        }
        catch {
            if ((Get-Date) -ge $deadline) {
                throw "无法彻底清理新用户测试目录，拒绝复用可能残留的数据：$newUserRoot ($($_.Exception.Message))"
            }
            Start-Sleep -Milliseconds 250
        }
    }
}

# 获取固定的测试运行时二进制
$testVersion = & (Join-Path $PSScriptRoot "prepare-zotero-test-version.ps1") -Major $ZoteroMajor -ErrorAction Stop

Write-Host "==================== 新用户干净测试环境 ====================" -ForegroundColor Green
Write-Host "测试目标：Zotero $($testVersion.Version)" -ForegroundColor Green
Write-Host "临时 Profile：$profilePath" -ForegroundColor DarkGray
Write-Host "临时数据：$dataPath" -ForegroundColor DarkGray
Write-Host "日志归档：$logsRoot" -ForegroundColor DarkGray

# 启动前清理任何可能残留的上次运行数据，确保绝对纯净。
# 清理不完整时直接失败，不能把旧 profile/data 当成新用户环境继续启动。
Remove-NewUserRoot

# 创建干净的目录结构
New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null

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

    Write-Host "监测到隔离 Zotero 实例 (PID: $($runningPids -join ', '))，测试会话进行中..." -ForegroundColor DarkGray

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

Push-Location $projectRoot
try {
    if ($Validate) {
        Write-Host "运行静态验证与单测..." -ForegroundColor Cyan
        & node "scripts/validate.js"
        if ($LASTEXITCODE -ne 0) { throw "静态验证失败，终止启动。" }
    }

    Write-Host "[1/3] 同步最新待测插件..." -ForegroundColor Cyan
    $env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH = $testVersion.BinaryPath
    & (Join-Path $PSScriptRoot "prepare-dev-addon.ps1") -ZoteroVersion $testVersion.Version

    # 安装最新构建的扩展到新用户 Profile 中
    $extensionsDir = Join-Path $profilePath "extensions"
    New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null

    # 将 dist/addon 解包内容直接复制到新扩展目录中，模拟真实新用户安装
    $manifest = Get-Content (Join-Path $projectRoot "manifest.json") -Raw -Encoding utf8 | ConvertFrom-Json
    $addonId = $manifest.applications.zotero.id
    $addonInstallDir = Join-Path $extensionsDir $addonId
    Copy-Item -LiteralPath (Join-Path $projectRoot "dist\addon") -Destination $addonInstallDir -Recurse -Force

    # 配置新用户首选项：指向独立数据目录、禁止干扰性更新
    $userJs = Join-Path $profilePath "user.js"
    $prefsContent = @"
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.update.enabled", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.checkCompatibility", false);
"@
    Set-Content -LiteralPath $userJs -Value $prefsContent -Encoding utf8

    if ($PrepareOnly) {
        Write-Host "已完成新用户环境准备（PrepareOnly）。" -ForegroundColor Green
        return
    }

    Write-Host "[2/3] 启动隔离的新用户 Zotero 实例..." -ForegroundColor Cyan
    Write-Host "提示：这是一个全新用户环境（无历史文献、无缓存）。测试完成后请直接关闭 Zotero。" -ForegroundColor Yellow

    $zoteroArgs = @("-profile", $profilePath, "--dataDir", $dataPath, "-purgecaches", "-no-remote")

    $proc = Start-Process -FilePath $testVersion.BinaryPath -ArgumentList $zoteroArgs -PassThru
    try {
        Wait-IsolatedZotero -ProfilePath $profilePath
    }
    catch {
        # 异常中断时确保进程退出
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript -ProfilePath $profilePath
    }
}
finally {
    Pop-Location

    Write-Host "[3/3] 归档运行日志并清理临时环境..." -ForegroundColor Cyan

    # 1. 搜集并归档测试过程日志
    $timestamp = (Get-Date -Format "yyyyMMdd-HHmmss")
    $sessionLogDir = Join-Path $logsRoot "session-$timestamp"
    $latestLogDir = Join-Path $logsRoot "latest"
    $foundLogs = $false

    $logSources = @(
        (Join-Path $profilePath "litmtrans\logs"),
        (Join-Path $profilePath "crashes"),
        (Join-Path $profilePath "litmtrans\dev-diagnostics")
    )

    foreach ($source in $logSources) {
        if (Test-Path -LiteralPath $source) {
            if (-not (Test-Path -LiteralPath $sessionLogDir)) {
                New-Item -ItemType Directory -Path $sessionLogDir -Force | Out-Null
            }
            Copy-Item -LiteralPath $source -Destination $sessionLogDir -Recurse -Force
            $foundLogs = $true
        }
    }

    if ($foundLogs) {
        if (Test-Path -LiteralPath $latestLogDir) {
            Remove-Item -LiteralPath $latestLogDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Directory -Path $latestLogDir -Force | Out-Null
        Get-ChildItem -LiteralPath $sessionLogDir | Copy-Item -Destination $latestLogDir -Recurse -Force
        Write-Host "新用户运行日志已归档至: $sessionLogDir" -ForegroundColor Green
        Write-Host "最新日志目录: $latestLogDir" -ForegroundColor DarkGray
    } else {
        Write-Host "本次测试未产生需要持久保留的异常日志。" -ForegroundColor DarkGray
    }

    # 2. 彻底清理临时数据目录，不留垃圾
    if (Test-Path -LiteralPath $newUserRoot) {
        Remove-NewUserRoot
        Write-Host "新用户临时数据与 Profile 已彻底清空，本地开发环境保持整洁。" -ForegroundColor Green
    }
    Write-Host "==================== 新用户测试会话已结束 ====================" -ForegroundColor Green
}
