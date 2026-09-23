(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  const WINDOWS_X64_TARGET = Object.freeze({
    target: "windows-x64",
    status: "field-validated",
    provider: "python-official-embeddable",
    runtimeVersion: "1.17.0-windows-x64-py31315",
    archiveFormat: "zip",
    executablePath: "python/python.exe",
    packageRoot: "Lib",
    packageInstallation: "pip-wheel+target",
    sources: [
      {
        type: "python-runtime",
        url: "https://mirrors.huaweicloud.com/python/3.13.15/python-3.13.15-embed-amd64.zip",
        sha256: "d1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf",
        verified: true
      },
      {
        type: "python-runtime",
        url: "https://www.python.org/ftp/python/3.13.15/python-3.13.15-embed-amd64.zip",
        sha256: "d1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf",
        verified: true
      }
    ],
    scansciVersion: "1.17.0",
    mcpVersion: "2.2.0",
    performanceBackend: "unknown"
  });

  const UV_RELEASE = "0.12.18";
  const PYTHON_BUILD_RELEASE = "20260901";

  function uvManagedTarget(options) {
    const uvFilename = options.uvFilename;
    const pythonFilename = `cpython-3.13.15+${PYTHON_BUILD_RELEASE}-${options.pythonTriple}-install_only_stripped.tar.gz`;
    const uvURL = `https://github.com/astral-sh/uv/releases/download/${UV_RELEASE}/${uvFilename}`;
    const pythonURL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_RELEASE}/${pythonFilename.replace("+", "%2B")}`;
    return Object.freeze({
      target: options.target,
      status: "adapter-ready-not-field-validated",
      provider: "python-build-standalone-via-uv",
      runtimeVersion: `1.17.0-${options.target}-py31315-uv${UV_RELEASE}`,
      pythonVersion: "3.13.15",
      pythonInstallDir: "python",
      pythonExecutableName: options.pythonExecutableName,
      runtimeInstallStrategy: "uv-managed-python",
      archiveFormat: "tar.gz",
      executablePath: "",
      packageRoot: "",
      packageInstallation: "pip-wheel+target",
      sources: [
        { type: "uv-runtime", url: uvURL, sha256: options.uvSHA256, verified: true },
        { type: "python-runtime-managed-by-uv", url: pythonURL, sha256: options.pythonSHA256, verified: true }
      ],
      uv: {
        version: UV_RELEASE,
        archiveFormat: options.uvArchiveFormat,
        executablePath: options.uvExecutablePath,
        sources: [
          { url: `https://releases.astral.sh/github/uv/releases/download/${UV_RELEASE}/${uvFilename}`, sha256: options.uvSHA256 },
          { url: uvURL, sha256: options.uvSHA256 }
        ]
      },
      pythonBuild: {
        version: "3.13.15",
        release: PYTHON_BUILD_RELEASE,
        targetTriple: options.pythonTriple,
        archiveFormat: "tar.gz",
        url: pythonURL,
        sha256: options.pythonSHA256
      },
      scansciVersion: "1.17.0",
      mcpVersion: "2.2.0",
      performanceBackend: "unknown",
      reason: options.reason
    });
  }

  function unvalidatedTarget(target, provider, reason) {
    return Object.freeze({
      target,
      status: "adapter-ready-not-field-validated",
      provider,
      runtimeVersion: "",
      archiveFormat: "",
      executablePath: "",
      packageRoot: "",
      packageInstallation: "adapter-defined",
      sources: [],
      sha256: "",
      scansciVersion: "",
      mcpVersion: "",
      performanceBackend: "unknown",
      reason
    });
  }

  const TARGET_MANIFESTS = Object.freeze({
    "windows-x64": WINDOWS_X64_TARGET,
    "windows-arm64": uvManagedTarget({
      target: "windows-arm64", pythonTriple: "aarch64-pc-windows-msvc", pythonExecutableName: "python.exe",
      uvFilename: "uv-aarch64-pc-windows-msvc.zip", uvArchiveFormat: "zip", uvExecutablePath: "uv-aarch64-pc-windows-msvc/uv.exe",
      uvSHA256: "17f27b1c64eacc757ae603579f116a014881e486c5e79ae81877980d4699e943",
      pythonSHA256: "8b31e1ddae9ebd339eae0549049546aa54484dbf92c81694b1e7510fee869413",
      reason: "runtime is implemented with pinned uv/Python artifacts; Windows ARM64 host validation remains outstanding"
    }),
    "macos-arm64": uvManagedTarget({
      target: "macos-arm64", pythonTriple: "aarch64-apple-darwin", pythonExecutableName: "python3.13",
      uvFilename: "uv-aarch64-apple-darwin.tar.gz", uvArchiveFormat: "tar.gz", uvExecutablePath: "uv-aarch64-apple-darwin/uv",
      uvSHA256: "cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b",
      pythonSHA256: "d3904bd6a072246e07aa0bdadee9a14e80521e42a943c0848059feb16a2816dc",
      reason: "runtime is implemented with pinned uv/Python artifacts; macOS permissions, signing and host validation remain outstanding"
    }),
    "macos-x64": uvManagedTarget({
      target: "macos-x64", pythonTriple: "x86_64-apple-darwin", pythonExecutableName: "python3.13",
      uvFilename: "uv-x86_64-apple-darwin.tar.gz", uvArchiveFormat: "tar.gz", uvExecutablePath: "uv-x86_64-apple-darwin/uv",
      uvSHA256: "2e4108f5395397c8bc5d43bf83d3bdbb2d0e92b90d0efa607756be704905fa33",
      pythonSHA256: "f712a9143c8a5d248438ec7921a0b48d548bca4f1337d33c690d28c2d0504137",
      reason: "runtime is implemented with pinned uv/Python artifacts; macOS permissions, signing and host validation remain outstanding"
    }),
    "linux-x64-gnu": uvManagedTarget({
      target: "linux-x64-gnu", pythonTriple: "x86_64-unknown-linux-gnu", pythonExecutableName: "python3.13",
      uvFilename: "uv-x86_64-unknown-linux-gnu.tar.gz", uvArchiveFormat: "tar.gz", uvExecutablePath: "uv-x86_64-unknown-linux-gnu/uv",
      uvSHA256: "89eadd7c76fc063887959510d5ba0ab1264dfd5f1143b925ddb73021a40acf16",
      pythonSHA256: "8a689a077337bea6d1c4bc0b7df1d52fcaa28f5f67e50df8bf417c1e3f9d8874",
      reason: "runtime is implemented with pinned uv/Python artifacts; Linux x64 Zotero host validation remains outstanding"
    }),
    "linux-arm64-gnu": uvManagedTarget({
      target: "linux-arm64-gnu", pythonTriple: "aarch64-unknown-linux-gnu", pythonExecutableName: "python3.13",
      uvFilename: "uv-aarch64-unknown-linux-gnu.tar.gz", uvArchiveFormat: "tar.gz", uvExecutablePath: "uv-aarch64-unknown-linux-gnu/uv",
      uvSHA256: "afb6291f3f0a6b4521fc67b947822506c41dde5b60d2189dd8f3695b2ac8c9e7",
      pythonSHA256: "01ce0ce9189feaead3298abf10d4efe998c55a489b3d5d38ca4f83dda7e7977e",
      reason: "runtime, ScanSci tools/list and OA download were validated on A1 ARM64; Zotero Linux host validation remains outstanding"
    })
  });

  const LAST_KNOWN_GOOD_MANIFEST = Object.freeze({
    schemaVersion: 2,
    acquisitionRuntimeVersion: "1.17.0-windows-x64-py31315",
    targets: TARGET_MANIFESTS,
    scansci: {
      package: "scansci-pdf",
      minVersion: "1.17.0",
      recommendedVersion: "1.17.0",
      maxTestedVersion: "1.17.0",
      wheelURL: "https://files.pythonhosted.org/packages/a0/99/acceedf298bff7ebc91e4909360d0bd4854c0f4821096694fb817ffbada2/scansci_pdf-1.17.0-py3-none-any.whl",
      wheelSHA256: "e19853c25317a8af6f96236bdb28989a56129bd60f0c1198d8e6f84d86fdcf58",
      wheelMirrors: ["https://mirrors.aliyun.com/pypi/packages/a0/99/acceedf298bff7ebc91e4909360d0bd4854c0f4821096694fb817ffbada2/scansci_pdf-1.17.0-py3-none-any.whl"],
      packageIndexSources: [
        "https://pypi.org/simple",
        "https://mirrors.aliyun.com/pypi/simple",
        "https://pypi.tuna.tsinghua.edu.cn/simple"
      ],
      controlTimeoutMs: 15000,
      downloadTimeoutMs: 180000,
      loginTimeoutMs: 600000,
      institutionToolNames: ["scansci_pdf_channel_status", "scansci_pdf_login", "scansci_pdf_schools"]
    },
    python: {
      implementation: "python-embeddable+pip-wheel",
      version: "3.13.15",
      windows: {
        archiveURL: "https://mirrors.huaweicloud.com/python/3.13.15/python-3.13.15-embed-amd64.zip",
        archiveSHA256: "d1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf",
        mirrors: [
          "https://mirrors.aliyun.com/python-release/windows/python-3.13.15-embed-amd64.zip",
          "https://www.python.org/ftp/python/3.13.15/python-3.13.15-embed-amd64.zip"
        ],
        executable: "python.exe"
      },
      pip: {
        version: "25.3",
        wheelURL: "https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl",
        wheelSHA256: "9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd",
        wheelMirrors: ["https://mirrors.aliyun.com/pypi/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl"]
      }
    },
    mirrors: [
      { name: "huaweicloud-python", kind: "python-runtime", url: "https://mirrors.huaweicloud.com/python/3.13.15" },
      { name: "aliyun-python", kind: "python-runtime", url: "https://mirrors.aliyun.com/python-release/windows" },
      { name: "aliyun-pypi", kind: "package-index", url: "https://mirrors.aliyun.com/pypi/simple" },
      { name: "tsinghua-pypi", kind: "package-index", url: "https://pypi.tuna.tsinghua.edu.cn/simple" }
    ],
    compatibility: {
      windows: "windows-x64-field-validated; windows-arm64-adapter-ready",
      macos: "adapter-ready-not-field-validated",
      linux: "adapter-ready-not-field-validated"
    }
  });

  function manifest(value = {}) {
    return {
      ...LAST_KNOWN_GOOD_MANIFEST,
      ...value,
      scansci: { ...LAST_KNOWN_GOOD_MANIFEST.scansci, ...(value.scansci || {}) },
      targets: { ...LAST_KNOWN_GOOD_MANIFEST.targets, ...(value.targets || {}) },
      python: {
        ...LAST_KNOWN_GOOD_MANIFEST.python,
        ...(value.python || {}),
        windows: { ...LAST_KNOWN_GOOD_MANIFEST.python.windows, ...(value.python?.windows || {}) },
        pip: { ...LAST_KNOWN_GOOD_MANIFEST.python.pip, ...(value.python?.pip || {}) }
      },
      mirrors: Array.isArray(value.mirrors) ? value.mirrors : [...LAST_KNOWN_GOOD_MANIFEST.mirrors]
    };
  }

  function targetManifest(value, target) {
    const resolved = manifest(value);
    const row = resolved.targets?.[String(target || "")];
    return row ? { ...row } : null;
  }

  Agent.AcquisitionRuntimeManifest = { LAST_KNOWN_GOOD_MANIFEST, TARGET_MANIFESTS, manifest, targetManifest };
})(this);
