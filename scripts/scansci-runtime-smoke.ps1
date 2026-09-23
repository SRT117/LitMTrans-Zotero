param(
  [int]$Port = 0,
  [string]$DownloadIdentifier = "",
  [switch]$ReuseDownloads,
  [switch]$PreserveOnFailure
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$smokeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot ".tmp-scansci-runtime-smoke"))
$pythonVersion = "3.13.15"
$scansciVersion = "1.17.0"
$pipVersion = "25.3"
$pythonHash = "d1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf"
$pipHash = "9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd"
$scansciHash = "e19853c25317a8af6f96236bdb28989a56129bd60f0c1198d8e6f84d86fdcf58"
$pythonUrls = @(
  "https://mirrors.huaweicloud.com/python/3.13.15/python-3.13.15-embed-amd64.zip",
  "https://mirrors.aliyun.com/python-release/windows/python-3.13.15-embed-amd64.zip",
  "https://www.python.org/ftp/python/3.13.15/python-3.13.15-embed-amd64.zip"
)
$pipUrls = @(
  "https://mirrors.aliyun.com/pypi/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl",
  "https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl"
)
$scansciUrls = @(
  "https://mirrors.aliyun.com/pypi/packages/a0/99/acceedf298bff7ebc91e4909360d0bd4854c0f4821096694fb817ffbada2/scansci_pdf-1.17.0-py3-none-any.whl",
  "https://files.pythonhosted.org/packages/a0/99/acceedf298bff7ebc91e4909360d0bd4854c0f4821096694fb817ffbada2/scansci_pdf-1.17.0-py3-none-any.whl"
)

function Download-Verified {
  param([string[]]$Urls, [string]$Destination, [string]$ExpectedHash)
  $last = $null
  foreach ($url in $Urls) {
    try {
      & curl.exe --fail --location --silent --show-error --connect-timeout 20 --max-time 120 --output $Destination $url
      if ($LASTEXITCODE -ne 0) { throw "下载失败：$url" }
      $sha = [Security.Cryptography.SHA256]::Create()
      $stream = [IO.File]::OpenRead($Destination)
      try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
      finally { $stream.Dispose(); $sha.Dispose() }
      if ($actual -ne $ExpectedHash.ToLowerInvariant()) { throw "SHA-256 校验失败：$url" }
      return
    }
    catch { $last = $_ }
  }
  if ($last) { throw $last }
  throw "没有可用下载源：$($Urls -join ', ')"
}

function Invoke-PrivatePython {
  param([string]$Python, [string[]]$Arguments, [string]$WorkingDirectory, [string]$Name)
  $stdout = Join-Path $smokeRoot "$Name.stdout.log"
  $stderr = Join-Path $smokeRoot "$Name.stderr.log"
  $process = Start-Process -FilePath $Python -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -Wait
  if ($process.ExitCode -ne 0) {
    $tail = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 30) -join "`n" } else { "" }
    throw "私有 Python 命令失败（$Name，退出码 $($process.ExitCode)）：$tail"
  }
  return $process
}

