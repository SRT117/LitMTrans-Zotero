var LitMTransControllerPreferences = {
  settings: null,
  referencePaths: [],

  $(id) { return document.getElementById(`litmtrans-pref-${id}`); },

  controller() {
    // Preference panes run in their own Zotero window. The controller lives
    // on the main Zotero window in several supported host versions.
    const mainWindow = Zotero?.getMainWindow?.() || null;
    return mainWindow?.LitMTransController
      || Zotero?.LitMTransController
      || mainWindow?.Zotero?.LitMTransController
      || window.opener?.Zotero?.LitMTransController
      || null;
  },

  option(value, label = value) {
    const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
    option.value = String(value || "");
    option.textContent = String(label || value || "");
    return option;
  },

  setSelectOptions(select, values, selected = "") {
    const wanted = String(selected || "").trim();
    const rows = (values || []).map(value => typeof value === "string" ? { id: value, label: value } : value)
      .filter(value => String(value?.id || "").trim());
    if (wanted && !rows.some(value => String(value.id) === wanted)) rows.unshift({ id: wanted, label: wanted });
    select.replaceChildren(...rows.map(value => this.option(value.id, value.label || value.id)));
    select.value = wanted;
  },

  setSelectValue(select, value) {
    const wanted = String(value || "").trim();
    if (wanted && ![...select.options].some(option => option.value === wanted)) select.appendChild(this.option(wanted));
    select.value = wanted;
  },

  bindLanguagePicker(inputID, pickerID) {
    const input = this.$(inputID);
    const picker = this.$(pickerID);
    picker.addEventListener("change", () => {
      const selected = String(picker.value || "").trim();
      if (!selected) return;
      input.value = selected;
      picker.selectedIndex = 0;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
    });
  },

  isWebMachineTranslationProvider(value) {
    const id = String(value || "").trim().toLowerCase();
    return id === "free_machine"
      || id === "google_free"
      || id === "bing_free"
      || id === "machine_translate"
      || id === "edge_local"
      || id.endsWith("_web");
  },

  isEdgeLocalTranslationProvider(value) {
    return String(value || "").trim().toLowerCase() === "edge_local";
  },

  isOfficialDeepSeekTranslation() {
    return String(this.$("provider")?.value || "").trim().toLowerCase() === "deepseek"
      && /(?:^|:\/\/)api\.deepseek\.com(?:[/:]|$)/i.test(String(this.$("base-url")?.value || "").trim());
  },

  updateProviderLabel(prefix = "") {
    const provider = String(this.$(`${prefix}provider`)?.value || "").trim().toLowerCase();
    const label = this.$(`${prefix}provider-label`);
    if (!label) return;
    label.replaceChildren("服务商");
    if (this.isWebMachineTranslationProvider(provider) && !this.isEdgeLocalTranslationProvider(provider)) {
      label.append("（外网google，国内自动切换bing，bing很慢）");
      return;
    }
    const providerLinks = {
      deepseek: ["https://platform.deepseek.com/api_keys", "DeepSeek key官网"],
      gemini: ["https://aistudio.google.com/api-keys", "Google AI Studio官网"],
      openrouter: ["https://openrouter.ai/workspaces/default/keys", "OpenRouter官网"],
      zai: ["https://open.bigmodel.cn/apikey/platform", "Z.ai key官网"]
    };
    const [href, text] = providerLinks[provider] || [];
    if (!href) return;
    const link = document.createElementNS("http://www.w3.org/1999/xhtml", "a");
    link.href = href;
    link.dataset.externalUrl = link.href;
    link.textContent = text;
    label.append("（", link, "）");
  },

  updateDeepSeekFastLayoutControl() {
    const group = this.$("deepseek-fast-layout-group");
    const available = this.isOfficialDeepSeekTranslation();
    group.hidden = !available;
  },

  syncChatSettingsFromTranslation() {
    const provider = this.$("provider").value || "oneapi";
    const chatProvider = this.$("chat-provider");
    chatProvider.value = provider;
    chatProvider.dataset.activeProvider = provider;
    this.$("chat-base-url").value = this.$("base-url").value;
    this.setSelectOptions(this.$("chat-model"), [], this.$("model").value);
    this.$("chat-thinking-mode").value = this.$("thinking-mode").value;
    this.setSelectValue(this.$("chat-reasoning-effort"), this.$("reasoning-effort").value);
    this.$("chat-api-key").value = this.$("api-key").value;
    this.updateProviderLabel("chat-");
  },

  updateTranslationContextControls(disabled) {
    const hint = this.$("reference-list-empty-hint");
    if (hint) {
      hint.textContent = disabled
        ? "免费或本地机器翻译不使用参考文件和自定义翻译要求；切换回模型服务后可继续使用。"
        : "可添加同领域、同目标语言的文献作为参考。模型会参考其中的术语和行文风格，但始终以当前文献的原意为准。支持PDF、Office文档、Markdown、文本和图片。";
    }
    for (const id of [
      "reference-list", "add-reference", "edit-custom-translation-instruction",
      "remove-reference", "clear-reference", "custom-translation-instruction"
    ]) {
      const node = this.$(id);
      if (node) node.disabled = disabled;
    }
  },

  updateWebMachineTranslationSettings({ previousProvider = null, syncChatMode = false } = {}) {
    const provider = this.$("provider").value || "";
    const enabled = this.isWebMachineTranslationProvider(provider);
    const edgeLocal = this.isEdgeLocalTranslationProvider(provider);
    const baseURL = this.$("base-url");
    const model = this.$("model");
    const key = this.$("api-key");
    const refresh = this.$("refresh-models");
    const thinkingMode = this.$("thinking-mode");
    const reasoningEffort = this.$("reasoning-effort");
    for (const input of [baseURL, model, key, refresh, thinkingMode, reasoningEffort]) if (input) input.disabled = enabled;
    this.$("machine-source-language-group").hidden = !edgeLocal;
    this.updateTranslationContextControls(enabled);
    if (enabled) {
      baseURL.value = "";
      baseURL.placeholder = `${edgeLocal ? "Edge本地翻译" : "联网翻译"}不需要API地址`;
      key.value = "";
      key.placeholder = `${edgeLocal ? "Edge本地翻译" : "联网翻译"}不需要API密钥`;
      model.replaceChildren();
      const option = this.option("", `${edgeLocal ? "Edge本地翻译" : "联网翻译"}不需要模型`);
      model.appendChild(option);
      model.value = "";
      if (thinkingMode) thinkingMode.value = "default";
      if (reasoningEffort) this.setSelectValue(reasoningEffort, "default");
    }
    else {
      baseURL.placeholder = "https://api.example.com/v1";
      key.placeholder = "未配置";
    }
    if (syncChatMode) {
      const wasWeb = this.isWebMachineTranslationProvider(previousProvider);
      if (enabled) this.$("chat-uses-translation-model").checked = false;
      else if (wasWeb) {
        this.$("chat-uses-translation-model").checked = true;
        this.syncChatSettingsFromTranslation();
      }
    }
  },

  async init() {
    const root = document.getElementById("litmtrans-preferences-root");
    if (!root) return;
    if (root.dataset.initialized === "true") return this.load();
    root.dataset.initialized = "true";
    this.bind();
    root.addEventListener("showing", () => void this.load());
    await this.load();
  },

  populateProviders(settings) {
    for (const [id, chat] of [["provider", false], ["chat-provider", true]]) {
      const select = this.$(id);
      select.replaceChildren(...(settings.providers || []).filter(spec => !chat || spec.supportsChat !== false).map(spec => {
        const option = this.option(spec.id, spec.name);
        option.dataset.baseURL = spec.defaultBaseURL || "";
        option.dataset.model = spec.defaultModel || "";
        option.dataset.chatModel = spec.chatDefaultModel || "";
        return option;
      }));
    }
  },

  async load() {
    const controller = this.controller();
    if (!controller) return this.message("LitMTrans设置暂时无法加载，请关闭设置窗口后重试。", true);
    try {
      const settings = this.settings = controller.getSettings();
      document.getElementById("litmtrans-pref-advanced").open = false;
      this.populateProviders(settings);
      this.$("provider").value = settings.translationProvider || settings.provider || "deepseek";
      this.$("provider").dataset.activeProvider = this.$("provider").value;
      this.$("base-url").value = settings.translationBaseURL || settings.baseURL || "";
      this.setSelectOptions(this.$("model"), [], settings.translationModel || settings.model || "");
      this.$("thinking-mode").value = settings.translationThinkingMode || settings.thinkingMode || "default";
      this.setSelectValue(this.$("reasoning-effort"), settings.translationReasoningEffort || settings.reasoningEffort || "default");
      this.$("deepseek-fast-layout").checked = Boolean(settings.deepseekFastLayoutTranslation);
      this.$("api-key").value = settings.apiKey || "";
      this.$("chat-uses-translation-model").checked = settings.chatUsesTranslationModel !== false;
      this.$("chat-provider").value = settings.chatProvider || "deepseek";
      this.$("chat-provider").dataset.activeProvider = this.$("chat-provider").value;
      this.$("chat-base-url").value = settings.chatBaseURL || "";
      this.setSelectOptions(this.$("chat-model"), [], settings.chatModel || "");
      this.$("chat-thinking-mode").value = settings.chatThinkingMode || "default";
      this.setSelectValue(this.$("chat-reasoning-effort"), settings.chatReasoningEffort || "default");
      this.$("chat-api-key").value = settings.chatAPIKey || "";
      this.$("target-language").value = settings.targetLanguage || "简体中文";
      this.$("machine-source-language").value = settings.machineSourceLanguage || "英文";
      this.$("translation-mode").value = settings.translationMode || "full_context";
      this.$("custom-translation-instruction").value = settings.customTranslationInstruction || "";
      this.updateCustomTranslationInstruction();
      this.referencePaths = Array.isArray(settings.translationReferencePaths) ? [...settings.translationReferencePaths] : [];
      this.renderReferencePaths();
      this.$("mineru-token").value = settings.mineruToken || "";
      this.$("mineru-model").value = "vlm";
      this.$("key-points-prompt").value = settings.effectiveKeyPointsPrompt || settings.keyPointsDefaultPrompt || "";
      this.updateWebMachineTranslationSettings();
      this.updateDeepSeekFastLayoutControl();
      this.updateProviderLabel();
      this.updateProviderLabel("chat-");
      this.updateChatModelSectionVisibility();
      this.message("");
    }
    catch (error) { this.message(error.message || String(error), true); }
  },

  updateChatModelSectionVisibility() {
    if (this.isWebMachineTranslationProvider(this.$("provider").value)) {
      this.$("chat-uses-translation-model").checked = false;
    }
    const shared = this.$("chat-uses-translation-model").checked;
    document.getElementById("litmtrans-pref-chat-model-group").hidden = shared;
    document.querySelector(".litmtrans-pref-board")?.classList.toggle("litmtrans-shared-chat-model", shared);
  },

  updateCustomTranslationInstruction(forceOpen = false) {
    const input = this.$("custom-translation-instruction");
    const group = document.getElementById("litmtrans-pref-custom-translation-instruction-group");
    const button = this.$("edit-custom-translation-instruction");
    const hasInstruction = Boolean(input.value.trim());
    group.hidden = !forceOpen && !hasInstruction;
    button.textContent = hasInstruction ? "编辑翻译要求" : "添加自定义翻译指令";
  },

  payload() {
    const translationProvider = this.$("provider").value;
    const chatProvider = this.$("chat-provider").value;
    const sharedChatModel = !this.isWebMachineTranslationProvider(translationProvider)
      && this.$("chat-uses-translation-model").checked;
    return {
      translationProvider, translationBaseURL: this.$("base-url").value.trim(), translationModel: this.$("model").value.trim(),
      translationThinkingMode: this.$("thinking-mode").value, translationReasoningEffort: this.$("reasoning-effort").value,
      deepseekFastLayoutTranslation: this.isOfficialDeepSeekTranslation()
        ? this.$("deepseek-fast-layout").checked
        : Boolean(this.settings?.deepseekFastLayoutTranslation),
      translationProviderProfiles: { ...(this.settings?.translationProviderProfiles || {}), [translationProvider]: { baseURL: this.$("base-url").value.trim(), model: this.$("model").value.trim(), thinkingMode: this.$("thinking-mode").value, reasoningEffort: this.$("reasoning-effort").value } },
      chatUsesTranslationModel: sharedChatModel,
      chatProvider, chatBaseURL: this.$("chat-base-url").value.trim(), chatModel: this.$("chat-model").value.trim(),
      chatThinkingMode: this.$("chat-thinking-mode").value, chatReasoningEffort: this.$("chat-reasoning-effort").value,
      chatProviderProfiles: { ...(this.settings?.chatProviderProfiles || {}), [chatProvider]: { baseURL: this.$("chat-base-url").value.trim(), model: this.$("chat-model").value.trim(), thinkingMode: this.$("chat-thinking-mode").value, reasoningEffort: this.$("chat-reasoning-effort").value } },
      mineruModel: "vlm", targetLanguage: this.$("target-language").value.trim(), machineSourceLanguage: this.$("machine-source-language").value.trim(), translationMode: this.$("translation-mode").value,
      translationReferencePaths: [...this.referencePaths], customTranslationInstruction: this.$("custom-translation-instruction").value.trim(),
      keyPointsPrompt: this.$("key-points-prompt").value.trim() === String(this.settings?.keyPointsDefaultPrompt || "").trim() ? "" : this.$("key-points-prompt").value
    };
  },

  async save() {
    try { this.settings = this.controller().saveSettings(this.payload()); await this.load(); this.message("设置已保存"); }
    catch (error) { this.message(error.message || String(error), true); }
  },

  async refreshModels(purpose) {
    const chat = purpose === "chat";
    const button = this.$(chat ? "refresh-chat-models" : "refresh-models");
    try {
      button.disabled = true;
      const models = await this.controller().listModels({ purpose, provider: this.$(chat ? "chat-provider" : "provider").value, baseURL: this.$(chat ? "chat-base-url" : "base-url").value.trim(), apiKey: this.$(chat ? "chat-api-key" : "api-key").value.trim(), currentModel: this.$(chat ? "chat-model" : "model").value.trim() });
      const input = this.$(chat ? "chat-model" : "model");
      this.setSelectOptions(input, models, input.value);
      this.message(`模型列表已更新，共${models.length}个`);
    }
    catch (error) { this.message(error.message || String(error), true); }
    finally { button.disabled = false; }
  },

  renderReferencePaths() {
    const list = this.$("reference-list");
    list.replaceChildren(...this.referencePaths.map(path => {
      const option = this.option(path, String(path).replace(/\\/g, "/").split("/").pop() || path); option.title = path; return option;
    }));
    list.dataset.hasItems = this.referencePaths.length ? "true" : "false";
  },

  message(text, error = false) { const node = this.$("message"); node.textContent = String(text || ""); node.classList.toggle("error", error); },

  providerChanged(prefix) {
    const chat = prefix === "chat-";
    const provider = this.$(`${prefix}provider`);
    const profilesKey = chat ? "chatProviderProfiles" : "translationProviderProfiles";
    const previous = String(provider.dataset.activeProvider || "");
    if (previous && this.settings) {
      const model = this.$(`${prefix}model`);
      this.settings[profilesKey] = {
        ...(this.settings[profilesKey] || {}),
        [previous]: {
          baseURL: this.$(`${prefix}base-url`).value.trim(),
          model: model.value.trim(),
          thinkingMode: this.$(`${prefix}thinking-mode`).value,
          reasoningEffort: this.$(`${prefix}reasoning-effort`).value
        }
      };
    }
    const profile = this.settings?.[profilesKey]?.[provider.value] || {};
    const selected = provider.selectedOptions[0];
    this.$(`${prefix}base-url`).value = profile.baseURL || selected?.dataset.baseURL || "";
    this.setSelectOptions(this.$(`${prefix}model`), [], profile.model || (chat ? selected?.dataset.chatModel : selected?.dataset.model) || "");
    this.$(`${prefix}thinking-mode`).value = profile.thinkingMode || "default";
    this.setSelectValue(this.$(`${prefix}reasoning-effort`), profile.reasoningEffort || "default");
    provider.dataset.activeProvider = provider.value;
    this.$(`${prefix}api-key`).value = this.controller().getProviderAPIKey(provider.value).apiKey || "";
    if (!chat) {
      this.updateWebMachineTranslationSettings({ previousProvider: previous, syncChatMode: true });
      this.updateDeepSeekFastLayoutControl();
      this.updateChatModelSectionVisibility();
    }
    this.updateProviderLabel(prefix);
    if (!chat && !this.isWebMachineTranslationProvider(provider.value) && this.$("chat-uses-translation-model").checked) {
      this.syncChatSettingsFromTranslation();
    }
    if (chat && !this.isWebMachineTranslationProvider(provider.value)) this.updateChatModelSectionVisibility();
  },

  bind() {
    document.addEventListener("click", event => {
      const link = event.target?.closest?.("a");
      if (!link) return;
      const rawUrl = link.dataset.externalUrl || link.getAttribute("href") || link.href;
      if (!rawUrl || rawUrl.startsWith("#") || rawUrl.startsWith("javascript:")) return;
      let targetUrl = rawUrl;
      if (/^doi:\s*/i.test(targetUrl)) targetUrl = "https://doi.org/" + targetUrl.replace(/^doi:\s*/i, "");
      if (/^https?:\/\//i.test(targetUrl)) {
        event.preventDefault();
        try { this.controller().openExternalURL(targetUrl); }
        catch (error) { this.message(error.message || "无法打开官网", true); }
      }
    });
    this.bindLanguagePicker("target-language", "target-language-picker");
    this.bindLanguagePicker("machine-source-language", "machine-source-language-picker");
    this.$("open-token-guide").addEventListener("click", async () => {
      try { await this.controller().openTokenGuide(); }
      catch (error) { this.message(error.message || "无法打开令牌创建指南", true); }
    });
    this.$("save").addEventListener("click", () => this.save());
    this.$("refresh-models").addEventListener("click", () => this.refreshModels("translation"));
    this.$("refresh-chat-models").addEventListener("click", () => this.refreshModels("chat"));
    this.$("chat-uses-translation-model").addEventListener("change", () => {
      if (this.isWebMachineTranslationProvider(this.$("provider").value)) {
        this.$("chat-uses-translation-model").checked = false;
      }
      this.updateChatModelSectionVisibility();
    });
    this.$("provider").addEventListener("change", () => this.providerChanged(""));
    this.$("base-url").addEventListener("input", () => this.updateDeepSeekFastLayoutControl());
    this.$("deepseek-fast-layout").addEventListener("change", () => this.updateDeepSeekFastLayoutControl());
    this.$("chat-provider").addEventListener("change", () => this.providerChanged("chat-"));
    for (const [id, provider] of [["api-key", "provider"], ["chat-api-key", "chat-provider"]]) this.$(id).addEventListener("change", () => this.controller().saveProviderAPIKey(this.$(provider).value, this.$(id).value.trim()));
    this.$("mineru-token").addEventListener("change", () => this.controller().saveMinerUToken(this.$("mineru-token").value.trim()));
    this.$("restore-key-points-prompt").addEventListener("click", () => { this.$("key-points-prompt").value = this.settings?.keyPointsDefaultPrompt || ""; });
    this.$("add-reference").addEventListener("click", async () => { try { this.referencePaths = await this.controller().selectReferenceFiles(window, this.referencePaths); this.renderReferencePaths(); } catch (error) { this.message(error.message || String(error), true); } });
    this.$("remove-reference").addEventListener("click", () => { const selected = new Set([...this.$("reference-list").selectedOptions].map(option => option.value)); this.referencePaths = this.referencePaths.filter(path => !selected.has(path)); this.renderReferencePaths(); });
    this.$("edit-custom-translation-instruction").addEventListener("click", () => { this.updateCustomTranslationInstruction(true); this.$("custom-translation-instruction").focus(); });
    this.$("custom-translation-instruction").addEventListener("input", () => this.updateCustomTranslationInstruction(true));
    this.$("clear-reference").addEventListener("click", () => { this.referencePaths = []; this.$("custom-translation-instruction").value = ""; this.renderReferencePaths(); this.updateCustomTranslationInstruction(); });
  }
};

// Zotero loads registered preference scripts before it inserts the pane
// fragment. Listen in the capture phase so the sandbox receives the synthetic
// non-bubbling load event that Zotero dispatches on the imported root node.
// An inline `onload` cannot reliably resolve variables from the pane sandbox.
const initializeLitMTransPreferences = event => {
  if (event.target?.id !== "litmtrans-preferences-root") return;
  const initialization = LitMTransControllerPreferences.init();
  if (typeof event.waitUntil === "function") event.waitUntil(initialization);
  else void initialization;
};
document.addEventListener("load", initializeLitMTransPreferences, true);
