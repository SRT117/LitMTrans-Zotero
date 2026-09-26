(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  const API_PROVIDERS = new Set([
    "deepseek", "oneapi", "openai_compatible", "gemini", "siliconflow", "zai", "openrouter"
  ]);

  function normalizedProvider(value) {
    try { return String(LitMTrans.Utils?.providerSpec?.(value)?.id || value || "").trim().toLowerCase(); }
    catch (_) { return String(value || "").trim().toLowerCase(); }
  }

  function publicProfile(profile) {
    if (!profile) return {
      available: false,
      provider: "",
      model: "",
      baseURL: "",
      source: "none",
      mode: "api",
      webInteractiveAvailable: false,
      webBackgroundAllowed: false,
      deepSeekWebConfigured: false,
      deepSeekWebRuntimeLoaded: false,
      reason: "没有可用的后台 API 配置"
    };
    const output = { ...profile };
    delete output.apiKey;
    return output;
  }

  function webRuntimeState(controller) {
    const settings = [];
    try { settings.push(controller?.llm?.getStoredSettings?.("translation") || {}); } catch (_) {}
    try { settings.push(controller?.llm?.getStoredSettings?.("chat") || {}); } catch (_) {}
    try { settings.push(controller?.getSettings?.() || {}); } catch (_) {}
    const deepSeekWebConfigured = settings.some(row => [
      row.provider,
      row.engine,
      row.chatEngine,
      row.translationEngine,
      ...Object.keys(row.providerProfiles || {})
    ].some(value => String(value || "").trim().toLowerCase() === "deepseek_web"));
    const runtimes = [...(controller?.tabs?.values?.() || [])];
    const deepSeekWebRuntimeLoaded = runtimes.some(runtime => Boolean(runtime?.deepSeekDriver || runtime?.deepSeekBrowser));
    return {
      deepSeekWebConfigured,
      deepSeekWebRuntimeLoaded,
      webInteractiveAvailable: deepSeekWebRuntimeLoaded,
      webBackgroundAllowed: false
    };
  }

  function candidate(controller, purpose, provider, values, source) {
    const U = LitMTrans.Utils;
    const canonical = normalizedProvider(provider);
    const spec = U?.providerSpec?.(canonical) || {};
    if (!API_PROVIDERS.has(canonical) || spec.webDriver || spec.webMachine || spec.localMachine) return null;
    const baseURL = U?.normalizeBaseURL?.(values?.baseURL || spec.defaultBaseURL || "", canonical) || String(values?.baseURL || spec.defaultBaseURL || "");
    const model = String(values?.model || spec.defaultModel || "").trim();
    const apiKey = String(controller?.secrets?.getLLMKey?.(canonical) || "").trim();
    if (!apiKey || !model) return null;
    const web = webRuntimeState(controller);
    return {
      available: true,
      purpose,
      provider: canonical,
      model,
      baseURL,
      apiKey,
      source,
      mode: "api",
      ...web
    };
  }

  function profileRows(settings, purpose) {
    const rows = [];
    const current = settings || {};
    if (current.provider) rows.push({ provider: current.provider, values: current, source: `${purpose}-current` });
    for (const [provider, values] of Object.entries(current.providerProfiles || {})) {
      rows.push({ provider, values: values || {}, source: `${purpose}-profile` });
    }
    return rows;
  }

  function resolveBackgroundAIProfile(controller, purpose = "translation") {
    const U = LitMTrans.Utils;
    const preferred = String(U?.getPref?.("agentBackgroundProvider", "auto") || "auto").trim().toLowerCase();
    const settingsByPurpose = [];
    try { settingsByPurpose.push({ purpose: "translation", settings: controller?.llm?.getStoredSettings?.("translation") || {} }); }
    catch (_) { settingsByPurpose.push({ purpose: "translation", settings: {} }); }
    try { settingsByPurpose.push({ purpose: "chat", settings: controller?.llm?.getStoredSettings?.("chat") || {} }); }
    catch (_) { settingsByPurpose.push({ purpose: "chat", settings: {} }); }

    const ordered = [];
    const requestedPurpose = purpose === "chat" ? "chat" : "translation";
    for (const row of settingsByPurpose) if (row.purpose === requestedPurpose) ordered.push(...profileRows(row.settings, row.purpose));
    for (const row of settingsByPurpose) if (row.purpose !== requestedPurpose) ordered.push(...profileRows(row.settings, row.purpose));

    let rows = ordered;
    if (preferred !== "auto") {
      rows = ordered.filter(row => normalizedProvider(row.provider) === normalizedProvider(preferred));
      if (!rows.length) {
        rows = [{ provider: preferred, values: {}, source: "agent-preference" }];
      }
    }
    const seen = new Set();
    for (const row of rows) {
      const key = `${normalizedProvider(row.provider)}\u241f${String(row.values?.baseURL || "")}\u241f${String(row.values?.model || "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const found = candidate(controller, requestedPurpose, row.provider, row.values, row.source);
      if (found) return found;
    }
    const web = webRuntimeState(controller);
    return {
      ...publicProfile(null),
      purpose: requestedPurpose,
      ...web,
      reason: preferred === "auto"
        ? "没有已配置 API Key 和模型的后台服务；DeepSeek Web 仅允许由用户可见交互使用"
        : `后台 API 服务商 ${preferred} 尚未配置可用的 API Key 和模型`
    };
  }

  Agent.resolveBackgroundAIProfile = resolveBackgroundAIProfile;
  Agent.publicBackgroundAIProfile = publicProfile;
})(this);
