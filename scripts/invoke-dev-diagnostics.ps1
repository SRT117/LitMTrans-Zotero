[CmdletBinding()]
param(
    [ValidateSet("snapshot", "multimodal-probe", "document-multimodal-probe", "document-streaming-probe", "chat-roundtrip-probe", "provider-cache-probe", "gemini-transport-probe", "edge-local-probe")]
    [string]$Operation = "multimodal-probe",
    [ValidateSet("7", "8", "9", "10")]
    [string]$ZoteroMajor = "10",
    [switch]$NoLaunch,
    [int]$TimeoutSeconds = 210
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$testVersion = & (Join-Path $PSScriptRoot "prepare-zotero-test-version.ps1") -Major $ZoteroMajor
$profileRoot = $testVersion.ProfilePath
$diagnosticsRoot = Join-Path $profileRoot "litmtrans\dev-diagnostics"
$commandPath = Join-Path $diagnosticsRoot "command.json"
$expectedToken = "LitMTrans-7391"
$probeFileName = "multimodal-probe.png"
$probePath = Join-Path $diagnosticsRoot $probeFileName

New-Item -ItemType Directory -Path $diagnosticsRoot -Force | Out-Null
Set-Content -LiteralPath (Join-Path $diagnosticsRoot "enabled") -Value "isolated development profile only" -Encoding utf8

if ($Operation -eq "multimodal-probe") {
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object System.Drawing.Bitmap 960, 540
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))
        $navy = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15, 23, 42))
        $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(37, 99, 235))
        $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 38, 38))
        $titleFont = New-Object System.Drawing.Font "Arial", 34, ([System.Drawing.FontStyle]::Bold)
        $codeFont = New-Object System.Drawing.Font "Consolas", 60, ([System.Drawing.FontStyle]::Bold)
        $smallFont = New-Object System.Drawing.Font "Arial", 24, ([System.Drawing.FontStyle]::Regular)
        try {
            $graphics.FillRectangle($blue, 0, 0, 960, 92)
            $graphics.DrawString("LITMTRANS - VISION PROBE", $titleFont, [System.Drawing.Brushes]::White, 48, 22)
            $graphics.FillEllipse($red, 72, 170, 150, 150)
            $graphics.FillRectangle($blue, 780, 330, 120, 120)
            $graphics.DrawString($expectedToken, $codeFont, $navy, 245, 188)
            $graphics.DrawString("RED CIRCLE  |  BLUE SQUARE", $smallFont, $navy, 280, 350)
            $graphics.DrawString("Return the large code exactly.", $smallFont, $navy, 300, 420)
            $bitmap.Save($probePath, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $smallFont.Dispose()
            $codeFont.Dispose()
            $titleFont.Dispose()
            $red.Dispose()
            $blue.Dispose()
            $navy.Dispose()
        }
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$commandID = [Guid]::NewGuid().ToString("N")
$resultPath = Join-Path $diagnosticsRoot "result.$commandID.json"
$command = @{
    id = $commandID
    operation = $Operation
    expectedToken = $expectedToken
    imageFileName = $probeFileName
    createdAt = [DateTime]::UtcNow.ToString("o")
}
$temporaryCommand = "$commandPath.tmp"
$command | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryCommand -Encoding utf8
Move-Item -LiteralPath $temporaryCommand -Destination $commandPath -Force

$isolatedZotero = Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" |
    Where-Object { $_.CommandLine -like "*$profileRoot*" } |
    Select-Object -First 1

if (-not $isolatedZotero -and -not $NoLaunch) {
    $logOut = Join-Path $diagnosticsRoot "start-dev.stdout.log"
    $logError = Join-Path $diagnosticsRoot "start-dev.stderr.log"
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start-dev.ps1"), "-ZoteroMajor", $ZoteroMajor) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logOut `
        -RedirectStandardError $logError | Out-Null
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        $result | ConvertTo-Json -Depth 20
        if (-not $result.ok -or ($Operation -in @("multimodal-probe", "document-multimodal-probe", "document-streaming-probe", "chat-roundtrip-probe", "gemini-transport-probe", "edge-local-probe") -and -not $result.passed)) {
            exit 1
        }
        exit 0
    }
    Start-Sleep -Milliseconds 400
}

throw "等待Zotero开发诊断结果超时。请检查 $diagnosticsRoot 下的启动日志。"
