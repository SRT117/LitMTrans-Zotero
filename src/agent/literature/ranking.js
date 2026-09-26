(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function normalizeTitle(value) { return String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
  function identifier(card) {
    const ids = card?.identifiers || {};
    return String(ids.doi || ids.arxiv || ids.pmid || card?.candidateID || card?.local?.documentID || normalizeTitle(card?.metadata?.title) || "").toLowerCase();
  }

  function scoreCandidate(card, query = "", options = {}) {
    const text = String(query || "").toLocaleLowerCase();
    const title = String(card?.metadata?.title || "").toLocaleLowerCase();
    const abstract = String(card?.summary?.abstract || "").toLocaleLowerCase();
    const tokens = text.split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 1);
    let score = Number(card?.score || 0);
    for (const token of tokens) {
      if (title.includes(token)) score += 8;
      if (abstract.includes(token)) score += 3;
      if (String(card?.metadata?.venue || "").toLocaleLowerCase().includes(token)) score += 1;
    }
    score += Math.min(4, Math.log10(Number(card?.discovery?.citationCount || 0) + 1));
    if (card?.discovery?.openAccess) score += 0.25;
    if (options.preferLocal && card?.local?.inZotero) score += 0.5;
    return Number(score.toFixed(4));
  }

  function dedupe(cards = []) {
    const output = new Map();
    for (const card of cards) {
      const key = identifier(card);
      if (!key) continue;
      const previous = output.get(key);
      if (!previous || Number(card.score || 0) > Number(previous.score || 0)) output.set(key, card);
    }
    const titleMap = new Map();
    for (const card of output.values()) {
      const title = normalizeTitle(card?.metadata?.title);
      const duplicate = title && titleMap.get(title);
      if (duplicate) {
        if (Number(card?.metadata?.year || 0) === Number(duplicate?.metadata?.year || 0) && !duplicate?.local?.inZotero && card?.local?.inZotero) {
          output.delete(identifier(duplicate));
          titleMap.set(title, card);
        }
      }
      else if (title) titleMap.set(title, card);
    }
    return [...output.values()];
  }

  Agent.LiteratureRanking = { scoreCandidate, dedupe, identifier, normalizeTitle };
})(this);
