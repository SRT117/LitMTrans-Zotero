import { defineConfig } from "zotero-plugin-scaffold";

// The PowerShell build script produces dist/addon. Serving that directory
// keeps local verification aligned with the XPI without touching a normal
// Zotero profile.
export default defineConfig({
  // The Windows build script stages the flat src/ directory into the
  // conventional XPI layout. Restart the validation task after source edits.
  source: ".zotero-dev/reload-disabled",
  dist: "dist",
  name: "LitMTrans",
  // This ID is public and permanent. Changing it would break updates.
  id: "litmtrans@srt117.github.io",
  namespace: "litmtrans",
  xpiName: "litmtrans",
  build: {
    assets: [],
    makeManifest: { enable: false },
    prefs: { prefixPrefKeys: false, dts: false },
    fluent: { prefixFluentMessages: false, prefixLocaleFiles: false, ignore: [], dts: false },
    esbuildOptions: []
  },
  server: {
    devtools: false,
    startArgs: [],
    prefs: {
      "app.update.auto": false,
      "app.update.background.enabled": false,
      "app.update.enabled": false,
      "extensions.update.enabled": false,
      "extensions.zotero.sync.autoSync": false
    },
    // The local start script prepares the staged add-on with the update URL
    // required by Zotero 9 before it is installed for verification.
    asProxy: false,
    prebuild: false,
    createProfileIfMissing: true,
    hooks: {}
  }
});
