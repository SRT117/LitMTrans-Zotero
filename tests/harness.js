"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const nodeCrypto = require("crypto");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");

// ZIP test helpers
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipU16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function zipU32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function zipU64(value) {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(value >>> 0, 0);
  out.writeUInt32LE(Math.floor(value / 0x100000000) >>> 0, 4);
  return out;
}

function oneEntryZip(name, text) {
  const fileName = Buffer.from(name);
  const source = Buffer.from(text);
  const compressed = zlib.deflateRawSync(source);
  const crc = crc32(source);
  const local = Buffer.concat([
    zipU32(0x04034b50), zipU16(20), zipU16(0), zipU16(8), zipU16(0), zipU16(0),
    zipU32(crc), zipU32(compressed.length), zipU32(source.length), zipU16(fileName.length), zipU16(0),
    fileName, compressed
  ]);
  const central = Buffer.concat([
    zipU32(0x02014b50), zipU16(20), zipU16(20), zipU16(0), zipU16(8), zipU16(0), zipU16(0),
    zipU32(crc), zipU32(compressed.length), zipU32(source.length), zipU16(fileName.length), zipU16(0),
    zipU16(0), zipU16(0), zipU16(0), zipU32(0), zipU32(0), fileName
  ]);
  return Buffer.concat([
    local, central,
    zipU32(0x06054b50), zipU16(0), zipU16(0), zipU16(1), zipU16(1),
    zipU32(central.length), zipU32(local.length), zipU16(0)
  ]);
}

function oneEntryZip64(name, text) {
  const fileName = Buffer.from(name);
  const source = Buffer.from(text);
  const compressed = zlib.deflateRawSync(source);
  const crc = crc32(source);
  const local = Buffer.concat([
    zipU32(0x04034b50), zipU16(45), zipU16(0), zipU16(8), zipU16(0), zipU16(0),
    zipU32(crc), zipU32(compressed.length), zipU32(source.length), zipU16(fileName.length), zipU16(0),
    fileName, compressed
  ]);
  const zip64Extra = Buffer.concat([zipU16(0x0001), zipU16(24), zipU64(source.length), zipU64(compressed.length), zipU64(0)]);
  const central = Buffer.concat([
    zipU32(0x02014b50), zipU16(45), zipU16(45), zipU16(0), zipU16(8), zipU16(0), zipU16(0),
    zipU32(crc), zipU32(0xffffffff), zipU32(0xffffffff), zipU16(fileName.length), zipU16(zip64Extra.length),
    zipU16(0), zipU16(0), zipU16(0), zipU32(0), zipU32(0xffffffff), fileName, zip64Extra
  ]);
  const directoryOffset = local.length;
  const zip64EOCD = Buffer.concat([
    zipU32(0x06064b50), zipU64(44), zipU16(45), zipU16(45), zipU32(0), zipU32(0),
    zipU64(1), zipU64(1), zipU64(central.length), zipU64(directoryOffset)
  ]);
  const zip64Locator = Buffer.concat([zipU32(0x07064b50), zipU32(0), zipU64(directoryOffset + central.length), zipU32(1)]);
  const classicEOCD = Buffer.concat([
    zipU32(0x06054b50), zipU16(0), zipU16(0), zipU16(0xffff), zipU16(0xffff),
    zipU32(0xffffffff), zipU32(0xffffffff), zipU16(0)
  ]);
  return Buffer.concat([local, central, zip64EOCD, zip64Locator, classicEOCD]);
}

