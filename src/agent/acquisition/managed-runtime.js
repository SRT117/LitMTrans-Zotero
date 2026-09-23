(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const RUNTIME_PREFLIGHT_TOKEN = Symbol("LitMTrans.Agent.RuntimePreflight");
  Agent.RuntimePreflightToken = RUNTIME_PREFLIGHT_TOKEN;

  const CONTROL_TIMEOUT_MS = 15000;
  const DOWNLOAD_TIMEOUT_MS = 180000;
  const PACKAGE_INSTALL_PROCESS_TIMEOUT_MS = 12 * 60 * 1000;
  const HEALTH_TTL_MS = 45000;

  function joinPath(...parts) {
    try { return global.PathUtils?.join?.(...parts) || parts.filter(Boolean).join("/"); }
    catch (_) { return parts.filter(Boolean).join("/"); }
  }

  function abort(signal) {
    if (signal?.aborted) throw new Error("运行时安装已取消");
  }

  function fileName(path) {
    try { return global.PathUtils?.filename?.(path) || String(path || "").split(/[\\/]/).pop(); }
    catch (_) { return String(path || "").split(/[\\/]/).pop(); }
  }

  async function downloadAsset(url, destination, storage, expectedHash, options = {}) {
    abort(options.signal);
    const bytes = await LitMTrans.HTTP.requestBytes(url, { timeout: Number(options.timeoutMs || DOWNLOAD_TIMEOUT_MS), signal: options.signal });
    const maxBytes = Number(options.maxBytes || 512 * 1024 * 1024);
    if (bytes.length > maxBytes) throw new Error(`运行时安装包超过大小限制：${bytes.length}`);
    const actualHash = await LitMTrans.Utils.sha256Bytes(bytes);
    if (expectedHash && actualHash.toLowerCase() !== String(expectedHash).toLowerCase()) throw new Error(`SHA-256 校验失败：${fileName(url)}`);
    await storage.writeBytes(destination, bytes);
    return { destination, size: bytes.length, sha256: actualHash };
  }

  async function downloadAssetFromSources(sources, destination, storage, expectedHash, options = {}) {
    let lastError = null;
    for (const source of Array.isArray(sources) ? sources : [sources]) {
      const url = String(source || "").trim();
      if (!url) continue;
      try { return await downloadAsset(url, destination, storage, expectedHash, options); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("没有可用的运行时镜像");
  }

  async function extractZip(storage, archivePath, destination) {
    await storage.remove?.(destination, true);
    await storage.ensureDir(destination);
    const factory = global.Cc?.["@mozilla.org/libjar/zip-reader;1"];
    if (!factory || !global.Ci?.nsIZipReader) throw new Error("当前 Zotero 运行时缺少 ZIP 解压组件");
    const reader = factory.createInstance(global.Ci.nsIZipReader);
    reader.open(LitMTrans.Utils.createLocalFile(archivePath));
    try {
      const entries = reader.findEntries(null);
      while (entries.hasMore()) {
        const rawName = String(entries.getNext());
        const normalized = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
        const parts = normalized.split("/").filter(Boolean);
        if (!parts.length || parts.some(part => part === ".." || part.includes(":"))) continue;
        const target = global.PathUtils.join(destination, ...parts);
        if (rawName.endsWith("/")) await storage.ensureDir(target);
        else {
          await storage.ensureDir(global.PathUtils.parent(target));
          reader.extract(rawName, LitMTrans.Utils.createLocalFile(target));
        }
      }
    }
    finally { reader.close(); }
    return destination;
  }

  async function runProcess(executable, args = [], options = {}) {
    const factory = global.Cc?.["@mozilla.org/process/util;1"];
    if (!factory || !global.Ci?.nsIProcess) throw new Error("当前 Zotero 运行时缺少进程启动组件");
    const process = factory.createInstance(global.Ci.nsIProcess);
    process.init(LitMTrans.Utils.createLocalFile(executable));
    return new Promise((resolve, reject) => {
      let settled = false;
      let cancel = null;
        let timeoutHandle = null;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
          if (timeoutHandle !== null) global.clearTimeout(timeoutHandle);
        if (cancel && typeof options.signal?.removeEventListener === "function") options.signal.removeEventListener("abort", cancel);
        error ? reject(error) : resolve(result);
      };
      const observer = {
        observe(_subject, topic, data) {
          if (topic === "process-failed") return finish(new Error(`运行时进程异常结束（状态：${data || process.exitValue || "unknown"}）：${fileName(executable)}`));
          if (topic === "process-finished") return finish(null, { exitCode: Number(process.exitValue || 0), process });
        }
      };
      try { process.runAsync(args, args.length, observer); }
      catch (error) { finish(error); }
        const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
        if (!settled && timeoutMs > 0) {
          timeoutHandle = global.setTimeout(() => {
            try { process.kill(); } catch (_) {}
            finish(new Error(`运行时进程执行超时（${timeoutMs} 毫秒）：${fileName(executable)}`));
          }, timeoutMs);
        }
        if (options.signal && !settled) {
        cancel = () => { try { process.kill(); } catch (_) {} finish(new Error("运行时安装已取消")); };
        if (options.signal.aborted) cancel();
        else if (typeof options.signal.addEventListener === "function") options.signal.addEventListener("abort", cancel, { once: true });
      }
    });
  }

  async function configurePythonPath(storage, pythonRoot) {
    const entries = await storage.list?.(pythonRoot) || [];
    const pth = entries.find(path => /python[^/\\]*_pth$/i.test(fileName(path)));
    if (!pth) return;
    const current = await storage.readText(pth, "");
    const lines = current.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.some(line => /^lib[\\/]site-packages$/i.test(line))) lines.push("Lib\\site-packages");
    if (!lines.some(line => /^import\s+site$/i.test(line))) lines.push("import site");
    await storage.writeText(pth, `${lines.join("\n")}\n`);
  }

  function parseVersion(value) {
    const text = String(value || "0").trim().replace(/^v/i, "");
    const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.([0-9]+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
    if (!match) return { numbers: [0, 0, 0, 0], prerelease: null };
    return {
      numbers: [1, 2, 3, 4].map(index => Number.parseInt(match[index] || "0", 10) || 0),
      prerelease: match[5] ? match[5].split(".") : null
    };
  }

  function comparePrerelease(left, right) {
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
      if (index >= left.length) return -1;
      if (index >= right.length) return 1;
      const a = left[index];
      const b = right[index];
      if (a === b) continue;
      const aNumber = /^\d+$/.test(a);
      const bNumber = /^\d+$/.test(b);
      if (aNumber && bNumber) return Number(a) - Number(b);
      if (aNumber !== bNumber) return aNumber ? -1 : 1;
      return a < b ? -1 : 1;
    }
    return 0;
  }

  function versionParts(value) { return parseVersion(value).numbers; }

  function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index++) {
      const delta = (a.numbers[index] || 0) - (b.numbers[index] || 0);
      if (delta) return delta;
    }
    return comparePrerelease(a.prerelease, b.prerelease);
  }

  function isSupportedScanSciVersion(value, manifest) {
    const scansci = manifest?.scansci || {};
    if (!value || !scansci.minVersion) return false;
    if (compareVersions(value, scansci.minVersion) < 0) return false;
    if (scansci.maxTestedVersion && compareVersions(value, scansci.maxTestedVersion) > 0) return false;
    return true;
  }

  function pythonProbeCode(probePath) {
    return [
      "import importlib.metadata as metadata",
      "import json",
      "import pathlib",
      "import sys",
      "import pymupdf",
      "import scansci_pdf",
      "import mcp",
      "from scansci_pdf._core import _check_availability",
      "core_modules = _check_availability()",
      "native_count = sum(1 for available in core_modules.values() if available)",
      "performance_backend = ('scansci-native-core' if native_count == len(core_modules) and native_count else ('scansci-hybrid-core' if native_count else 'scansci-python-fallback'))",
      `payload = {"pythonVersion": sys.version.split()[0], "scansciVersion": metadata.version("scansci-pdf"), "mcpVersion": metadata.version("mcp"), "scansciModule": str(getattr(scansci_pdf, "__file__", "")), "pymupdfVersion": metadata.version("pymupdf"), "performanceBackend": performance_backend, "nativeCoreModules": core_modules}`,
      `pathlib.Path(${JSON.stringify(String(probePath))}).write_text(json.dumps(payload), encoding="utf-8")`
    ].join("; ");
  }

  function pythonConfigForTarget(manifest, targetConfig = {}) {
    const sources = Array.isArray(targetConfig.sources) ? targetConfig.sources : [];
    const pythonSource = sources.find(source => String(source?.type || "") === "python-runtime");
    const defaultPython = targetConfig.runtimeInstallStrategy === "uv-managed-python"
      ? {}
      : (manifest.python?.[targetConfig.os] || manifest.python?.windows || {});
    const python = {
      ...defaultPython,
      ...(targetConfig.python || {}),
      pip: targetConfig.pip || targetConfig.python?.pip || manifest.python?.pip || {}
    };
    if (pythonSource) {
      python.archiveURL = pythonSource.url;
      python.archiveSHA256 = pythonSource.sha256;
      python.mirrors = sources.filter(source => source !== pythonSource && String(source?.type || "") === "python-runtime").map(source => source.url);
      python.executable = targetConfig.executable || python.executable || "python.exe";
    }
    return python;
  }

  function rebaseRuntimePath(sourceRoot, targetRoot, path) {
    const source = String(sourceRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const value = String(path || "").replace(/\\/g, "/");
    if (!source || !value) throw new Error("托管运行时路径为空，无法从 staging 转移到正式目录");
    const sourceLower = source.toLowerCase();
    const valueLower = value.toLowerCase();
    if (valueLower === sourceLower) return String(targetRoot || "");
    if (!valueLower.startsWith(`${sourceLower}/`)) throw new Error("托管运行时可执行文件或包目录越出 staging 边界");
    const relative = value.slice(source.length).replace(/^\/+/, "");
    return joinPath(targetRoot, ...relative.split("/"));
  }

  async function readJSON(storage, path) {
    if (typeof storage?.readJSON === "function") return storage.readJSON(path, null);
    try { return JSON.parse(await storage.readText(path, "")); } catch (_) { return null; }
  }

  async function verifyRuntimeHealth(state, manifest, storage, options = {}) {
    const executable = String(state?.executable || "");
    if (!executable || typeof storage?.exists !== "function" || !await storage.exists(executable)) return false;
    const probePath = joinPath(String(state.root || ""), `.health-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    try {
      const result = await runProcess(executable, ["-c", pythonProbeCode(probePath)], { signal: options.signal });
      if (result.exitCode !== 0) return false;
      const probe = await readJSON(storage, probePath);
      if (!probe?.pythonVersion || !probe?.scansciVersion || !probe?.mcpVersion) return false;
      if (!isSupportedScanSciVersion(probe.scansciVersion, manifest)) return false;
      if (options.expectedPythonVersion && String(probe.pythonVersion) !== String(options.expectedPythonVersion)) return false;
      if (probe.performanceBackend) state.performanceBackend = String(probe.performanceBackend);
      if (probe.nativeCoreModules && typeof probe.nativeCoreModules === "object") state.nativeCoreModules = probe.nativeCoreModules;
      return true;
    }
    catch (_) { return false; }
    finally { try { await storage.remove?.(probePath, false); } catch (_) {} }
  }

  async function moveRuntimeDirectoryWithRetry(source, destination, storage, options = {}) {
    const move = options.move || ((from, to, moveOptions) => global.IOUtils.move(from, to, moveOptions));
    const retryDelays = Array.isArray(options.retryDelays) ? options.retryDelays : [150, 300, 600, 1200];
    let lastError = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      const [sourceExists, destinationExists] = await Promise.all([storage.exists(source), storage.exists(destination)]);
      if (!sourceExists && destinationExists) return;
      if (destinationExists) throw new Error(`托管运行时正式目录已存在，拒绝覆盖：${destination}`);
      if (!sourceExists) throw lastError || new Error(`托管运行时 staging 目录不存在：${source}`);
      try {
        await move(source, destination, { noOverwrite: true });
        return;
      }
      catch (error) {
        lastError = error;
        if (attempt >= retryDelays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(retryDelays[attempt]) || 0)));
      }
    }
    if (lastError) throw lastError;
  }

  async function installManagedRuntime(storage, options = {}) {
    const manifest = Agent.AcquisitionRuntimeManifest.manifest(options.manifest);
    const root = String(options.root || joinPath(storage?.root || "", "runtime", "acquisition"));
    const platform = options.platformDescriptor || Agent.PlatformDescriptor?.detect?.({ os: options.platform }) || { target: "unknown", supported: false, reason: "platform-descriptor-unavailable" };
    const adapter = Agent.createRuntimeAdapter?.(platform, manifest);
    if (!adapter?.supported) throw new Error(`当前平台没有可用的托管文献获取运行时：${platform.target || "unknown"}`);
    const targetConfig = manifest.targets?.[platform.target] || {};
    const parent = global.PathUtils.parent(root);
    const generation = `generation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const staging = joinPath(parent, `.acquisition-staging-${generation}`);
    await adapter.prepare(storage, staging);
    await storage.ensureDir(staging);
    try {
      const python = pythonConfigForTarget(manifest, targetConfig);
      const runtimePaths = await adapter.installPython({
        storage,
        staging,
        manifest,
        targetConfig,
        python,
        downloadAssetFromSources,
        extractZip,
        configurePythonPath,
        runProcess,
        readJSON,
        signal: options.signal,
        downloadTimeoutMs: Number(options.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS),
        pythonInstallProcessTimeoutMs: Number(options.pythonInstallProcessTimeoutMs || 600000)
      });
      const executable = runtimePaths?.executable || "";
      const packageRoot = runtimePaths?.packageRoot || "";
      if (!executable || !packageRoot || !await storage.exists(executable)) throw new Error("托管 Python 适配器没有返回有效解释器或 site-packages 路径");
      await storage.ensureDir(packageRoot);
      const wheelPath = joinPath(staging, "scansci-pdf.whl");
      let installed;
        const attemptedIndexes = new Set();
        const installErrors = [];
        const indexSources = manifest.scansci.packageIndexSources || [];
        const firstIndexURL = indexSources[0] || "https://pypi.org/simple";
        const pipOptions = ["--disable-pip-version-check", "--timeout", "30", "--retries", "1"];
      try {
        await downloadAssetFromSources([
            manifest.scansci.wheelURL,
            ...(manifest.scansci.wheelMirrors || [])
        ], wheelPath, storage, manifest.scansci.wheelSHA256, {
          signal: options.signal,
          timeoutMs: Number(options.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS),
          maxBytes: 64 * 1024 * 1024
        });
          attemptedIndexes.add(firstIndexURL);
          installed = await runProcess(executable, ["-m", "pip", "install", "--target", packageRoot, "--upgrade", "--no-cache-dir", ...pipOptions, wheelPath, "--index-url", firstIndexURL, "--only-binary=:all:"], {
            signal: options.signal,
            timeoutMs: Number(options.packageInstallProcessTimeoutMs || PACKAGE_INSTALL_PROCESS_TIMEOUT_MS)
          });
          if (installed.exitCode !== 0) installErrors.push(`${firstIndexURL}：pip 退出码 ${installed.exitCode}`);
      }
      catch (error) {
        if (options.signal?.aborted) throw error;
          installErrors.push(`${firstIndexURL}：${String(error?.message || error)}`);
        installed = { exitCode: 1 };
      }
      if (!installed || installed.exitCode !== 0) {
          for (const indexURL of indexSources) {
            if (attemptedIndexes.has(indexURL)) continue;
            attemptedIndexes.add(indexURL);
            try {
              installed = await runProcess(executable, ["-m", "pip", "install", "--target", packageRoot, "--upgrade", "--no-cache-dir", ...pipOptions, `${manifest.scansci.package}==${manifest.scansci.recommendedVersion}`, "--index-url", indexURL, "--only-binary=:all:"], {
                signal: options.signal,
                timeoutMs: Number(options.packageInstallProcessTimeoutMs || PACKAGE_INSTALL_PROCESS_TIMEOUT_MS)
              });
            }
            catch (error) {
              if (options.signal?.aborted) throw error;
              installErrors.push(`${indexURL}：${String(error?.message || error)}`);
              installed = { exitCode: 1 };
              continue;
            }
          if (installed.exitCode === 0) break;
            installErrors.push(`${indexURL}：pip 退出码 ${installed.exitCode}`);
        }
      }
        if (!installed || installed.exitCode !== 0) throw new Error(`ScanSci 依赖安装失败：${installErrors.join("；") || `退出码 ${installed?.exitCode ?? "unknown"}`}`);
      const probePath = joinPath(staging, "runtime-probe.json");
      const probe = await runProcess(executable, ["-c", pythonProbeCode(probePath)], { signal: options.signal });
      if (probe.exitCode !== 0) throw new Error(`ScanSci 运行时健康检查失败（退出码 ${probe.exitCode}）`);
      const versions = await readJSON(storage, probePath);
      if (!versions?.scansciVersion || !versions?.mcpVersion || !isSupportedScanSciVersion(versions.scansciVersion, manifest)) {
        throw new Error(`ScanSci 运行时版本不符合清单：${versions?.scansciVersion || "unknown"}`);
      }
      if (!versions?.pythonVersion || (targetConfig.pythonVersion && String(versions.pythonVersion) !== String(targetConfig.pythonVersion))) {
        throw new Error(`托管 Python 版本不符合清单：${versions?.pythonVersion || "unknown"}`);
      }
      await storage.remove?.(probePath, false);
      await storage.ensureDir(parent);
      const backup = `${root}.last-known-good`;
      if (typeof options.promote === "function") await options.promote({ staging, root, backup, storage, generation });
      else {
        if (await storage.exists(root)) {
          await storage.remove?.(backup, true);
          await global.IOUtils.move(root, backup, { noOverwrite: true });
        }
        try { await moveRuntimeDirectoryWithRetry(staging, root, storage); }
        catch (error) {
          if (await storage.exists(backup)) {
            await storage.remove?.(root, true);
            await global.IOUtils.move(backup, root, { noOverwrite: true });
          }
          throw error;
        }
      }
      const finalExecutable = rebaseRuntimePath(staging, root, executable);
      const finalPackageRoot = rebaseRuntimePath(staging, root, packageRoot);
      return {
        available: true,
        version: manifest.scansci.recommendedVersion,
        runtimeVersion: targetConfig.runtimeVersion || manifest.acquisitionRuntimeVersion,
        target: platform.target,
        os: platform.os,
        arch: platform.arch,
        abi: platform.abi,
        pythonVersion: versions.pythonVersion,
        scansciVersion: versions.scansciVersion,
        mcpVersion: versions.mcpVersion,
        performanceBackend: versions.performanceBackend || "unknown",
        nativeCoreModules: versions.nativeCoreModules || {},
        source: targetConfig.runtimeInstallStrategy === "uv-managed-python"
          ? `uv-${targetConfig.uv?.version || "managed"}+python-build-standalone+scansci-pypi`
          : "managed-python-embed+pip-wheel+scansci-pypi",
        backendCapability: "scansci-mcp",
        executable: finalExecutable,
        packageRoot: finalPackageRoot,
        root,
        generation,
        rollbackRoot: backup,
        runtimeAdapter: { ...adapter.diagnostics(), executablePath: finalExecutable, packageRoot: finalPackageRoot }
      };
    }
    catch (error) {
      try { await storage.remove?.(staging, true); } catch (_) {}
      throw error;
    }
  }

  class ManagedRuntimeManager {
    constructor(storage, options = {}) {
      this.storage = storage;
      this.root = options.root || joinPath(storage?.root || "", "runtime", "acquisition");
      this.statePath = joinPath(this.root, "state.json");
      this.manifest = Agent.AcquisitionRuntimeManifest.manifest(options.manifest);
      this.platform = options.platformDescriptor || Agent.PlatformDescriptor?.detect?.(options.platformOptions || {}) || { target: "unknown", os: "unknown", arch: "unknown", abi: "unknown", supported: false, reason: "platform-descriptor-unavailable" };
      this.targetManifest = this.manifest.targets?.[this.platform.target] || null;
      this.healthTTL = Math.max(1000, Number(options.healthTTLms || HEALTH_TTL_MS) || HEALTH_TTL_MS);
      this.state = {
        schemaVersion: 2,
        status: "not-installed",
        version: "",
        target: this.platform.target,
        os: this.platform.os,
        arch: this.platform.arch,
        abi: this.platform.abi,
        runtimeVersion: "",
        pythonVersion: "",
        scansciVersion: "",
        mcpVersion: "",
        backendCapability: "unavailable",
        performanceBackend: "unknown",
        nativeCoreModules: {},
        source: "",
        root: this.root,
        executable: "",
        packageRoot: "",
        generation: "",
        rollbackRoot: "",
        healthResult: null,
        healthCheckedAt: 0,
        lastHealthCheck: "",
        updatedAt: ""
      };
      this.bootstrap = options.bootstrap || null;
      this.healthCheck = options.healthCheck || null;
      this.downloader = options.downloader || null;
      this.installer = options.installer || null;
      this.initialized = false;
      this.initPromise = null;
      this.ensurePromise = null;
    }

    expectedRuntimeVersion() {
      return String(this.targetManifest?.runtimeVersion || this.manifest.acquisitionRuntimeVersion || "");
    }

    async init() {
      if (this.initialized) return this.state;
      if (this.initPromise) return this.initPromise;
      this.initPromise = (async () => {
        const saved = await this.storage?.readJSON?.(this.statePath, null);
        if (saved && typeof saved === "object") this.state = { ...this.state, ...saved };
        this.state.target = String(this.state.target || "");
        if (this.state.target !== this.platform.target || this.state.runtimeVersion !== this.expectedRuntimeVersion()) {
          this.state.healthResult = null;
          this.state.healthCheckedAt = 0;
          this.state.lastHealthCheck = "";
        }
        this.initialized = true;
        return this.state;
      })().finally(() => { this.initPromise = null; });
      return this.initPromise;
    }

    async persist() {
      this.state.updatedAt = new Date().toISOString();
      await this.storage?.ensureDir?.(this.root);
      await this.storage?.writeJSON?.(this.statePath, this.state);
      return this.state;
    }

    invalidateHealth(reason = "manual") {
      this.state.healthResult = null;
      this.state.healthCheckedAt = 0;
      this.state.lastHealthCheck = String(reason || "manual");
      return this.state;
    }

    async awaitWithSignal(promise, signal) {
      abort(signal);
      if (!signal?.addEventListener) return promise;
      return new Promise((resolve, reject) => {
        let settled = false;
        const cancel = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", cancel);
          try { reject(new Error("运行时准备已取消")); } catch (_) {}
        };
        signal.addEventListener("abort", cancel, { once: true });
        Promise.resolve(promise).then(value => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", cancel);
          resolve(value);
        }, error => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", cancel);
          reject(error);
        });
      });
    }

    async isHealthy(options = {}) {
      await this.init();
      const expectedRuntimeVersion = this.expectedRuntimeVersion();
      if (this.state.status !== "installed" || !this.state.version) return false;
      if (this.state.target !== this.platform.target) return false;
      if (!options.ignoreRuntimeVersion && expectedRuntimeVersion && this.state.runtimeVersion !== expectedRuntimeVersion) return false;
      const checkedAt = Number(this.state.healthCheckedAt || 0);
      if (!options.forceHealth && this.state.healthResult !== null && checkedAt > 0 && Date.now() - checkedAt < this.healthTTL) return this.state.healthResult === true;
      let healthy = false;
      try {
        healthy = typeof this.healthCheck === "function"
          ? Boolean(await this.healthCheck(this.state, options))
          : await verifyRuntimeHealth(this.state, this.manifest, this.storage, { ...options, expectedPythonVersion: options.expectedPythonVersion });
      }
      catch (_) { healthy = false; }
      this.state.healthResult = healthy;
      this.state.healthCheckedAt = Date.now();
      this.state.lastHealthCheck = new Date(this.state.healthCheckedAt).toISOString();
      return healthy;
    }

    async _ensure(options = {}) {
      await this.init();
      if (!options.force && await this.isHealthy(options)) return { available: true, reused: true, state: { ...this.state }, manifest: this.manifest };
      const hasInjectedInstaller = typeof this.bootstrap === "function" || typeof this.downloader === "function" || typeof this.installer === "function";
      if (!hasInjectedInstaller && !this.platform.supported) {
        const diagnostics = `${this.platform.reason || "unsupported-platform"}: ${this.platform.target || "unknown"}`;
        this.state = { ...this.state, status: "unavailable", backendCapability: "unavailable", lastError: diagnostics };
        await this.persist();
        return { available: false, reused: false, reason: "MANAGED_RUNTIME_UNAVAILABLE", diagnostics, state: { ...this.state }, manifest: this.manifest, platform: this.platform };
      }
      if (typeof options.onProgress === "function") options.onProgress({ phase: "prepare", message: "正在准备文献获取服务，仅首次需要……" });
      const previous = { ...this.state };
      const previousHealthy = previous.status === "installed"
        ? await this.isHealthy({ ...options, forceHealth: true, ignoreRuntimeVersion: true })
        : false;
      try {
        let result = null;
        if (typeof this.bootstrap === "function") result = await this.bootstrap({ manifest: this.manifest, target: this.platform.target, platform: this.platform, root: this.root, signal: options.signal, onProgress: options.onProgress });
        else if (typeof this.downloader === "function") result = await this.downloader({ manifest: this.manifest, target: this.platform.target, platform: this.platform, root: this.root, signal: options.signal, onProgress: options.onProgress });
        else if (typeof this.installer === "function") result = await this.installer({ manifest: this.manifest, target: this.platform.target, platform: this.platform, root: this.root, storage: this.storage, signal: options.signal, onProgress: options.onProgress });
        else result = await installManagedRuntime(this.storage, { manifest: this.manifest, platformDescriptor: this.platform, root: this.root, signal: options.signal, promote: options.promote, downloadTimeoutMs: options.downloadTimeoutMs, pythonInstallProcessTimeoutMs: options.pythonInstallProcessTimeoutMs });
        if (!result?.available && !result?.version) throw new Error("当前没有可访问的文献获取运行时分发源");
        this.state = {
          ...this.state,
           status: "installed",
           version: String(result.version || this.manifest.acquisitionRuntimeVersion),
           runtimeVersion: String(result.runtimeVersion || this.expectedRuntimeVersion()),
           target: String(result.target || this.platform.target),
           os: String(result.os || this.platform.os || ""),
           arch: String(result.arch || this.platform.arch || ""),
           abi: String(result.abi || this.platform.abi || ""),
           pythonVersion: String(result.pythonVersion || ""),
           scansciVersion: String(result.scansciVersion || result.version || ""),
           mcpVersion: String(result.mcpVersion || ""),
          backendCapability: String(result.backendCapability || "managed-runtime"),
          performanceBackend: String(result.performanceBackend || "unknown"),
          nativeCoreModules: result.nativeCoreModules && typeof result.nativeCoreModules === "object" ? result.nativeCoreModules : {},
          source: String(result.source || "managed-bootstrap"),
          executable: String(result.executable || ""),
          packageRoot: String(result.packageRoot || ""),
           root: String(result.root || this.root),
           generation: String(result.generation || ""),
           rollbackRoot: String(result.rollbackRoot || ""),
           runtimeAdapter: result.runtimeAdapter || null,
           lastError: "",
           healthResult: true,
           healthCheckedAt: Date.now(),
           lastHealthCheck: new Date().toISOString()
        };
        await this.persist();
        return { available: true, reused: false, state: { ...this.state }, manifest: this.manifest };
      }
      catch (error) {
        const diagnostics = String(error?.message || error);
        if (previousHealthy) {
          this.state = { ...previous, status: "installed", lastError: diagnostics, healthResult: true, healthCheckedAt: Date.now(), lastHealthCheck: new Date().toISOString() };
          await this.persist();
          return { available: true, reused: true, updateDeferred: true, rolledBack: true, reason: "runtime update deferred", diagnostics, state: { ...this.state }, manifest: this.manifest };
        }
        this.state = previous.status === "installed"
          ? { ...previous, lastError: diagnostics, healthResult: false, healthCheckedAt: Date.now(), lastHealthCheck: new Date().toISOString() }
          : { ...this.state, status: "unavailable", lastError: diagnostics, healthResult: false, healthCheckedAt: Date.now(), lastHealthCheck: new Date().toISOString() };
        await this.persist();
        return { available: false, reused: false, rolledBack: previous.status === "installed", reason: "acquisition unavailable", diagnostics, state: { ...this.state }, manifest: this.manifest };
      }
    }

    async ensure(options = {}) {
      if (this.ensurePromise) return this.awaitWithSignal(this.ensurePromise, options.signal);
      const run = Promise.resolve().then(() => this._ensure(options));
      let shared = null;
      shared = run.finally(() => {
        if (this.ensurePromise === shared) this.ensurePromise = null;
      });
      this.ensurePromise = shared;
      return this.awaitWithSignal(shared, options.signal);
    }

    async update(options = {}) {
      return this.ensure({ ...options, force: true });
    }

    diagnostics() {
      return {
        root: this.root,
        platform: this.platform,
        targetManifest: this.targetManifest,
        state: this.state,
        manifest: this.manifest,
        health: { result: this.state.healthResult, checkedAt: this.state.healthCheckedAt, lastHealthCheck: this.state.lastHealthCheck, ttlMs: this.healthTTL },
        installing: Boolean(this.ensurePromise),
        lastKnownGood: this.state.status === "installed" ? { version: this.state.version, generation: this.state.generation } : null
      };
    }
  }

  Agent.ManagedRuntimeManager = ManagedRuntimeManager;
  Agent.ManagedRuntimeInternals = { downloadAsset, downloadAssetFromSources, extractZip, runProcess, installManagedRuntime, moveRuntimeDirectoryWithRetry, compareVersions, versionParts, pythonConfigForTarget, rebaseRuntimePath, CONTROL_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, PACKAGE_INSTALL_PROCESS_TIMEOUT_MS, HEALTH_TTL_MS, verifyRuntimeHealth };
})(this);
