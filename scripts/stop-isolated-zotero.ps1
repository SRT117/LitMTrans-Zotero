[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProfilePath
)

$ErrorActionPreference = "Stop"
$profileRoot = [System.IO.Path]::GetFullPath($ProfilePath)

# zotero-plugin-scaffold otherwise falls back to `taskkill /im zotero.exe`.
# Match the exact development profile instead, so cancelling or rerunning a
# task cannot affect a user's normal Zotero session.
$targets = Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" |
    Where-Object {
        $commandLine = [string]$_.CommandLine
        $commandLine -and $commandLine.IndexOf($profileRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }

foreach ($target in $targets) {
    Write-Host "停止隔离 Zotero 进程: $($target.ProcessId)" -ForegroundColor DarkGray
    Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
}