// In-memory mock storage for document pipeline and caching tests
class MemoryStorage {
  constructor() { this.json = new Map(); this.text = new Map(); this.bytes = new Map(); }
  path(...parts) { return path.posix.join("/mem", ...parts); }
  resourceURL(documentID, relativePath = "") { return `resource://litmtrans-data/${documentID}/${relativePath}`; }
  async ensureDir() {}
  async readJSON(file, fallback) { return this.json.has(file) ? JSON.parse(JSON.stringify(this.json.get(file))) : fallback; }
  async writeJSON(file, value) { this.json.set(file, JSON.parse(JSON.stringify(value))); }
  async readText(file, fallback = "") { return this.text.has(file) ? this.text.get(file) : fallback; }
  async writeText(file, value) { this.text.set(file, String(value)); }
  async readBytes(file) { return this.bytes.get(file) || new Uint8Array(); }
  async writeBytes(file, value) { this.bytes.set(file, new Uint8Array(value)); }
  async stat(file) {
    if (this.text.has(file)) {
      const value = this.text.get(file);
      return { type: "regular", size: String(value).length, lastModified: 1234 };
    }
    if (this.bytes.has(file)) return { type: "regular", size: this.bytes.get(file).length, lastModified: 1234 };
    const prefix = file.endsWith("/") ? file : `${file}/`;
    if ([...this.json.keys(), ...this.text.keys(), ...this.bytes.keys()].some(k => k.startsWith(prefix))) {
      return { type: "directory", size: 0, lastModified: 1234 };
    }
    return null;
  }
  async list(directory) {
    const prefix = directory.endsWith("/") ? directory : `${directory}/`;
    return [...new Set([...this.json.keys(), ...this.text.keys(), ...this.bytes.keys()]
      .filter(file => file.startsWith(prefix))
      .map(file => prefix + file.slice(prefix.length).split("/")[0]))];
  }
  async exists(file) {
    if (this.json.has(file) || this.text.has(file) || this.bytes.has(file)) return true;
    const prefix = file.endsWith("/") ? file : `${file}/`;
    return [...this.json.keys(), ...this.text.keys(), ...this.bytes.keys()].some(k => k.startsWith(prefix));
  }
  async copyFile(src, dest) {
    if (this.json.has(src)) this.json.set(dest, JSON.parse(JSON.stringify(this.json.get(src))));
    if (this.text.has(src)) this.text.set(dest, this.text.get(src));
    if (this.bytes.has(src)) this.bytes.set(dest, new Uint8Array(this.bytes.get(src)));
  }
  async copyTree(srcDir, destDir) {
    const prefix = srcDir.endsWith("/") ? srcDir : `${srcDir}/`;
    const destPrefix = destDir.endsWith("/") ? destDir : `${destDir}/`;
    for (const store of [this.json, this.text, this.bytes]) {
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          const relative = key.slice(prefix.length);
          store.set(destPrefix + relative, store.get(key));
        }
      }
    }
  }
  async removeFile(file) {
    return this.remove(file, false);
  }
  async remove(file, recursive = false) {
    for (const store of [this.json, this.text, this.bytes]) {
      if (recursive) {
        for (const key of [...store.keys()]) if (key === file || key.startsWith(file + "/")) store.delete(key);
      }
      else store.delete(file);
    }
  }
  async publishFilesAtomically(entries) {
    const destinations = [];
    for (const entry of entries || []) {
      const source = entry?.source;
      const destination = entry?.destination;
      if (!source || !destination) continue;
      let moved = false;
      for (const store of [this.json, this.text, this.bytes]) {
        if (!store.has(source)) continue;
        const value = store.get(source);
        store.set(destination, value instanceof Uint8Array ? new Uint8Array(value) : JSON.parse(JSON.stringify(value)));
        store.delete(source);
        moved = true;
        break;
      }
      if (!moved) throw new Error(`Missing staged file: ${source}`);
      destinations.push(destination);
    }
    return destinations;
  }
}

// Chat test helper
function withResolvedChatModel(llm) {
  llm.resolveConfig = values => ({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    ...(values || {})
  });
  llm.ensureConfiguredModel = async config => config;
  return llm;
}

