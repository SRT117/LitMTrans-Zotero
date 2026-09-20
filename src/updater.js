(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};

  const ADDON_ID = "litmtrans@srt117.github.io";
  const REPO = "SRT117/LitMTrans-Zotero";
  const OFFICIAL_UPDATE_URL = `https://github.com/${REPO}/releases/latest/download/update.json`;

  const UPDATE_MANIFEST_SOURCES = [
    OFFICIAL_UPDATE_URL,
    `https://ghproxy.net/${OFFICIAL_UPDATE_URL}`,
    `https://mirror.ghproxy.com/${OFFICIAL_UPDATE_URL}`
  ];

  function getDownloadMirrors(officialUpdateLink) {
    const rawUrl = String(officialUpdateLink || "").trim();
    if (!rawUrl) return [];
    if (!rawUrl.startsWith("https://github.com/")) {
      return [rawUrl];
    }
    return [
      `https://ghproxy.net/${rawUrl}`,
      `https://mirror.ghproxy.com/${rawUrl}`,
      rawUrl
    ];
  }

  function getAddonManager() {
    try {
      return ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;
    } catch (_) {
      try {
        return ChromeUtils.import("resource://gre/modules/AddonManager.jsm").AddonManager;
      } catch (_) {
        return global.AddonManager || null;
      }
    }
  }

  function log(message) {
    try {
      if (typeof Zotero !== "undefined" && Zotero.debug) {
        Zotero.debug(`[LitMTrans Updater] ${message}`);
      }
    } catch (_) {}
  }

  function newTimeoutController(timeoutMs, abortReason) {
    const controller = LitMTrans.Utils?.newAbortController
      ? LitMTrans.Utils.newAbortController()
      : (typeof AbortController === "function" ? new AbortController() : null);
    let timer = null;
    if (controller && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { controller.abort(abortReason); } catch (_) {}
      }, timeoutMs);
    }
    return {
      signal: controller?.signal,
      cleanup: () => { if (timer) clearTimeout(timer); }
    };
  }

  async function fetchJsonWithFullTimeout(url, timeoutMs = 8000) {
    const link = newTimeoutController(timeoutMs, "请求元数据超时");
    try {
      const res = await fetch(url, {
        signal: link.signal,
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      link.cleanup();
    }
  }

  async function fetchBytesWithFullTimeout(url, timeoutMs = 120000, onProgress = null) {
    const link = newTimeoutController(timeoutMs, "下载安装包超时（超过120秒未完成）");
    try {
      const res = await fetch(url, {
        signal: link.signal,
        cache: "no-store",
        headers: { "Accept": "application/octet-stream,*/*" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentLengthHeader = res.headers.get("Content-Length");
      const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const chunks = [];
        let receivedBytes = 0;
        let lastReportTime = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedBytes += value.length;

          const now = Date.now();
          if (typeof onProgress === "function" && (now - lastReportTime > 200 || receivedBytes === totalBytes)) {
            lastReportTime = now;
            let percentStr = "";
            if (totalBytes > 0) {
              const percent = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
              percentStr = ` (${percent}%)`;
            } else {
              const mb = (receivedBytes / (1024 * 1024)).toFixed(1);
              percentStr = ` (${mb} MB)`;
            }
            onProgress({
              stage: "downloading",
              message: `正在下载更新包${percentStr}...`,
              loaded: receivedBytes,
              total: totalBytes
            });
          }
        }

        const combined = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        return combined;
      }

      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } finally {
      link.cleanup();
    }
  }

  async function computeSha256(bytes) {
    if (typeof crypto !== "undefined" && crypto?.subtle?.digest) {
      const buffer = await crypto.subtle.digest("SHA-256", bytes);
      const array = Array.from(new Uint8Array(buffer));
      return array.map(b => b.toString(16).padStart(2, "0")).join("").toLowerCase();
    }
    if (typeof require === "function") {
      try {
        const { createHash } = require("node:crypto");
        return createHash("sha256").update(bytes).digest("hex").toLowerCase();
      } catch (_) {}
    }
    throw new Error("当前环境缺少 SHA-256 密码学哈希支持");
  }

  const Updater = {
    stagedVersion: null,
    isUpdating: false,

    async fetchUpdateManifest(timeoutMs = 8000, onProgress = null) {
      if (typeof onProgress === "function") {
        onProgress({ stage: "probing", message: "正在探测可用更新通道..." });
      }

      const controllers = UPDATE_MANIFEST_SOURCES.map(() => {
        return LitMTrans.Utils?.newAbortController
          ? LitMTrans.Utils.newAbortController()
          : (typeof AbortController === "function" ? new AbortController() : null);
      });

      const fetchOne = async (url, index) => {
        const controller = controllers[index];
        let timer = null;
        try {
          if (controller && timeoutMs > 0) {
            timer = setTimeout(() => {
              try { controller.abort("请求元数据超时"); } catch (_) {}
            }, timeoutMs);
          }
          log(`Probing update manifest from: ${url}`);
          const res = await fetch(url, {
            signal: controller?.signal,
            cache: "no-store",
            headers: { "Accept": "application/json" }
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();

          const addonEntry = data?.addons?.[ADDON_ID];
          const updateItem = Array.isArray(addonEntry?.updates) ? addonEntry.updates[0] : null;
          if (updateItem && typeof updateItem.version === "string" && updateItem.version.trim()) {
            const rawHash = String(updateItem.update_hash || "").replace(/^sha256:/i, "").toLowerCase().trim();
            if (!/^[a-f0-9]{64}$/.test(rawHash)) {
              throw new Error("更新元数据中的哈希格式非法或缺失，已终止解析");
            }
            log(`Fastest manifest resolved from ${url}, latest version: ${updateItem.version}`);
            return {
              version: updateItem.version.trim(),
              updateLink: String(updateItem.update_link || "").trim(),
              updateHash: rawHash,
              sourceUrl: url,
              raw: data
            };
          }
          throw new Error("清单中未包含有效插件版本条目");
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      return new Promise((resolve, reject) => {
        let settledCount = 0;
        let hasResolved = false;
        const errors = [];

        UPDATE_MANIFEST_SOURCES.forEach((url, idx) => {
          fetchOne(url, idx).then(
            result => {
              if (hasResolved) return;
              hasResolved = true;
              controllers.forEach((c, i) => {
                if (i !== idx) {
                  try { c?.abort("其他通道已命中更新元数据"); } catch (_) {}
                }
              });
              resolve(result);
            },
            err => {
              errors.push(`${url}: ${err.message || String(err)}`);
              settledCount++;
              if (settledCount === UPDATE_MANIFEST_SOURCES.length && !hasResolved) {
                reject(new Error(`无法连接更新元数据服务器: 所有节点均不可达（${errors.join("; ")}）`));
              }
            }
          );
        });
      });
    },

    async checkUpdate(currentVersion, onProgress = null) {
      const manifestInfo = await this.fetchUpdateManifest(8000, onProgress);
      const remoteVersion = String(manifestInfo.version || "").trim();
      const current = String(currentVersion || "").trim();
      if (!remoteVersion || !current) {
        return { hasUpdate: false, version: current };
      }

      let cmp = 0;
      try {
        if (typeof Services !== "undefined" && Services.vc?.compare) {
          cmp = Services.vc.compare(remoteVersion, current);
        } else {
          cmp = remoteVersion.localeCompare(current, undefined, { numeric: true });
        }
      } catch (_) {
        cmp = remoteVersion !== current ? 1 : 0;
      }

      return {
        hasUpdate: cmp > 0,
        version: remoteVersion,
        updateLink: manifestInfo.updateLink,
        updateHash: manifestInfo.updateHash
      };
    },

    async downloadAndVerifyXpi({ version, updateLink, updateHash }, onProgress) {
      const mirrors = getDownloadMirrors(updateLink);
      if (!mirrors.length) throw new Error("缺少有效的安装包下载地址");

      const expectedHash = String(updateHash || "").replace(/^sha256:/i, "").toLowerCase().trim();
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new Error("更新元数据未提供合法 SHA-256 哈希值，拒绝下载未校验的安装包");
      }
      let lastErr = null;

      for (const url of mirrors) {
        try {
          if (typeof onProgress === "function") {
            onProgress({ stage: "downloading", message: `正在加速下载更新包 (v${version})...` });
          }
          log(`Downloading XPI from: ${url}`);
          const bytes = await fetchBytesWithFullTimeout(url, 120000, onProgress);

          if (!bytes || bytes.byteLength < 1024) {
            lastErr = new Error("下载的文件过小或损坏");
            continue;
          }

          if (typeof onProgress === "function") {
            onProgress({ stage: "verifying", message: "正在校验安装包完整性与安全性 (SHA-256)..." });
          }
          const actualHash = await computeSha256(bytes);
          if (actualHash !== expectedHash) {
            log(`Security hash mismatch for ${url}. Expected: ${expectedHash}, Actual: ${actualHash}`);
            lastErr = new Error(`安装包校验失败：SHA-256 哈希不匹配（可能遭篡改或网络损坏）`);
            continue;
          }
          log(`SHA-256 verification passed: ${actualHash}`);

          const tempDir = typeof PathUtils !== "undefined" ? PathUtils.tempDir : (require("node:os")?.tmpdir?.() || "");
          const tempXpiPath = typeof PathUtils !== "undefined"
            ? PathUtils.join(tempDir, `litmtrans-update-${version}.xpi`)
            : `${tempDir}/litmtrans-update-${version}.xpi`;

          if (typeof IOUtils !== "undefined") {
            await IOUtils.write(tempXpiPath, bytes, { mode: "overwrite" });
          } else if (typeof require === "function") {
            require("node:fs").writeFileSync(tempXpiPath, bytes);
          }

          log(`XPI successfully written to: ${tempXpiPath}`);
          return tempXpiPath;
        } catch (err) {
          lastErr = err;
          log(`Download from ${url} failed: ${err.message || String(err)}`);
        }
      }

      throw new Error(`下载更新包失败: ${lastErr?.message || "所有镜像节点连接超时"}`);
    },

    async installXpiFile(filePath, expectedVersion = "") {
      const AddonManager = getAddonManager();
      if (!AddonManager) {
        throw new Error("当前宿主环境缺少 AddonManager 扩展管理器");
      }

      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(filePath);

      const install = await AddonManager.getInstallForFile(file, "application/x-xpinstall");
      if (!install) {
        throw new Error("无法初始化 XPI 安装任务");
      }

      const candidateId = String(install.addon?.id || install.existingAddon?.id || "").trim();
      if (candidateId && candidateId !== ADDON_ID) {
        throw new Error(`安装包扩展标识不匹配（期望 ${ADDON_ID}，实际为 ${candidateId}）`);
      }

      const candidateVersion = String(install.addon?.version || "").trim();
      const targetVersion = String(expectedVersion || "").trim();
      if (candidateVersion && targetVersion && candidateVersion !== targetVersion) {
        throw new Error(`安装包版本不匹配（期望 v${targetVersion}，实际为 v${candidateVersion}）`);
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutTimer = null;

        const cleanup = () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          try { install.removeListener(listener); } catch (_) {}
        };

        const finish = (action, val) => {
          if (settled) return;
          settled = true;
          cleanup();
          action(val);
        };

        timeoutTimer = setTimeout(() => {
          try { install.cancel(); } catch (_) {}
          finish(reject, new Error("安装更新超时（30秒内未完成响应），已取消任务"));
        }, 30000);

        const listener = {
          onDownloadFailed: () => finish(reject, new Error(install.error ? `安装包读取失败代码: ${install.error}` : "安装包读取失败")),
          onInstallEnded: () => finish(resolve, true),
          onInstallFailed: () => finish(reject, new Error(install.error ? `扩展安装失败代码: ${install.error}` : "更新安装失败")),
          onInstallCancelled: () => finish(reject, new Error("更新安装已取消"))
        };

        try {
          install.addListener(listener);
          const maybePromise = install.install();
          if (maybePromise && typeof maybePromise.catch === "function") {
            maybePromise.catch(err => finish(reject, err));
          }
        } catch (err) {
          finish(reject, err);
        }
      });
    },

    async applyUpdate(updateInfo, onStatus) {
      if (this.isUpdating) {
        throw new Error("更新任务已在进行中，请稍候");
      }
      this.isUpdating = true;

      let tempXpi = null;
      try {
        tempXpi = await this.downloadAndVerifyXpi(updateInfo, onStatus);

        if (typeof onStatus === "function") {
          onStatus({ stage: "installing", message: "正在载入新版本插件...", version: updateInfo.version });
        }

        await this.installXpiFile(tempXpi, updateInfo.version);
        this.stagedVersion = updateInfo.version;

        if (typeof onStatus === "function") {
          onStatus({ stage: "installed", message: `已成功更新至 v${updateInfo.version}！`, version: updateInfo.version });
        }

        return { success: true, version: updateInfo.version };
      } finally {
        if (tempXpi && typeof IOUtils !== "undefined") {
          try { await IOUtils.remove(tempXpi, { ignoreAbsent: true }); } catch (_) {}
        }
        this.isUpdating = false;
      }
    }
  };

  LitMTrans.Updater = Updater;
  LitMTrans.computeSha256 = computeSha256;
})(this);
