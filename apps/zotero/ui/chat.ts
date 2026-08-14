namespace LitMTransPort {
  export interface ZoteroChatBridge {
    open(documentID: string): void;
    focusComposer(): void;
    locate(quote: ReferenceQuote): void;
  }
  export function createZoteroChatBridge(value: ZoteroChatBridge): ZoteroChatBridge {
    if (!value || typeof value.open !== "function" || typeof value.focusComposer !== "function" || typeof value.locate !== "function") {
      throw new PortError("HOST_ADAPTER", "Zotero文档对话桥缺少 open/focusComposer/locate 方法");
    }
    return Object.freeze({
      open(documentID: string): void {
        const id = String(documentID || "").trim();
        if (!id) throw new PortError("HOST_ADAPTER", "打开文档对话时缺少 documentID");
        value.open(id);
      },
      focusComposer(): void { value.focusComposer(); },
      locate(quote: ReferenceQuote): void {
        if (!quote?.id) throw new PortError("HOST_ADAPTER", "引用定位缺少 quote.id");
        value.locate({ ...quote });
      }
    });
  }
}
