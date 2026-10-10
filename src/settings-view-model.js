(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.AgentSettingsViewModel = {
    statusText(agent = {}) {
      if (!agent.enabled) return "未启用";
      if (!agent.server?.running && agent.server?.lastError) return agent.server.retrying ? "正在重试连接服务" : "连接服务未能启动";
      if (agent.connection?.connected) {
        const count = Number(agent.connection.count || 0);
        return count > 1 ? `已连接 · ${count}个AI助手` : `已连接 · ${agent.connection.clientName || "智能体"}`;
      }
      if (agent.server?.running) return "等待智能体连接";
      return "正在启动";
    },
    statusHint(agent = {}) {
      if (!agent.enabled) return "打开后，AI助手可以帮你查找和整理Zotero文献。";
      if (!agent.server?.running) {
        if (agent.server?.retrying) return "正在重试，请稍候。";
        if (agent.server?.lastError) return "请关闭其他 Zotero 实例，然后关闭再开启AI助手访问以重试。";
        return "正在启动连接服务，请稍候。";
      }
      if (agent.connection?.connected) return "已连接，可以直接让AI助手处理Zotero文献。";
      return "服务已准备好。复制一段话给你的AI助手即可完成连接。";
    },
    developerMode(agent = {}) { return String(agent.mode || "full") === "developer"; }
  };
})(this);
