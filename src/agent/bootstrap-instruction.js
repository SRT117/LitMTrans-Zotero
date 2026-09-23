(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function buildAgentBootstrapInstruction(endpoint, serverName = "litmtrans", currentCapabilities = {}, _detectedClient = "") {
    const url = String(endpoint || "").trim();
    const name = String(serverName || "litmtrans").trim() || "litmtrans";
    if (!url) throw new Error("LitMTrans 尚未启动本地服务");
    const toolCount = Number(currentCapabilities?.toolCount || currentCapabilities?.tools?.length || 0) || 0;
    return [
      "请把当前 Zotero 里的 LitMTrans 接入你自己已有的智能工具配置，并使用你当前环境支持的官方方式完成连接。",
      `服务名称固定为 ${name}，连接地址为 ${url}。请直接按你当前客户端的能力完成配置，不要让我手工编辑配置文件。`,
      "请保留所有已有服务（尤其是 zotero-mcp），只新增或更新名为 litmtrans 的这一项；不要删除、改名或覆盖其他服务。",
      "完成后连接 LitMTrans，并调用 litmtrans_get_capabilities 验证；如果连接失败，请告诉我下一步该做什么。",
      toolCount ? `当前服务预计提供约 ${toolCount} 个工具；验证时以实际返回为准。` : "连接后以 litmtrans_get_capabilities 返回的实际能力为准。"
    ].join("\n");
  }

  Agent.buildAgentBootstrapInstruction = buildAgentBootstrapInstruction;
})(this);