function createTestContext() {
  const prefValues = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    fetch,
    crypto: {
      randomUUID: nodeCrypto.randomUUID
    },
    atob: value => Buffer.from(String(value), "base64").toString("binary"),
    btoa: value => Buffer.from(String(value), "binary").toString("base64"),
    PathUtils: {
      join: (...parts) => path.posix.join(...parts.map(part => String(part).replace(/\\/g, "/"))),
      parent: value => path.posix.dirname(String(value)),
      filename: value => path.posix.basename(String(value))
    },
    Zotero: {
      locale: "zh-CN",
      Profile: { dir: "/profile" },
      Prefs: {
        get: key => prefValues.get(key),
        set: (key, value) => prefValues.set(key, value),
        clear: key => prefValues.delete(key)
      },
      debug() {},
      logError(error) { throw error; },
      launchURL(url) { this.lastLaunchedURL = url; }
    },
    Services: {
      prefs: {
        prefHasUserValue: key => prefValues.has(key),
        getBranch: prefix => ({
          getChildList: () => [...prefValues.keys()]
            .filter(key => key.startsWith(prefix))
            .map(key => key.slice(prefix.length))
        })
      },
      io: {
        newURI(url) {
          const parsed = new URL(String(url || "").trim());
          const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
          return {
            spec: parsed.href,
            scheme,
            schemeIs(value) { return scheme === String(value || "").toLowerCase(); }
          };
        }
      }
    },
    Cc: {},
    Ci: {},
    IOUtils: {}
  };
  context.globalThis = context;
  vm.createContext(context);

  function load(relative) {
    const filename = path.join(root, relative);
    vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  }

  load("assets/vendor/pako/pako_inflate.min.js");
  load("assets/vendor/pdf-lib/pdf-lib.min.js");
  load("src/ported-core.js");

  for (const file of [
    "src/release-notes.js",
    "src/utils.js",
    "src/storage.js",
    "src/secrets.js",
    "src/http.js",
    "src/markdown.js",
    "src/mindmap.js",
    "src/mindmap-v2.js",
    "src/flowchart.js",
    "src/mineru.js",
    "src/llm.js",
    "src/edge-local-translation.js",
    "src/web-machine-translation.js",
    "src/translation.js",
    "src/layout.js",
    "src/chat.js",
    "src/pipeline.js",
    "src/controller.js"
  ]) load(file);

  return {
    assert,
    fs,
    path,
    root,
    prefValues,
    context,
    zlib,
    nodeCrypto,
    vm,
    crc32,
    zipU16,
    zipU32,
    zipU64,
    oneEntryZip,
    oneEntryZip64,
    MemoryStorage,
    withResolvedChatModel,
    ...context.LitMTrans,
    U: context.LitMTrans.Utils,
    M: context.LitMTrans.Markdown,
    H: context.LitMTrans.HTTP
  };
}

class TestReporter {
  constructor() {
    this.suites = [];
    this.totalTests = 0;
    this.totalFailed = 0;
    this.startTime = 0;
  }

  start() {
    this.startTime = performance.now();
    console.log("\n================ LitMTrans Runtime Test Suite ================");
  }

  reportSuite(name, results) {
    this.suites.push({ name, results });
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const totalDuration = results.reduce((acc, r) => acc + r.duration, 0);
    this.totalTests += results.length;
    this.totalFailed += failed;

    if (failed === 0) {
      console.log(`  ✔ [${name}] ${passed} passed (${totalDuration.toFixed(0)}ms)`);
    } else {
      console.error(`  ✖ [${name}] ${passed} passed, ${failed} failed (${totalDuration.toFixed(0)}ms)`);
      for (const res of results) {
        if (!res.ok) {
          console.error(`    - FAIL: ${res.testName}: ${res.error?.message || res.error}`);
          if (res.error?.stack) console.error(res.error.stack);
        }
      }
    }
  }

  finish() {
    const elapsed = ((performance.now() - this.startTime) / 1000).toFixed(2);
    console.log("==============================================================");
    if (this.totalFailed === 0) {
      console.log(`All ${this.suites.length} suites passed (${this.totalTests} tests, 0 failed, ${elapsed}s)`);
      console.log("All tests passed.");
    } else {
      console.error(`FAILED: ${this.totalFailed} of ${this.totalTests} tests failed across ${this.suites.length} suites (${elapsed}s)`);
      process.exitCode = 1;
    }
  }
}

async function runSuite(suiteName, testMap, env, reporter) {
  const results = [];
  for (const [testName, testFn] of Object.entries(testMap)) {
    const t0 = performance.now();
    try {
      await testFn(env);
      results.push({ testName, ok: true, duration: performance.now() - t0 });
    } catch (error) {
      results.push({ testName, ok: false, duration: performance.now() - t0, error });
      break;
    }
  }
  reporter.reportSuite(suiteName, results);
  if (results.some(r => !r.ok)) {
    throw results.find(r => !r.ok).error;
  }
}

module.exports = {
  createTestContext,
  TestReporter,
  runSuite
};
