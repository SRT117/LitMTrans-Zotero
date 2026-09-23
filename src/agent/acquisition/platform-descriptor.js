(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  const TARGETS = Object.freeze([
    "windows-x64",
    "windows-arm64",
    "macos-arm64",
    "macos-x64",
    "linux-x64-gnu",
    "linux-arm64-gnu"
  ]);

  function text(value) { return String(value ?? "").trim(); }

  function osName(value) {
    const raw = text(value).toLowerCase();
    if (!raw) return "";
    if (["winnt", "windows", "win32"].includes(raw)) return "windows";
    if (["darwin", "mac", "macos", "osx"].includes(raw)) return "macos";
    if (["linux", "gnu/linux"].includes(raw)) return "linux";
    return raw;
  }

  function architecture(value, abi = "", is64Bit = undefined) {
    const raw = `${text(value)} ${text(abi)}`.toLowerCase();
    if (/(?:aarch64|arm64|armv8)/.test(raw)) return "arm64";
    if (/(?:x86_64|amd64|x64|amd64)/.test(raw)) return "x64";
    if (/(?:i[3-6]86|x86|ia32|x32)/.test(raw)) return "x86";
    if (is64Bit === true) return "x64";
    return "unknown";
  }

  function abiFamily(os, abi) {
    const raw = text(abi).toLowerCase();
    if (os === "linux") {
      if (/musl/.test(raw)) return "musl";
      if (/(?:^|[-_])gnu(?:$|[-_])|glibc/.test(raw)) return "gnu";
      return "unknown";
    }
    if (os === "windows") return "msvc";
    if (os === "macos") return "darwin";
    return raw || "unknown";
  }

  function detect(options = {}) {
    const info = options.appInfo || global.Services?.appinfo || {};
    const zotero = options.zotero || global.Zotero || {};
    const os = osName(options.os || info.OS || (zotero.isWin ? "windows" : zotero.isMac ? "macos" : zotero.isLinux ? "linux" : ""));
    const rawABI = text(options.abi || info.XPCOMABI || info.platformABI || "");
    const arch = architecture(options.arch || info.arch || "", rawABI, info.is64Bit);
    const abi = abiFamily(os, rawABI);
    let target = "unknown";
    if (os === "windows" && ["x64", "arm64"].includes(arch)) target = `windows-${arch}`;
    else if (os === "macos" && ["x64", "arm64"].includes(arch)) target = `macos-${arch}`;
    else if (os === "linux" && ["x64", "arm64"].includes(arch) && abi === "gnu") target = `linux-${arch}-gnu`;
    else if (os === "linux" && ["x64", "arm64"].includes(arch) && abi === "musl") target = `linux-${arch}-musl`;
    else if (os === "linux" && ["x64", "arm64"].includes(arch)) target = `linux-${arch}-unknown-abi`;
    const supportedTarget = TARGETS.includes(target);
    let reason = supportedTarget ? "target-identified" : "unsupported-platform-or-abi";
    if (os === "linux" && abi === "musl") reason = "linux-musl-is-not-a-managed-runtime-target";
    if (os === "linux" && abi === "unknown") reason = "linux-abi-undetermined-managed-runtime-disabled";
    if (arch === "x86") reason = "32-bit-runtime-is-not-a-managed-runtime-target";
    if (!os) reason = "zotero-runtime-platform-information-unavailable";
    return {
      os: os || "unknown",
      arch,
      abi,
      rawABI,
      target,
      supported: supportedTarget,
      reason,
      source: "Services.appinfo/Zotero runtime"
    };
  }

  function forTarget(target) {
    const value = text(target);
    const match = value.match(/^(windows|macos)-(x64|arm64)$/) || value.match(/^(linux)-(x64|arm64)-(gnu|musl)$/);
    if (!match) return { os: "unknown", arch: "unknown", abi: "unknown", target: value || "unknown", supported: false, reason: "unknown-target", source: "explicit-target" };
    const os = match[1];
    const arch = match[2];
    const abi = os === "linux" ? match[3] : (os === "windows" ? "msvc" : "darwin");
    return {
      os,
      arch,
      abi,
      rawABI: `${arch}-${abi}`,
      target: value,
      supported: TARGETS.includes(value),
      reason: TARGETS.includes(value) ? "target-identified" : "unsupported-platform-or-abi",
      source: "explicit-target"
    };
  }

  Agent.PlatformDescriptor = { TARGETS, detect, forTarget, osName, architecture, abiFamily };
})(this);
