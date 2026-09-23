[CmdletBinding()]
param(
  [string]$Identifier = "2401.00001",
  [int]$Port = 0
)

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$e2eRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot ".zotero-dev\mcp-acquisition-e2e"))
$profilePath = Join-Path $e2eRoot "profile"
$dataPath = Join-Path $e2eRoot "data"
$zoteroProcess = $null
$sessionID = ""
$documentTitle = "LitMTrans MCP E2E $Identifier"

function Assert-ChildPath {
  param([string]$Path, [string]$Parent)
  $child = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $root = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if (-not $child.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) -and $child -ne $root) { throw "拒绝操作隔离 E2E 根目录之外的路径：$child" }
}

function Stop-Tree {
  param([int]$ProcessId)
  $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { [int]$_.ParentProcessId -eq $ProcessId } | ForEach-Object { [int]$_.ProcessId })
  foreach ($child in $children) { Stop-Tree -ProcessId $child }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Get-FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $value = [int]$listener.LocalEndpoint.Port
  $listener.Stop()
  return $value
}

function Get-ManagedRuntimeProcesses {
  param([string]$RuntimeRoot)
  $root = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd([char]'\', [char]'/')
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $executable = [string]$_.ExecutablePath
    $commandLine = [string]$_.CommandLine
    ($executable -and $executable.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) -or
      ($commandLine -and $commandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  })
}

function Get-IsolatedZoteroProcessIDs {
  param([string]$ProfilePath)
  $profileRoot = [IO.Path]::GetFullPath($ProfilePath)
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $tracked = @{}
  foreach ($process in $all) {
    if ($process.Name -ieq "zotero.exe" -and ([string]$process.CommandLine).IndexOf($profileRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $tracked[[string]$process.ProcessId] = $true
    }
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $all) {
      $processID = [string]$process.ProcessId
      if ($tracked.ContainsKey([string]$process.ParentProcessId) -and -not $tracked.ContainsKey($processID)) {
        $tracked[$processID] = $true
        $changed = $true
      }
    }
  }
  return @($tracked.Keys | ForEach-Object { [int]$_ } | Sort-Object -Unique)
}

function Get-IsolatedZoteroMainWindowProcess {
  param([string]$ProfilePath)
  $profileRoot = [IO.Path]::GetFullPath($ProfilePath)
  $targets = Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $commandLine = [string]$_.CommandLine
    $commandLine -and $commandLine.IndexOf($profileRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  foreach ($target in $targets) {
    $process = Get-Process -Id ([int]$target.ProcessId) -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) { return $process }
  }
  return $null
}

