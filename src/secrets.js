(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;

  class Secrets {
    constructor() {
      this.origin = "chrome://litmtrans";
      this.realm = "LitMTrans";
      this.legacyOrigin = "chrome://ai-literature-translator";
      this.legacyRealm = "AI Literature Translator";
      this.fallbackPrefix = "secretFallback.";
      this._cache = new Map();
    }

    _findAll(origin = this.origin, realm = this.realm) {
      try {
        return Services.logins.findLogins(origin, null, realm) || [];
      }
      catch (_) {
        try {
          return Services.logins.findLogins(origin, "", realm) || [];
        }
        catch (_) {
          return [];
        }
      }
    }

    _fallbackGet(name, legacy = false) {
      const encoded = String((legacy
        ? Zotero.Prefs.get(LitMTrans.Constants.LEGACY_PREF_BRANCH + this.fallbackPrefix + name, true)
        : U.getPref(this.fallbackPrefix + name, "")) || "");
      if (!encoded) return "";
      if (encoded.startsWith("sdr:")) {
        try {
          const ring = Cc["@mozilla.org/security/sdr;1"].getService(Ci.nsISecretDecoderRing);
          const value = String(ring.decryptString(encoded.slice(4)) || "");
          if (legacy && value) this._fallbackSet(name, value);
          return value;
        }
        catch (error) {
          Zotero.debug(`[LitMTrans] Cannot decrypt secure preference: ${error}`);
          return "";
        }
      }
      // Migrate values written by early plugin builds, which only obscured the
      // secret with Base64. They are immediately re-encrypted with Firefox's
      // native secret decoder ring and the legacy preference is overwritten.
      try {
        const legacy = decodeURIComponent(escape(U.base64Decode(encoded)));
        if (legacy) this._fallbackSet(name, legacy);
        return legacy;
      }
      catch (_) {
        return "";
      }
    }

    _fallbackSet(name, value) {
      if (!value) {
        U.clearPref(this.fallbackPrefix + name);
        return true;
      }
      try {
        const ring = Cc["@mozilla.org/security/sdr;1"].getService(Ci.nsISecretDecoderRing);
        const encoded = ring.encryptString(String(value));
        U.setPref(this.fallbackPrefix + name, `sdr:${encoded}`);
        return true;
      }
      catch (error) {
        // Never silently downgrade API keys to reversible Base64/plain-text
        // preferences. A failed secure write is reported to the caller.
        Zotero.debug(`[LitMTrans] Secure preference unavailable: ${error}`);
        U.clearPref(this.fallbackPrefix + name);
        return false;
      }
    }

    get(name) {
      const username = String(name || "");
      if (this._cache.has(username)) return this._cache.get(username);
      let password = "";
      const login = this._findAll().find(entry => entry.username === username);
      if (login?.password) {
        password = String(login.password);
      }
      else {
        const fallback = this._fallbackGet(username);
        if (fallback) password = String(fallback);
        else {
          const legacyFallback = this._fallbackGet(username, true);
          if (legacyFallback) password = String(legacyFallback);
          else {
            const legacy = this._findAll(this.legacyOrigin, this.legacyRealm)
              .find(entry => entry.username === username);
            if (legacy?.password) {
              password = String(legacy.password);
              this.set(username, password);
            }
          }
        }
      }
      this._cache.set(username, password);
      return password;
    }

    has(name) {
      return Boolean(this.get(name));
    }

    set(name, value) {
      const username = String(name || "");
      const password = String(value || "").trim();
      const existing = this._findAll().filter(entry => entry.username === username);
      try {
        for (const entry of existing) Services.logins.removeLogin(entry);
        if (password) {
          const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
          login.init(this.origin, null, this.realm, username, password, "", "");
          Services.logins.addLogin(login);
        }
        this._fallbackSet(username, "");
        this._cache.set(username, password);
        return true;
      }
      catch (error) {
        Zotero.debug(`[LitMTrans] Login Manager unavailable: ${error}`);
        const saved = this._fallbackSet(username, password);
        if (saved) this._cache.set(username, password);
        else this._cache.delete(username);
        return saved;
      }
    }

    remove(name) {
      const username = String(name || "");
      this._cache.delete(username);
      try {
        for (const entry of this._findAll().filter(entry => entry.username === username)) {
          Services.logins.removeLogin(entry);
        }
      }
      catch (_) {}
      this._fallbackSet(username, "");
    }

    llmKeyName(providerID) {
      return `llm:${String(providerID || "oneapi").toLowerCase()}`;
    }

    getLLMKey(providerID) {
      return this.get(this.llmKeyName(providerID));
    }

    setLLMKey(providerID, value) {
      return this.set(this.llmKeyName(providerID), value);
    }

    removeLLMKey(providerID) {
      this.remove(this.llmKeyName(providerID));
    }

    getMinerUToken() {
      return this.get("mineru");
    }

    setMinerUToken(value) {
      return this.set("mineru", String(value || "").trim().replace(/^Bearer\s+/i, ""));
    }

    removeMinerUToken() {
      this.remove("mineru");
    }
  }

  LitMTrans.Secrets = Secrets;
})(this);
