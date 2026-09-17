export class LitMTransDeepSeekParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "LitMTrans:DeepSeek:contextmenu") return;
    try {
      const browser = this.browsingContext?.top?.embedderElement
        || this.browsingContext?.embedderElement
        || this.manager?.rootBrowsingContext?.embedderElement;
      
      let controller = null;
      const topWin = this.browsingContext?.topChromeWindow || browser?.ownerGlobal;
      if (topWin?.Zotero?.LitMTransController) {
        controller = topWin.Zotero.LitMTransController;
      }
      if (!controller && typeof Services !== "undefined" && Services.wm) {
        const winEnum = Services.wm.getEnumerator(null);
        while (winEnum.hasMoreElements()) {
          const w = winEnum.getNext();
          if (w?.Zotero?.LitMTransController) {
            controller = w.Zotero.LitMTransController;
            break;
          }
        }
      }
      if (!controller) return;

      let targetRuntime = null;
      for (const runtime of controller.tabs.values()) {
        if (browser && (runtime.deepSeekBrowser === browser || runtime.browser === browser)) {
          targetRuntime = runtime;
          break;
        }
      }
      if (!targetRuntime) {
        for (const runtime of controller.tabs.values()) {
          if (runtime.deepSeekBrowser && !runtime.deepSeekBrowser.hidden) {
            targetRuntime = runtime;
            break;
          }
        }
      }
      if (!targetRuntime && controller.tabs.size === 1) {
        targetRuntime = controller.tabs.values().next().value;
      }

      if (targetRuntime) {
        controller.openDeepSeekContextMenu(targetRuntime, message.data || {});
      }
    } catch (error) {
      try {
        dump(`[LitMTrans:DeepSeekParent] Error handling contextmenu: ${error?.message || error}\n`);
      } catch (_) {}
    }
  }
}