function Wait-IsolatedZoteroMainWindowProcess {
  param([string]$ProfilePath, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $process = Get-IsolatedZoteroMainWindowProcess -ProfilePath $ProfilePath
    if ($process) { return $process }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  throw "未能找到使用隔离 Profile 的 Zotero 主窗口进程"
}

function Stop-IsolatedZoteroProcessTrees {
  param([string]$ProfilePath)
  $profileRoot = [IO.Path]::GetFullPath($ProfilePath)
  $roots = @(Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" -ErrorAction SilentlyContinue | Where-Object {
    ([string]$_.CommandLine).IndexOf($profileRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  foreach ($root in $roots) { Stop-Tree -ProcessId ([int]$root.ProcessId) }
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $remaining = @(Get-IsolatedZoteroProcessIDs -ProfilePath $ProfilePath)
    if (-not $remaining.Count) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "无法清理隔离 Profile 的 Zotero 子进程：$($remaining -join ',')"
}

function Invoke-GracefulZoteroShutdown {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$RuntimeRoot,
    [string]$ProfilePath,
    [switch]$RequireManagedProcess
  )
  $mainWindowProcess = Get-IsolatedZoteroMainWindowProcess -ProfilePath $ProfilePath
  if ($mainWindowProcess) { $Process = $mainWindowProcess }
  if (-not $Process -or $Process.MainWindowHandle -eq 0) { throw "关闭目标不是隔离 Profile 的 Zotero 主窗口进程" }
  $zoteroPID = [int]$Process.Id
  $zoteroPIDs = @(Get-IsolatedZoteroProcessIDs -ProfilePath $ProfilePath)
  if ($zoteroPID -notin $zoteroPIDs) { $zoteroPIDs += $zoteroPID }
  $zoteroPIDs = @($zoteroPIDs | Sort-Object -Unique)
  $managedBefore = @(Get-ManagedRuntimeProcesses -RuntimeRoot $RuntimeRoot)
  if ($RequireManagedProcess -and -not $managedBefore.Count) { throw "关闭前没有观察到隔离 Profile 中的托管 Python/ScanSci 进程" }
  $managedPIDs = @($managedBefore | ForEach-Object { [int]$_.ProcessId })
  Write-Host "请求 Zotero 正常退出，主窗口 PID $zoteroPID；跟踪 Zotero/子进程 PID: $($zoteroPIDs -join ',')；托管进程 PID: $($managedPIDs -join ',')" -ForegroundColor DarkGray
  $Process.Refresh()
  if (-not $Process.HasExited -and -not $Process.CloseMainWindow()) { throw "未能向隔离 Zotero 主窗口发送正常退出请求" }
  if (-not $Process.WaitForExit(90000)) { throw "隔离 Zotero 未能在 90 秒内正常退出" }

  if ($ProfilePath) {
    $prefsPath = Join-Path $ProfilePath "prefs.js"
    $prefsText = if (Test-Path -LiteralPath $prefsPath) { Get-Content -LiteralPath $prefsPath -Raw } else { "" }
    $observerReached = $prefsText -match 'user_pref\("extensions\.litmtrans\.agentTestShutdownProbeObserverReached", true\);'
    $windowUnloadReached = $prefsText -match 'user_pref\("extensions\.litmtrans\.agentTestShutdownProbeMainWindowUnloadReached", true\);'
    $stopStarted = $prefsText -match 'user_pref\("extensions\.litmtrans\.agentTestShutdownProbeStopStarted", true\);'
    $acquisitionShutdownCompleted = $prefsText -match 'user_pref\("extensions\.litmtrans\.agentTestShutdownProbeAcquisitionShutdownCompleted", true\);'
    $controllerShutdownCompleted = $prefsText -match 'user_pref\("extensions\.litmtrans\.agentTestShutdownProbeControllerShutdownCompleted", true\);'
    $killAttemptsMatch = [regex]::Match($prefsText, 'user_pref\("extensions\.litmtrans\.agentTestShutdownProbeKillAttempts", (\d+)\);')
    $killPIDMatch = [regex]::Match($prefsText, 'user_pref\("extensions\.litmtrans\.agentTestShutdownProbePID", (\d+)\);')
    $killAttempts = if ($killAttemptsMatch.Success) { [int]$killAttemptsMatch.Groups[1].Value } else { 0 }
    $killPID = if ($killPIDMatch.Success) { [int]$killPIDMatch.Groups[1].Value } else { 0 }
    if (-not $controllerShutdownCompleted) { throw "未观察到 Controller/Agent 正常关闭完成，不能将 Stop-Tree 清理算作插件生命周期通过" }
    if (-not $acquisitionShutdownCompleted) { throw "未观察到 Agent acquisition/client 正常关闭完成" }
    if ($RequireManagedProcess) {
      if (-not $observerReached -and -not $windowUnloadReached) { throw "未观察到 Zotero 退出生命周期入口" }
      if (-not $stopStarted -or $killAttempts -lt 1) { throw "未观察到 acquisition/client 关闭托管进程" }
      if ($killPID -notin $managedPIDs) { throw "client shutdown PID 不属于关闭前记录的托管 ScanSci/Python PID：$killPID" }
    }
    Write-Host "plugin-lifecycle validated: Agent acquisition/client and Controller shutdown completed; managed PID(s) before close=$($managedPIDs -join ','); client shutdown PID=$killPID; observer=$observerReached; windowUnload=$windowUnloadReached" -ForegroundColor DarkGray
  }

  $deadline = (Get-Date).AddSeconds(30)
  $remaining = @()
  do {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $remaining = @($all | Where-Object {
      ([int]$_.ProcessId -in $zoteroPIDs) -or
        ([int]$_.ProcessId -in $managedPIDs) -or
        ($RuntimeRoot -and (([string]$_.ExecutablePath).IndexOf($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or ([string]$_.CommandLine).IndexOf($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0))
    })
    if (-not $remaining.Count) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if ($remaining.Count) { throw "正常关闭 Zotero 后仍有隔离 Zotero/托管子进程：$($remaining.ProcessId -join ',')" }
  return [pscustomobject]@{ zoteroPID = $zoteroPID; zoteroPIDs = $zoteroPIDs; managedPIDs = $managedPIDs; shutdownEvidence = "plugin-lifecycle" }
}

function Convert-McpBody {
  param([string]$Body)
  $text = ([string]$Body).TrimStart([char]0xFEFF)
  if (-not $text.Trim()) { return $null }
  $script:lastJsonError = ""

  function Try-ConvertJson {
    param([string]$Candidate)
    try { return $Candidate | ConvertFrom-Json } catch { $firstError = $_.Exception.Message }
    try {
      Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
      $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
      $serializer.MaxJsonLength = [int]::MaxValue
      return $serializer.DeserializeObject($Candidate)
    } catch {
      if (-not $script:lastJsonError) { $script:lastJsonError = "$firstError; $($_.Exception.Message)" }
      return $null
    }
  }

  function Normalize-JsonControls {
    param([string]$Candidate)
    $builder = [Text.StringBuilder]::new()
    $insideString = $false
    $escaped = $false
    foreach ($character in $Candidate.ToCharArray()) {
      if ($insideString) {
        if ($escaped) {
          [void]$builder.Append($character)
          $escaped = $false
          continue
        }
        if ($character -eq '\\') {
          [void]$builder.Append($character)
          $escaped = $true
          continue
        }
        if ($character -eq '"') {
          [void]$builder.Append($character)
          $insideString = $false
          continue
        }
        switch ([int][char]$character) {
          9 { [void]$builder.Append('\\t'); continue }
          10 { [void]$builder.Append('\\n'); continue }
          13 { [void]$builder.Append('\\r'); continue }
        }
      } elseif ($character -eq '"') {
        $insideString = $true
      }
      [void]$builder.Append($character)
    }
    return $builder.ToString()
  }

  $parsed = Try-ConvertJson $text
  if ($null -ne $parsed) { return $parsed }

  $start = 0
  while (($start = $text.IndexOf('{', $start)) -ge 0) {
    $depth = 0
    $insideString = $false
    $escaped = $false
    for ($index = $start; $index -lt $text.Length; $index++) {
      $character = $text[$index]
      if ($insideString) {
        if ($escaped) { $escaped = $false; continue }
        if ($character -eq '\\') { $escaped = $true; continue }
        if ($character -eq '"') { $insideString = $false }
        continue
      }
      if ($character -eq '"') { $insideString = $true; continue }
      if ($character -eq '{') { $depth++; continue }
      if ($character -eq '}') {
        $depth--
        if ($depth -eq 0) {
          $candidate = $text.Substring($start, $index - $start + 1)
          $parsed = Try-ConvertJson $candidate
          if ($null -eq $parsed) { $parsed = Try-ConvertJson (Normalize-JsonControls $candidate) }
          if ($null -ne $parsed) { return $parsed }
          break
        }
      }
    }
    $start++
  }

  $preview = $text.Substring(0, [Math]::Min(500, $text.Length))
  throw "无法解析 MCP 响应（前缀）：$preview"
}

function Invoke-Mcp {
  param([hashtable]$Payload)
  $headers = @{ Accept = "application/json, text/event-stream" }
  if ($sessionID) { $headers["Mcp-Session-Id"] = $sessionID }
  $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/litmtrans/mcp" -Method Post -Headers $headers -ContentType "application/json" -Body ($Payload | ConvertTo-Json -Depth 30 -Compress)
  $headerSession = @(
    [string]$response.Headers["Mcp-Session-Id"],
    [string]$response.Headers["MCP-Session-Id"],
    [string]$response.Headers["mcp-session-id"]
  ) | Where-Object { $_ } | Select-Object -First 1
  if ($headerSession) { $script:sessionID = $headerSession }
  return [pscustomobject]@{ Json = Convert-McpBody ([string]$response.Content); Body = [string]$response.Content }
}

function Wait-Mcp {
  param([int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = ""
  while ((Get-Date) -lt $deadline) {
    try {
      $result = Invoke-Mcp @{ jsonrpc = "2.0"; id = 1; method = "initialize"; params = @{ protocolVersion = "2025-11-25"; capabilities = @{}; clientInfo = @{ name = "litmtrans-mcp-acquisition-e2e"; version = "1" } } }
      if ($result.Json.result.protocolVersion) {
        Invoke-Mcp @{ jsonrpc = "2.0"; method = "notifications/initialized"; params = @{} } | Out-Null
        return
      }
      $lastError = "initialize 返回了无 protocolVersion 的响应"
    }
    catch { $lastError = $_.Exception.Message }
    Start-Sleep -Milliseconds 500
  }
  throw "LitMTrans MCP endpoint 未在限定时间内就绪：$Port；最后错误：$lastError"
}

function Get-Structured {
  param($Response)
  $value = $Response.Json.result.structuredContent
  if ($value -and $value.id -and $value.status) { return $value }
  if ($value -and $value.result -is [string]) { return $value.result | ConvertFrom-Json }
  if ($value -and $value.result -is [object] -and -not ($value -is [array])) { return $value.result }
  return $value
}

function Assert-PdfSignature {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  try {
    if ($stream.Length -lt 5) { throw "Zotero 附件文件长度不足：$Path" }
    $signature = New-Object byte[] 5
    [void]$stream.Read($signature, 0, $signature.Length)
    if ([BitConverter]::ToString($signature) -ne "25-50-44-46-2D") { throw "Zotero 附件没有有效 PDF 签名：$Path" }
  }
  finally { $stream.Dispose() }
}

function Invoke-Tool {
  param([string]$Name, [hashtable]$Arguments)
  $response = Invoke-Mcp @{ jsonrpc = "2.0"; id = (Get-Random -Minimum 100 -Maximum 999999); method = "tools/call"; params = @{ name = $Name; arguments = $Arguments } }
  if ($response.Json.error -or $response.Json.result.isError) { throw "MCP 工具失败：$Name`n$($response.Body)" }
  return Get-Structured $response
}

function Start-TestZotero {
  $args = @("-profile", $profilePath, "--dataDir", $dataPath, "-purgecaches", "-no-remote")
  $script:zoteroProcess = Start-Process -FilePath $testVersion.BinaryPath -ArgumentList $args -PassThru
  Wait-Mcp
  $script:zoteroProcess = Wait-IsolatedZoteroMainWindowProcess -ProfilePath $profilePath
}

$structuredJob = [pscustomobject]@{ id = "job-fixture"; status = "completed"; result = [pscustomobject]@{ runtime = @{ available = $true } } }
$structuredResult = Get-Structured ([pscustomobject]@{ Json = [pscustomobject]@{ result = [pscustomobject]@{ structuredContent = $structuredJob } } })
if ($structuredResult.status -ne "completed" -or -not $structuredResult.result.runtime.available) { throw "MCP structuredContent Job 解包回归失败" }

try {
  if (-not $Port) { $Port = Get-FreePort }
  Assert-ChildPath -Path $e2eRoot -Parent (Join-Path $projectRoot ".zotero-dev")
  if (Test-Path -LiteralPath $e2eRoot) {
    $staleZoteroPIDs = @(Get-IsolatedZoteroProcessIDs -ProfilePath $profilePath)
    $runtimeRoot = Join-Path $profilePath "litmtrans\runtime\acquisition"
    $staleManagedPIDs = @(Get-ManagedRuntimeProcesses -RuntimeRoot $runtimeRoot | ForEach-Object { [int]$_.ProcessId })
    if ($staleZoteroPIDs.Count -or $staleManagedPIDs.Count) {
      throw "发现上次 E2E 遗留进程；为避免在启动阶段强制终止，请先完成故障清理。Zotero PID=$($staleZoteroPIDs -join ',')；托管 runtime PID=$($staleManagedPIDs -join ',')"
    }
    Remove-Item -LiteralPath $e2eRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Path $profilePath,$dataPath -Force | Out-Null

  $testVersion = & (Join-Path $PSScriptRoot "prepare-zotero-test-version.ps1") -Major "10"
  $env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH = $testVersion.BinaryPath
  & (Join-Path $PSScriptRoot "prepare-dev-addon.ps1") -ZoteroVersion $testVersion.Version
  $manifest = Get-Content -LiteralPath (Join-Path $projectRoot "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $addonID = $manifest.applications.zotero.id
  $addonPath = Join-Path $profilePath "extensions\$addonID"
  New-Item -ItemType Directory -Path (Split-Path -Parent $addonPath) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot "dist\addon") -Destination $addonPath -Recurse -Force
  $prefs = @"
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.update.enabled", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.checkCompatibility", false);
user_pref("extensions.litmtrans.agentEnabled", true);
user_pref("extensions.litmtrans.agentAccessMode", "full");
user_pref("extensions.litmtrans.agentAllowConfiguredServices", true);
user_pref("extensions.litmtrans.agentPort", $Port);
user_pref("extensions.litmtrans.agentTestNetworkStub", false);
user_pref("extensions.litmtrans.agentTestShutdownProbe", true);
user_pref("extensions.litmtrans.agentTestShutdownProbeObserverReached", false);
user_pref("extensions.litmtrans.agentTestShutdownProbeMainWindowUnloadReached", false);
user_pref("extensions.litmtrans.agentTestShutdownProbeQuitStarted", false);
user_pref("extensions.litmtrans.agentTestShutdownProbeStopStarted", false);
user_pref("extensions.litmtrans.agentTestShutdownProbeAgentShutdownStarted", false);
user_pref("extensions.litmtrans.agentTestShutdownProbeAcquisitionShutdownCompleted", false);
user_pref("extensions.litmtrans.agentTestShutdownProbeControllerShutdownStarted", false);
user_pref("extensions.litmtrans.agentTestShutdownProbeControllerShutdownCompleted", false);
user_pref("extensions.litmtrans.agentTestShutdownProbeKillAttempts", 0);
user_pref("extensions.litmtrans.agentTestShutdownProbePID", 0);
user_pref("extensions.litmtrans.agentTestShutdownProbeKillReturned", false);
"@
Set-Content -LiteralPath (Join-Path $profilePath "user.js") -Value $prefs -Encoding UTF8

  Start-TestZotero
  $tools = Invoke-Mcp @{ jsonrpc = "2.0"; id = 2; method = "tools/list"; params = @{} }
  if ($tools.Json.error) { throw "真实插件 tools/list RPC 失败：$($tools.Json.error | ConvertTo-Json -Compress)" }
  $toolRows = @($tools.Json.result.tools)
  $toolNames = @($toolRows | ForEach-Object { $_.name })
  foreach ($required in @("litmtrans_literature_import", "litmtrans_acquire_papers", "litmtrans_fulltext_access")) {
    if ($toolNames -notcontains $required) {
      $capability = Invoke-Tool "litmtrans_get_capabilities" @{}
      $relevant = @($toolNames | Where-Object { $_ -match "literature|acquire|fulltext" }) -join ","
      $rawType = if ($tools.Json.result.tools) { $tools.Json.result.tools.GetType().FullName } else { "null" }
      throw "真实插件 tools/list 缺少 $required；toolCount=$($toolNames.Count)，rawType=$rawType，mode=$($capability.mode)，paperAcquisition=$($capability.toolsets.paperAcquisition)，相关工具=$relevant，JSON解析=$script:lastJsonError"
    }
  }

  $candidate = @{
    candidateID = $Identifier
    metadata = @{ title = $documentTitle; authors = @(); year = 2024 }
    identifiers = @{ arxiv = $Identifier }
    summary = @{ abstract = "" }
    local = @{ inZotero = $false; hasFullText = $false }
    discovery = @{ openAccess = $false }
  }
  $job = Invoke-Tool "litmtrans_literature_import" @{ candidates = @($candidate); acquireFullText = $true; parse = $false; attachToZotero = $true }
  if (-not $job.id -or $job.kind -ne "acquisition") { throw "全文导入没有返回 acquisition Job：$($job | ConvertTo-Json -Depth 10 -Compress)" }
  $jobID = [string]$job.id
  $deadline = (Get-Date).AddMinutes(15)
  $finished = $null
  while ((Get-Date) -lt $deadline) {
    $finished = Invoke-Tool "litmtrans_get_job" @{ jobID = $jobID }
    if (@("completed", "failed", "cancelled", "interrupted") -contains [string]$finished.status) { break }
    Start-Sleep -Seconds 2
  }
  if ($finished.status -ne "completed") { throw "全文获取 Job 未完成：$($finished | ConvertTo-Json -Depth 20 -Compress)" }
  if ($finished.result.runtime.available -ne $true) { throw "Job 未使用可用的托管运行时：$($finished.result.runtime | ConvertTo-Json -Depth 10 -Compress)" }
  if ($finished.result.runtime.state.target -ne "windows-x64") { throw "托管运行时 target 不正确：$($finished.result.runtime.state.target)" }
  $acquisition = $finished.result.acquisition
  if ([int]$acquisition.available -lt 1) { throw "全文获取 Job 完成但没有 available 结果：$($finished | ConvertTo-Json -Depth 20 -Compress)" }
  $documentRow = @($acquisition.results | Where-Object { $_.status -eq "available" } | Select-Object -First 1)
  if (-not $documentRow.item -or -not $documentRow.attachment) { throw "全文获取结果缺少 Zotero item/attachment：$($documentRow | ConvertTo-Json -Depth 20 -Compress)" }
  if ($documentRow.provider -ne "managed-scansci" -or $documentRow.validation.valid -ne $true) { throw "全文结果没有通过真实 ScanSci 与 PDF Validator：$($documentRow | ConvertTo-Json -Depth 10 -Compress)" }
  $generation = [string]$finished.result.runtime.state.generation
  if (-not $generation) { throw "托管运行时没有 generation 标识" }
  $attachmentKey = [string]$documentRow.attachment.attachmentKey
  $attachmentDirectory = Join-Path $dataPath "storage\$attachmentKey"
  if (-not $attachmentKey -or -not (Test-Path -LiteralPath $attachmentDirectory -PathType Container)) { throw "Zotero storage 中不存在附件目录：$attachmentKey" }
  $pdfFiles = @(Get-ChildItem -LiteralPath $attachmentDirectory -File -Filter *.pdf -ErrorAction SilentlyContinue)
  if (-not $pdfFiles.Count) { throw "Zotero storage 中未找到 PDF 附件：$attachmentDirectory" }
  Assert-PdfSignature -Path $pdfFiles[0].FullName
  $search = Invoke-Tool "litmtrans_search_items" @{ q = $documentTitle; includeAttachments = $true; limit = 20 }
  if (-not @($search.items).Count) { throw "重启前无法在 Zotero 中找到已导入条目" }
  $zoteroItemKey = [string]$documentRow.item.key
  if (-not $zoteroItemKey) { $zoteroItemKey = [string]$documentRow.item.itemKey }
  if (-not $zoteroItemKey) { $zoteroItemKey = [string]$documentRow.attachment.itemKey }
  if (-not $zoteroItemKey) { $zoteroItemKey = [string]@($search.items)[0].key }
  if (-not $zoteroItemKey) { throw "无法从 acquisition item、attachment 或 Zotero 搜索结果取得父条目 key" }
  $candidate.local.itemKey = $zoteroItemKey
  $candidate.local.libraryID = [int]$documentRow.item.libraryID
  $candidate.local.inZotero = $true
  $candidate.local.hasFullText = $false
  Write-Output "MCP acquisition clean-profile pass: job $jobID, ScanSci $($documentRow.provider), PDF valid, item $zoteroItemKey, attachment $attachmentKey"

  $runtimeRoot = Join-Path $profilePath "litmtrans\runtime\acquisition"
  $shutdownEvidence = Invoke-GracefulZoteroShutdown -Process $zoteroProcess -RuntimeRoot $runtimeRoot -ProfilePath $profilePath -RequireManagedProcess
  $zoteroProcess = $null
  Write-Output "Shutdown validation: $($shutdownEvidence.shutdownEvidence); tracked Zotero PID(s) $($shutdownEvidence.zoteroPIDs -join ','); observed managed PID(s) $($shutdownEvidence.managedPIDs -join ','); Zotero and all tracked children exited"

  $sessionID = ""
  Start-TestZotero
  $reused = Invoke-Tool "litmtrans_search_items" @{ q = $documentTitle; includeAttachments = $true; limit = 20 }
  if (-not @($reused.items).Count) { throw "重启后无法复用 Zotero 条目/附件" }
  $repeatJob = Invoke-Tool "litmtrans_acquire_papers" @{ candidates = @($candidate); attachToZotero = $true; parse = $false }
  if (-not $repeatJob.id) { throw "重启后全文获取没有返回 Job" }
  $repeatDeadline = (Get-Date).AddMinutes(3)
  $repeatFinished = $null
  while ((Get-Date) -lt $repeatDeadline) {
    $repeatFinished = Invoke-Tool "litmtrans_get_job" @{ jobID = [string]$repeatJob.id }
    if (@("completed", "failed", "cancelled", "interrupted") -contains [string]$repeatFinished.status) { break }
    Start-Sleep -Seconds 2
  }
  if ($repeatFinished.status -ne "completed") { throw "重启后的全文获取未完成：$($repeatFinished | ConvertTo-Json -Depth 16 -Compress)" }
  if ($repeatFinished.result.runtime.reused -ne $true) { throw "重启后未复用托管运行时：$($repeatFinished.result.runtime | ConvertTo-Json -Depth 10 -Compress)" }
  if ([string]$repeatFinished.result.runtime.state.generation -ne $generation) { throw "重启后托管运行时 generation 发生变化，可能重复安装" }
  $repeatRow = @($repeatFinished.result.acquisition.results | Select-Object -First 1)
  if ($repeatRow.reused -ne $true -or [string]$repeatRow.attachment.key -ne $attachmentKey) { throw "重启后未复用原有 PDF 附件：$($repeatRow | ConvertTo-Json -Depth 10 -Compress)" }
  Write-Output "MCP acquisition restart/reuse pass: matched $(@($reused.items).Count) Zotero row(s), runtime reused, generation $generation"
  $shutdownEvidence = Invoke-GracefulZoteroShutdown -Process $zoteroProcess -RuntimeRoot $runtimeRoot -ProfilePath $profilePath
  $zoteroProcess = $null
  Write-Output "Final shutdown validation: $($shutdownEvidence.shutdownEvidence); tracked Zotero PID(s) $($shutdownEvidence.zoteroPIDs -join ','); Zotero and all tracked children exited"
}
finally {
  if (Test-Path -LiteralPath $e2eRoot) {
    Assert-ChildPath -Path $e2eRoot -Parent (Join-Path $projectRoot ".zotero-dev")
    $profileRoot = [IO.Path]::GetFullPath($profilePath)
    $profileProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" -ErrorAction SilentlyContinue | Where-Object {
      ([string]$_.CommandLine).IndexOf($profileRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($profileProcesses.Count) { Write-Output "test-cleanup validated: stopping leftover Zotero PID(s) after E2E failure/interruption: $($profileProcesses.ProcessId -join ',')" }
    foreach ($process in $profileProcesses) { Stop-Tree -ProcessId ([int]$process.ProcessId) }
    $runtimeRoot = Join-Path $profilePath "litmtrans\runtime\acquisition"
    $managedProcesses = @(Get-ManagedRuntimeProcesses -RuntimeRoot $runtimeRoot)
    if ($managedProcesses.Count) { Write-Output "test-cleanup validated: stopping leftover managed PID(s) after E2E failure/interruption: $($managedProcesses.ProcessId -join ',')" }
    foreach ($process in $managedProcesses) { Stop-Tree -ProcessId ([int]$process.ProcessId) }
    Stop-IsolatedZoteroProcessTrees -ProfilePath $profilePath
    $cleanupDeadline = (Get-Date).AddSeconds(15)
    do {
      $managedProcesses = @(Get-ManagedRuntimeProcesses -RuntimeRoot $runtimeRoot)
      if (-not $managedProcesses.Count) { break }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $cleanupDeadline)
    if ($managedProcesses.Count) { throw "未能清理隔离 runtime 子进程：$($managedProcesses.ProcessId -join ',')" }
    Remove-Item -LiteralPath $e2eRoot -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $e2eRoot) { throw "未能删除隔离 E2E 根目录：$e2eRoot" }
  }
}
