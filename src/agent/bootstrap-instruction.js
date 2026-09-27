(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function buildAgentBootstrapInstruction(endpoint, serverName = "zotero-litmtrans", currentCapabilities = {}, _detectedClient = "") {
    const url = String(endpoint || "").trim();
    const name = String(serverName || "zotero-litmtrans").trim() || "zotero-litmtrans";
    if (!url) throw new Error("LitMTrans 尚未启动本地服务");
    const toolCount = Number(currentCapabilities?.toolCount || currentCapabilities?.tools?.length || 0) || 0;
    return [
      "请把当前Zotero里的LitMTrans接入你自己已有的智能工具配置，并使用你当前环境支持的官方方式完成连接。",
      `服务名称固定为 ${name}，连接地址为 ${url}。请直接按你当前客户端的能力完成配置，不要让我手工编辑配置文件。`,
      `请保留其他已有服务，只新增或更新名为 ${name} 的这一项；若已有同一连接地址的 litmtrans 项，请将它改名为 ${name}，避免重复连接。`,
      "完成后连接LitMTrans，并调用litmtrans_get_capabilities验证；如果连接失败，请告诉我下一步该做什么。",
      toolCount ? `当前服务预计提供约 ${toolCount} 个工具；验证时以实际返回为准。` : "连接后以litmtrans_get_capabilities返回的实际能力为准。连接成功后向我介绍可用的功能，如果当前会话提示工具未就绪或未启用，可直接新建一个对话即可自动生效。"
    ].join("\n");
  }

  Agent.buildAgentBootstrapInstruction = buildAgentBootstrapInstruction;
})(this);
