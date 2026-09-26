(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function joinPath(...parts) {
    try { return global.PathUtils?.join?.(...parts) || parts.filter(Boolean).join("/"); }
    catch (_) { return parts.filter(Boolean).join("/"); }
  }

  function leafName(path) { return String(path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || ""; }

  function containedPath(root, candidate) {
    const parent = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const child = String(candidate || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return Boolean(parent && child && (child === parent || child.startsWith(`${parent}/`)));
  }

  function pythonPathProbeCode(probePath) {
    return [
      "import json, pathlib, sys, sysconfig",
      `pathlib.Path(${JSON.stringify(String(probePath))}).write_text(json.dumps({"pythonVersion": sys.version.split()[0], "executable": sys.executable, "prefix": sys.prefix, "packageRoot": sysconfig.get_paths()["purelib"]}), encoding="utf-8")`
    ].join("; ");
  }

  class RuntimeAdapter {
    constructor(platform, config = {}) {
      this.platform = platform || Agent.PlatformDescriptor?.detect?.() || { target: "unknown", supported: false };
      this.config = config || {};
      this.target = String(this.platform.target || "unknown");
      this.supported = this.config.status === "supported" || this.config.status === "field-validated";
    }

    paths(root) {
      const runtimeRoot = String(root || "");
      const pythonRoot = joinPath(runtimeRoot, String(this.config.pythonInstallDir || "python"));
      return {
        runtimeRoot,
        pythonRoot,
        executable: this.config.executablePath ? joinPath(runtimeRoot, String(this.config.executablePath)) : "",
        packageRoot: this.config.packageRoot ? joinPath(runtimeRoot, String(this.config.packageRoot), String(this.config.packageRootSubdir || "site-packages")) : ""
      };
    }

    async prepare(storage, staging) {
      await storage?.ensureDir?.(staging);
      return this.paths(staging);
    }

    async installPython() { throw new Error(`当前平台没有可用的 Python 安装适配器：${this.target}`); }

    async installPackages() { return { supported: this.supported }; }

    async probe() { return { supported: this.supported, target: this.target }; }

    async ensureExecutablePermissions() { return true; }

    diagnostics() {
      return {
        target: this.target,
        supported: this.supported,
        status: String(this.config.status || "unknown"),
        provider: String(this.config.provider || ""),
        runtimeVersion: String(this.config.runtimeVersion || ""),
        packageRoot: String(this.config.packageRoot || ""),
        executablePath: String(this.config.executablePath || "")
      };
    }
  }

  class WindowsX64RuntimeAdapter extends RuntimeAdapter {
    constructor(platform, config = {}) {
      super(platform, config);
      this.supported = this.target === "windows-x64";
    }

    paths(root) {
      const runtimeRoot = String(root || "");
      const pythonRoot = joinPath(runtimeRoot, "python");
      return {
        runtimeRoot,
        pythonRoot,
        executable: joinPath(pythonRoot, this.config.executable || "python.exe"),
        packageRoot: joinPath(pythonRoot, this.config.packageRoot || "Lib", "site-packages")
      };
    }

    async installPython(context = {}) {
      const { storage, staging, python, downloadAssetFromSources, extractZip, configurePythonPath, signal } = context;
      const paths = this.paths(staging);
      const archivePath = joinPath(staging, "python-embed.zip");
      await downloadAssetFromSources([python.archiveURL, ...(python.mirrors || [])], archivePath, storage, python.archiveSHA256, {
        signal,
        timeoutMs: Number(context.downloadTimeoutMs || 180000),
        maxBytes: 256 * 1024 * 1024
      });
      await extractZip(storage, archivePath, paths.pythonRoot);
      await configurePythonPath(storage, paths.pythonRoot);
      if (!await storage.exists(paths.executable)) throw new Error("托管 Python 解压后未找到 python.exe");
      await this.ensureExecutablePermissions(paths.executable);
      await storage.ensureDir(paths.packageRoot);
      const pipManifest = python.pip || {};
      const pipPath = joinPath(staging, `pip-${pipManifest.version || "wheel"}.whl`);
      await downloadAssetFromSources([...(pipManifest.wheelMirrors || []), pipManifest.wheelURL], pipPath, storage, pipManifest.wheelSHA256, {
        signal,
        timeoutMs: Number(context.downloadTimeoutMs || 180000),
        maxBytes: 32 * 1024 * 1024
      });
      await extractZip(storage, pipPath, paths.packageRoot);
      return paths;
    }

    diagnostics() {
      return { ...super.diagnostics(), archiveFormat: "zip", installation: "embeddable-python+pip-wheel+target" };
    }
  }

  class UvManagedPythonRuntimeAdapter extends RuntimeAdapter {
    constructor(platform, config = {}) {
      super(platform, config);
      this.supported = Boolean(config.uv?.sources?.length && config.pythonVersion);
    }

    async findTarExecutable(storage) {
      const candidates = this.platform.os === "macos" ? ["/usr/bin/tar"] : ["/usr/bin/tar", "/bin/tar"];
      for (const candidate of candidates) if (await storage.exists(candidate)) return candidate;
      throw new Error("当前系统缺少可用的 tar 解包器，无法准备托管 Python 安装器");
    }

    async extractTarGzip(storage, archivePath, destination, context = {}) {
      const tar = await this.findTarExecutable(storage);
      await storage.ensureDir(destination);
      const result = await context.runProcess(tar, ["-xzf", archivePath, "-C", destination], {
        signal: context.signal,
        timeoutMs: Number(context.extractTimeoutMs || 120000)
      });
      if (result.exitCode !== 0) throw new Error(`运行时安装器解包失败（tar 退出码 ${result.exitCode}）`);
    }

    async resolveInstalledPython(storage, pythonRoot, version) {
      const prefix = `cpython-${String(version || "3.13.15")}-`;
      const entries = await storage.list(pythonRoot);
      const directories = (Array.isArray(entries) ? entries : [])
        .filter(path => leafName(path).startsWith(prefix))
        .sort((left, right) => Number(leafName(left).includes(`${version}-`)) - Number(leafName(right).includes(`${version}-`)));
      const executableName = String(this.config.pythonExecutableName || "python3.13");
      for (const directory of directories) {
        const candidates = this.platform.os === "windows"
          ? [joinPath(directory, executableName)]
          : [joinPath(directory, "bin", executableName)];
        for (const executable of candidates) if (await storage.exists(executable)) return executable;
      }
      throw new Error(`uv 已安装 Python ${version}，但未找到该平台的解释器文件`);
    }

    async installPython(context = {}) {
      const { storage, staging, downloadAssetFromSources, extractZip, runProcess, signal } = context;
      const paths = this.paths(staging);
      const uv = this.config.uv || {};
      const pythonBuild = this.config.pythonBuild || {};
      const archivePath = joinPath(staging, `uv-${uv.version || "runtime"}.${uv.archiveFormat || "tar.gz"}`);
      const uvRoot = joinPath(staging, "uv-bootstrap");
      const downloadsManifestPath = joinPath(staging, "python-downloads.json");
      const probePath = joinPath(staging, "python-path-probe.json");
      try {
        const version = String(pythonBuild.version || this.config.pythonVersion || "");
        const versionParts = version.split(".").map(part => Number.parseInt(part, 10));
        if (versionParts.length !== 3 || versionParts.some(part => !Number.isInteger(part))) throw new Error("python-build-standalone 的 Python 版本配置无效");
        if (!/^\d{8}$/.test(String(pythonBuild.release || "")) || !/^[a-f0-9]{64}$/i.test(String(pythonBuild.sha256 || "")) || !/^https:\/\//i.test(String(pythonBuild.url || ""))) {
          throw new Error("python-build-standalone 缺少固定版本、HTTPS 地址或 SHA-256");
        }
        const [platformName, architectureName, abiName] = this.target.split("-");
        const pythonOS = platformName === "macos" ? "darwin" : platformName;
        const pythonArch = architectureName === "arm64" ? "aarch64" : architectureName === "x64" ? "x86_64" : architectureName;
        const pythonLibc = pythonOS === "linux" ? abiName : "none";
        if (!new Set(["windows", "darwin", "linux"]).has(pythonOS) || !new Set(["aarch64", "x86_64"]).has(pythonArch) || (pythonOS === "linux" && pythonLibc !== "gnu")) {
          throw new Error(`uv Python 下载元数据不支持当前目标：${this.target}`);
        }
        const downloadKey = `cpython-${version}-${pythonOS}-${pythonArch}-${pythonLibc}`;
        const downloadMetadata = {
          name: "cpython",
          arch: { family: pythonArch, variant: null },
          os: pythonOS,
          libc: pythonLibc,
          major: versionParts[0],
          minor: versionParts[1],
          patch: versionParts[2],
          prerelease: "",
          url: String(pythonBuild.url),
          sha256: String(pythonBuild.sha256).toLowerCase(),
          variant: null,
          build: String(pythonBuild.release)
        };
        await storage.writeJSON(downloadsManifestPath, { [downloadKey]: downloadMetadata });
        await downloadAssetFromSources((uv.sources || []).map(source => source.url), archivePath, storage, uv.sources?.[0]?.sha256, {
          signal,
          timeoutMs: Number(context.downloadTimeoutMs || 180000),
          maxBytes: 96 * 1024 * 1024
        });
        if (uv.archiveFormat === "zip") await extractZip(storage, archivePath, uvRoot);
        else if (uv.archiveFormat === "tar.gz") await this.extractTarGzip(storage, archivePath, uvRoot, context);
        else throw new Error(`不支持 uv 安装器归档格式：${uv.archiveFormat || "unknown"}`);
        const uvExecutable = joinPath(uvRoot, uv.executablePath);
        if (!await storage.exists(uvExecutable)) throw new Error("托管 uv 解压后未找到对应平台的可执行文件");
        await this.ensureExecutablePermissions(uvExecutable);
        await storage.ensureDir(paths.pythonRoot);
        const install = await runProcess(uvExecutable, [
          "--no-config", "--no-cache", "--no-progress", "python", "install", version,
          "--install-dir", paths.pythonRoot, "--no-bin", "--managed-python",
          "--python-downloads-json-url", downloadsManifestPath
        ], { signal, timeoutMs: Number(context.pythonInstallProcessTimeoutMs || 600000) });
        if (install.exitCode !== 0) throw new Error(`uv 安装托管 Python 失败（退出码 ${install.exitCode}）`);
        const executable = await this.resolveInstalledPython(storage, paths.pythonRoot, version);
        await this.ensureExecutablePermissions(executable);
        const probe = await runProcess(executable, ["-c", pythonPathProbeCode(probePath)], { signal, timeoutMs: 30000 });
        if (probe.exitCode !== 0) throw new Error(`托管 Python 路径探针失败（退出码 ${probe.exitCode}）`);
        const details = await context.readJSON(storage, probePath);
        if (String(details?.pythonVersion || "") !== version) throw new Error(`托管 Python 版本不符合目标清单：${details?.pythonVersion || "unknown"}`);
        if (!containedPath(staging, details?.packageRoot)) throw new Error("托管 Python site-packages 路径越出隔离安装目录");
        await storage.ensureDir(details.packageRoot);
        return { ...paths, executable, packageRoot: details.packageRoot, pythonHome: details.prefix, pythonVersion: details.pythonVersion };
      }
      finally {
        for (const [path, recursive] of [[probePath, false], [downloadsManifestPath, false], [archivePath, false], [uvRoot, true]]) {
          try { await storage.remove?.(path, recursive); } catch (_) {}
        }
        const leftovers = [];
        for (const path of [downloadsManifestPath, archivePath, uvRoot, probePath]) {
          try { if (await storage.exists(path)) leftovers.push(leafName(path)); } catch (_) {}
        }
        if (leftovers.length) throw new Error(`uv 安装临时文件清理失败：${leftovers.join(", ")}`);
      }
    }

    diagnostics() {
      return { ...super.diagnostics(), archiveFormat: String(this.config.uv?.archiveFormat || ""), installation: "uv-managed-python+pip-wheel+target", installerVersion: String(this.config.uv?.version || "") };
    }
  }

  class UnsupportedRuntimeAdapter extends RuntimeAdapter {
    constructor(platform, config = {}) {
      super(platform, config);
      this.supported = false;
    }

    async prepare() { throw new Error(`当前平台没有可用的托管文献获取运行时：${this.target}`); }
    async installPackages() { throw new Error(`当前平台没有可用的托管文献获取运行时：${this.target}`); }
  }

  function createRuntimeAdapter(platform, manifest) {
    const target = String(platform?.target || "unknown");
    const config = manifest?.targets?.[target] || {};
    if (target === "windows-x64") return new WindowsX64RuntimeAdapter(platform, config);
    if (config.runtimeInstallStrategy === "uv-managed-python" && config.uv?.sources?.length) return new UvManagedPythonRuntimeAdapter(platform, config);
    return new UnsupportedRuntimeAdapter(platform, config);
  }

  Agent.RuntimeAdapter = RuntimeAdapter;
  Agent.WindowsX64RuntimeAdapter = WindowsX64RuntimeAdapter;
  Agent.UvManagedPythonRuntimeAdapter = UvManagedPythonRuntimeAdapter;
  Agent.UnsupportedRuntimeAdapter = UnsupportedRuntimeAdapter;
  Agent.createRuntimeAdapter = createRuntimeAdapter;
})(this);
