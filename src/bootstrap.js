var LitMTrans;
var LitMTransController;
var LitMTransChromeHandle;
// Explicit aliases: the bootstrap global is privileged but is not a regular
// browser Window. Do not rely on version-specific implicit Cc/Ci globals.
var Cc = Components.classes;
var Ci = Components.interfaces;
var Cu = Components.utils;

function litmtransLog(message) {
  try {
    Zotero.debug(`[LitMTrans] ${message}`);
  }
  catch (_) {}
}

function install() {
  litmtransLog("Installed");
}

async function startup({ id, version, rootURI }) {
  litmtransLog(`Starting ${version}`);
  await Zotero.initializationPromise;

  const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  LitMTransChromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "litmtrans", ""]
  ]);

  const scripts = [
    // Keep ZIP decompression independent from the host's nsIZipReader.
    // MinerU sometimes produces valid DEFLATE archives that that component
    // cannot extract on particular Firefox/Zotero builds.
    "assets/vendor/pako/pako_inflate.min.js",
    // MinerU accepts at most 200 PDF pages per upload. pdf-lib performs the
    // lossless page-copy split locally; no source document is sent elsewhere.
    "assets/vendor/pdf-lib/pdf-lib.min.js",
    "src/ported-core.js",
    "src/utils.js",
    "src/storage.js",
    "src/secrets.js",
    "src/http.js",
    "src/markdown.js",
    "src/mineru.js",
    "src/llm.js",
    "src/edge-local-translation.js",
    "src/web-machine-translation.js",
    "src/translation.js",
    "src/layout.js",
    "src/chat.js",
    "src/pipeline.js",
    "src/icon-reader.js",
    "src/controller.js"
  ];
  for (const script of scripts) {
    Services.scriptloader.loadSubScript(rootURI + script);
  }

  LitMTrans.Utils.migrateLegacyPreferences();
  LitMTransController = LitMTrans.createController({ id, version, rootURI });
  Zotero.LitMTransController = LitMTransController;
  await LitMTransController.init();

  Zotero.PreferencePanes.register({
    pluginID: id,
    paneID: "litmtrans-preferences",
    label: "LitMTrans",
    image: rootURI + "assets/icon.ico",
    src: rootURI + "src/preferences.xhtml",
    scripts: [rootURI + "src/preferences.js"],
    stylesheets: [rootURI + "src/preferences.css"]
  });

  LitMTransController.addToAllWindows();
}

function onMainWindowLoad({ window }) {
  LitMTransController?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  LitMTransController?.removeFromWindow(window);
}

async function shutdown(data, reason) {
  litmtransLog("Shutting down");
  try {
    await LitMTransController?.shutdown(reason);
  }
  catch (error) {
    Zotero.logError(error);
  }
  try {
    delete Zotero.LitMTransController;
  }
  catch (_) {}
  LitMTransController = undefined;
  LitMTrans = undefined;
  if (LitMTransChromeHandle) {
    LitMTransChromeHandle.destruct();
    LitMTransChromeHandle = null;
  }
}

function uninstall() {
  litmtransLog("Uninstalled");
}
