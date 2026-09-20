var LitMTrans;
var LitMTransController;
var LitMTransChromeHandle;
var LitMTransDeepSeekActorError;
var LitMTransDeepSeekActorFile;
var LitMTransDeepSeekActorParentFile;
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

  try {
    ChromeUtils.importESModule("chrome://zotero/content/actors/ActorManager.mjs");
  } catch (_) {}

  const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  LitMTransChromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "litmtrans", ""]
  ]);

  LitMTransDeepSeekActorError = null;
  let actorRootURI = rootURI + "src/deepseek-web/";
  let actorFileName = "DeepSeekActorChild.sys.mjs";
  let actorParentFileName = "DeepSeekActorParent.sys.mjs";
  try {
    // 开发目录与 XPI 均从原包读取同一份模块，再使用相同的沙箱可读路径加载。
    {
      const actorDirectory = PathUtils.join(Zotero.Profile.dir, "chrome", "litmtrans-deepseek");
      await IOUtils.makeDirectory(actorDirectory, { createAncestors: true });
      actorFileName = `DeepSeekActorChild-${Services.uuid.generateUUID().toString().replace(/[{}]/g, "")}.sys.mjs`;
      actorParentFileName = `DeepSeekActorParent-${Services.uuid.generateUUID().toString().replace(/[{}]/g, "")}.sys.mjs`;
      const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
      const childChannel = NetUtil.newChannel({
        uri: actorRootURI + "DeepSeekActorChild.sys.mjs",
        loadUsingSystemPrincipal: true
      });
      const childSource = await Zotero.File.getContentsAsync(childChannel, "UTF-8");
      const parentChannel = NetUtil.newChannel({
        uri: actorRootURI + "DeepSeekActorParent.sys.mjs",
        loadUsingSystemPrincipal: true
      });
      const parentSource = await Zotero.File.getContentsAsync(parentChannel, "UTF-8");
      LitMTransDeepSeekActorFile = PathUtils.join(actorDirectory, actorFileName);
      await IOUtils.writeUTF8(LitMTransDeepSeekActorFile, childSource);
      LitMTransDeepSeekActorParentFile = PathUtils.join(actorDirectory, actorParentFileName);
      await IOUtils.writeUTF8(LitMTransDeepSeekActorParentFile, parentSource);
      actorRootURI = PathUtils.toFileURI(actorDirectory) + "/";
    }
    const resHandler = Services.io.getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    resHandler.setSubstitution("litmtrans-deepseek-actors", Services.io.newURI(actorRootURI));
  } catch (resErr) {
    LitMTransDeepSeekActorError = String(resErr);
    litmtransLog(`setSubstitution failed: ${resErr}`);
  }

  try {
    ChromeUtils.unregisterWindowActor("LitMTransDeepSeek");
  } catch (_) {}

  // ESM 缓存通过 UUID 唯一文件名破除，不附加非法字符 query。
  const childURI = `resource://litmtrans-deepseek-actors/${actorFileName}`;
  const parentURI = `resource://litmtrans-deepseek-actors/${actorParentFileName}`;
  litmtransLog(`Register DeepSeek actor: ${childURI}`);
  try {
    if (LitMTransDeepSeekActorError) throw new Error(LitMTransDeepSeekActorError);
    ChromeUtils.registerWindowActor("LitMTransDeepSeek", {
      child: {
        esModuleURI: childURI,
        events: {
          contextmenu: { capture: true, mozSystemGroup: true }
        }
      },
      parent: {
        esModuleURI: parentURI,
      },
      matches: [
        "https://chat.deepseek.com/*",
        "https://*.deepseek.com/*"
      ],
      allFrames: true,
    });
    litmtransLog("LitMTransDeepSeek actor registered");
  } catch (actorErr) {
    LitMTransDeepSeekActorError = String(actorErr);
    litmtransLog(`registerWindowActor failed: ${actorErr}`);
  }

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
    "src/caj-converter.js",
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
    "src/deepseek-web/stream.js",
    "src/deepseek-web/pdf-pages.js",
    "src/deepseek-web/driver.js",
    "src/deepseek-web/provider.js",
    "src/controller.js"
  ];
  for (const script of scripts) {
    Services.scriptloader.loadSubScript(rootURI + script);
  }
  LitMTrans.DeepSeekWeb.actorRegistrationError = LitMTransDeepSeekActorError;

  LitMTrans.Utils.migrateLegacyPreferences();
  LitMTrans.Utils.repairSharedChatModelPreference();
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
  try {
    ChromeUtils.unregisterWindowActor("LitMTransDeepSeek");
  } catch (_) {}
  try {
    const resHandler = Services.io.getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    resHandler.setSubstitution("litmtrans-deepseek-actors", null);
  } catch (_) {}
  if (LitMTransDeepSeekActorFile) {
    try {
      await IOUtils.remove(LitMTransDeepSeekActorFile, { ignoreAbsent: true });
    } catch (error) { Zotero.logError(error); }
    LitMTransDeepSeekActorFile = null;
  }
  if (LitMTransDeepSeekActorParentFile) {
    try {
      await IOUtils.remove(LitMTransDeepSeekActorParentFile, { ignoreAbsent: true });
    } catch (error) { Zotero.logError(error); }
    LitMTransDeepSeekActorParentFile = null;
  }
  if (LitMTransChromeHandle) {
    LitMTransChromeHandle.destruct();
    LitMTransChromeHandle = null;
  }
}

function uninstall() {
  litmtransLog("Uninstalled");
}