function Wait-Port {
  param([int]$TargetPort, [int]$TimeoutSeconds = 30)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
      $task = $client.ConnectAsync("127.0.0.1", $TargetPort)
      if ($task.Wait(500) -and $client.Connected) { return }
    }
    catch {}
    finally { $client.Dispose() }
    Start-Sleep -Milliseconds 200
  }
  throw "ScanSci MCP 服务端口未就绪：$TargetPort"
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { [int]$_.ParentProcessId -eq $ProcessId } |
    ForEach-Object { [int]$_.ProcessId })
  foreach ($child in $children) { Stop-ProcessTree -ProcessId $child }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Remove-SmokeRoot {
  if (-not (Test-Path -LiteralPath $smokeRoot)) { return }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction Stop
      if (-not (Test-Path -LiteralPath $smokeRoot)) { return }
    }
    catch {
      if ($attempt -ge 29) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Invoke-Mcp {
  param([hashtable]$Payload, [string]$SessionID = "")
  $headers = @{ Accept = "application/json, text/event-stream" }
  if ($SessionID) { $headers["Mcp-Session-Id"] = $SessionID }
  $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/mcp" -Method Post -Headers $headers -ContentType "application/json" -Body ($Payload | ConvertTo-Json -Depth 20 -Compress)
  $body = [string]$response.Content
  $json = $null
  if ($body.Trim()) {
    try { $json = $body | ConvertFrom-Json }
    catch {
      $rows = [regex]::Matches($body, '(?m)^data:\s*(\{.*\})\s*$')
      if ($rows.Count) { $json = $rows[$rows.Count - 1].Groups[1].Value | ConvertFrom-Json }
    }
  }
  [pscustomobject]@{
    Json = $json
    Body = $body
    SessionID = [string]$response.Headers["Mcp-Session-Id"]
  }
}

$server = $null
$failure = $null
$originalScanSciDataDir = [Environment]::GetEnvironmentVariable("SCANSCI_PDF_DATA_DIR", "Process")
try {
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw "需要 curl.exe 才能执行 ScanSci Windows Integration Smoke" }
  if (-not $ReuseDownloads) { Remove-SmokeRoot }
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $scanSciDataDir = Join-Path $smokeRoot "scansci-data"
  New-Item -ItemType Directory -Path $scanSciDataDir -Force | Out-Null
  [Environment]::SetEnvironmentVariable("SCANSCI_PDF_DATA_DIR", $scanSciDataDir, "Process")
  $embedArchive = Join-Path $smokeRoot "python-embed.zip"
  $pipWheel = Join-Path $smokeRoot "pip-$pipVersion-py3-none-any.whl"
  $scansciWheel = Join-Path $smokeRoot "scansci_pdf-$scansciVersion-py3-none-any.whl"
  if ($ReuseDownloads) {
    foreach ($entry in @(@{ Path = $embedArchive; Hash = $pythonHash }, @{ Path = $pipWheel; Hash = $pipHash }, @{ Path = $scansciWheel; Hash = $scansciHash })) {
      if (-not (Test-Path -LiteralPath $entry.Path -PathType Leaf)) { throw "复用 Smoke 下载文件缺失：$($entry.Path)" }
      $actualHash = (Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $entry.Hash.ToLowerInvariant()) { throw "复用 Smoke 文件 SHA-256 校验失败：$($entry.Path)" }
    }
  }
  else {
    Download-Verified $pythonUrls $embedArchive $pythonHash
    Download-Verified $pipUrls $pipWheel $pipHash
    Download-Verified $scansciUrls $scansciWheel $scansciHash
  }

  $pythonRoot = Join-Path $smokeRoot "python"
  $sitePackages = Join-Path $pythonRoot "Lib\site-packages"
  Expand-Archive -LiteralPath $embedArchive -DestinationPath $pythonRoot -Force
  $pth = Get-ChildItem -LiteralPath $pythonRoot -Filter "*_pth" -File | Select-Object -First 1
  if (-not $pth) { throw "embeddable Python 缺少 _pth 文件" }
  $pthLines = @(Get-Content -LiteralPath $pth.FullName)
  if (-not ($pthLines -match '^Lib[\\/]site-packages$')) { $pthLines += "Lib\site-packages" }
  if (-not ($pthLines -match '^import\s+site$')) { $pthLines += "import site" }
  [IO.File]::WriteAllText($pth.FullName, (($pthLines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
  New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
  $pipArchive = Join-Path $smokeRoot "pip-$pipVersion.zip"
  Copy-Item -LiteralPath $pipWheel -Destination $pipArchive -Force
  Expand-Archive -LiteralPath $pipArchive -DestinationPath $sitePackages -Force
  $python = Join-Path $pythonRoot "python.exe"
  if (-not (Test-Path -LiteralPath $python)) { throw "私有 Python 解压后缺少 python.exe" }
  Invoke-PrivatePython $python @("-m", "pip", "install", "--target", $sitePackages, "--upgrade", "--no-cache-dir", $scansciWheel, "--index-url", "https://mirrors.aliyun.com/pypi/simple", "--only-binary=:all:") $pythonRoot "pip-install" | Out-Null
  $probe = Join-Path $smokeRoot "probe.json"
  $probeLiteral = $probe.Replace("\", "\\").Replace("'", "\'")
  $probeScript = Join-Path $smokeRoot "probe.py"
  $probeCode = "import importlib.metadata as metadata, json, pathlib, sys, scansci_pdf, mcp; pathlib.Path('$probeLiteral').write_text(json.dumps({'pythonVersion': sys.version.split()[0], 'scansciVersion': metadata.version('scansci-pdf'), 'mcpVersion': metadata.version('mcp')}), encoding='utf-8')"
  [IO.File]::WriteAllText($probeScript, $probeCode, [Text.UTF8Encoding]::new($false))
  Invoke-PrivatePython $python @($probeScript) $pythonRoot "probe" | Out-Null
  $versions = Get-Content -LiteralPath $probe -Raw | ConvertFrom-Json
  if ($versions.pythonVersion -ne $pythonVersion -or $versions.scansciVersion -ne $scansciVersion -or -not $versions.mcpVersion) { throw "私有运行时版本探针失败：$($versions | ConvertTo-Json -Compress)" }

  if (-not $Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $Port = $listener.LocalEndpoint.Port
    $listener.Stop()
  }
  $originalScanSciProxy = [Environment]::GetEnvironmentVariable("SCANSCI_PDF_PROXY", "Process")
  $scanSciProxy = $originalScanSciProxy
  if (-not $scanSciProxy) {
    foreach ($name in @("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy")) {
      $scanSciProxy = [Environment]::GetEnvironmentVariable($name, "Process")
      if ($scanSciProxy) { break }
    }
  }
  try {
    if ($scanSciProxy) { [Environment]::SetEnvironmentVariable("SCANSCI_PDF_PROXY", $scanSciProxy, "Process") }
    $proxyProbeCode = @'
import os
from itertools import chain
from pathlib import Path
from scansci_pdf.network import fetch
from scansci_pdf.pdf_utils import is_pdf_file
response = None
written = 0
try:
    output_dir = Path(os.environ["SCANSCI_PDF_DATA_DIR"]) / "arxiv-probe"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "2401.00001.pdf"
    response = fetch("https://arxiv.org/pdf/2401.00001.pdf", {}, stream=True)
    print(f"ScanSci full response: status={response.status_code} contentType={response.headers.get('content-type', '')}")
    iterator = response.iter_content(chunk_size=8192)
    first = next(iterator, b"")
    print(f"ScanSci full first chunk: bytes={len(first)} prefix={first[:5]!r}")
    with output_path.open("wb") as stream:
        for chunk in chain((first,), iterator):
            if chunk:
                stream.write(chunk)
                written += len(chunk)
    valid = is_pdf_file(output_path)
    size = output_path.stat().st_size
    print(f"ScanSci full stream: bytes={written} fileBytes={size} pdfValid={valid}")
    raise SystemExit(0 if valid and size > 10000 else 29)
except SystemExit:
    raise
except Exception as error:
    print("ScanSci full stream exception=" + type(error).__name__ + " bytes=" + str(written))
    raise SystemExit(28)
finally:
    if response is not None:
        response.close()
'@
    $proxyProbeEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($proxyProbeCode))
    & $python -c "import base64; exec(base64.b64decode('$proxyProbeEncoded'))"
    if ($LASTEXITCODE -ne 0) { throw "ScanSci custom proxy request probe failed with exit code $LASTEXITCODE" }
    $server = Start-Process -FilePath $python -ArgumentList @("-m", "scansci_pdf.main", "run", "--mode", "streamable_http", "--host", "127.0.0.1", "--port", "$Port") -WorkingDirectory $pythonRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $smokeRoot "server.stdout.log") -RedirectStandardError (Join-Path $smokeRoot "server.stderr.log") -PassThru
  }
  finally {
    [Environment]::SetEnvironmentVariable("SCANSCI_PDF_PROXY", $originalScanSciProxy, "Process")
  }
  Wait-Port $Port
  $init = Invoke-Mcp @{ jsonrpc = "2.0"; id = 1; method = "initialize"; params = @{ protocolVersion = "2025-11-25"; capabilities = @{}; clientInfo = @{ name = "litmtrans-scansci-smoke"; version = "1" } } }
  if (-not $init.Json.result.protocolVersion) { throw "MCP initialize 失败：$($init.Body)" }
  $session = $init.SessionID
  Invoke-Mcp @{ jsonrpc = "2.0"; method = "notifications/initialized"; params = @{} } $session | Out-Null
  $tools = Invoke-Mcp @{ jsonrpc = "2.0"; id = 2; method = "tools/list"; params = @{} } $session
  $toolNames = @($tools.Json.result.tools | ForEach-Object { $_.name })
  if ($toolNames -notcontains "scansci_pdf_download") { throw "tools/list 缺少 scansci_pdf_download：$($toolNames -join ', ')" }
  $ping = Invoke-Mcp @{ jsonrpc = "2.0"; id = 3; method = "ping"; params = @{} } $session
  if ($ping.Json.error) { throw "MCP ping 失败：$($ping.Body)" }
  $config = Invoke-Mcp @{ jsonrpc = "2.0"; id = 4; method = "tools/call"; params = @{ name = "scansci_pdf_config"; arguments = @{} } } $session
  if ($config.Json.error -or $config.Json.result.isError) { throw "ScanSci 配置诊断调用失败：$($config.Body)" }
  if ($DownloadIdentifier.Trim()) {
    $oaRoot = Join-Path $smokeRoot "oa-download"
    New-Item -ItemType Directory -Path $oaRoot -Force | Out-Null
    $download = Invoke-Mcp @{ jsonrpc = "2.0"; id = 5; method = "tools/call"; params = @{ name = "scansci_pdf_download"; arguments = @{ identifier = $DownloadIdentifier.Trim(); strategy = "oa_first"; output_dir = $oaRoot } } } $session
    if ($download.Json.error -or $download.Json.result.isError) { throw "ScanSci OA 下载调用失败：$($download.Body)" }
    $downloadValue = $download.Json.result.structuredContent
    if ($downloadValue -and $downloadValue.result -is [string]) { $downloadValue = $downloadValue.result | ConvertFrom-Json }
    if (-not $downloadValue) {
      $textBlock = @($download.Json.result.content | Where-Object { $_.type -eq "text" } | Select-Object -First 1).text
      if ($textBlock) { $downloadValue = $textBlock | ConvertFrom-Json }
    }
    if (-not $downloadValue) { $downloadValue = $download.Json.result }
    $pdfPath = ""
    foreach ($candidatePath in @($downloadValue.file, $downloadValue.path, $downloadValue.pdfPath, $downloadValue.output_path)) {
      if (-not $pdfPath -and $candidatePath) { $pdfPath = [string]$candidatePath }
    }
    if (-not $pdfPath -or -not (Test-Path -LiteralPath $pdfPath -PathType Leaf)) { throw "ScanSci OA 下载未返回可用 PDF 路径：$($download.Body)" }
    $pdfRoot = [IO.Path]::GetFullPath($oaRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $pdfFull = [IO.Path]::GetFullPath($pdfPath)
    if (-not $pdfFull.StartsWith($pdfRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "ScanSci OA PDF 路径超出 Smoke 暂存目录：$pdfFull" }
    $bytes = [IO.File]::ReadAllBytes($pdfFull)
    if ($bytes.Length -lt 8 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 5) -ne "%PDF-") { throw "ScanSci OA 下载文件不是 PDF：$pdfFull" }
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $pageCount = [regex]::Matches($ascii, '/Type\s*/Page(?:\s|/|>)').Count
    if ($pageCount -lt 1) { throw "ScanSci OA PDF 未发现页面对象：$pdfFull" }
    Remove-Item -LiteralPath $pdfFull -Force
    if (Test-Path -LiteralPath $pdfFull) { throw "ScanSci OA PDF 清理失败：$pdfFull" }
    Write-Output "ScanSci OA download smoke passed: identifier $($DownloadIdentifier.Trim()), bytes $($bytes.Length), pages $pageCount"
  }
  Write-Output "ScanSci Windows Integration Smoke passed: Python $($versions.pythonVersion), scansci-pdf $($versions.scansciVersion), mcp $($versions.mcpVersion), port $Port"
}
catch {
  $failure = $_
}
finally {
  if ($server) {
    try {
      if (-not $server.HasExited) { Stop-ProcessTree -ProcessId $server.Id; [void]$server.WaitForExit(5000) }
      if (Get-Process -Id $server.Id -ErrorAction SilentlyContinue) { if (-not $failure) { $failure = "ScanSci server process remained after shutdown" } }
    }
    catch { if (-not $failure) { $failure = $_ } }
  }
  [Environment]::SetEnvironmentVariable("SCANSCI_PDF_DATA_DIR", $originalScanSciDataDir, "Process")
  $rootFull = [IO.Path]::GetFullPath($smokeRoot)
  $repoPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $rootFull.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -or $rootFull -eq $repoRoot) { if (-not $failure) { $failure = "拒绝清理未验证的 Smoke 临时目录：$rootFull" } }
  elseif (Test-Path -LiteralPath $rootFull) {
    if ($PreserveOnFailure -and $failure) { Write-Output "Smoke diagnostics preserved at $rootFull" }
    else {
      try { Remove-SmokeRoot }
      catch { if (-not $failure) { $failure = $_ } }
    }
  }
}
if ($failure) { throw $failure }
