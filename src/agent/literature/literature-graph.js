(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function key(type, value) { return `${String(type || "")}:${String(value || "").trim().toLowerCase()}`; }

  class LiteratureGraph {
    constructor(options = {}) {
      this.nodes = new Map();
      this.edges = new Map();
      this.maxNodes = Math.max(100, Number(options.maxNodes || 20000));
    }

    node(type, value, data = {}) {
      const id = key(type, value);
      if (!id || id.endsWith(":")) return null;
      const previous = this.nodes.get(id) || { id, type: String(type), value: String(value), data: {} };
      const row = { ...previous, data: { ...previous.data, ...data } };
      this.nodes.set(id, row);
      if (this.nodes.size > this.maxNodes) this.nodes.delete(this.nodes.keys().next().value);
      return row;
    }

    edge(type, from, to, data = {}) {
      const source = typeof from === "string" ? from : key(from?.type, from?.value);
      const target = typeof to === "string" ? to : key(to?.type, to?.value);
      if (!source || !target) return null;
      const ensureNode = id => {
        if (this.nodes.has(id)) return this.nodes.get(id);
        const separator = id.indexOf(":");
        const typeName = separator > 0 ? id.slice(0, separator) : "unknown";
        const value = separator > 0 ? id.slice(separator + 1) : id;
        return this.node(typeName, value);
      };
      ensureNode(source);
      ensureNode(target);
      const id = `${type}:${source}:${target}`;
      const row = { id, type: String(type), from: source, to: target, data };
      this.edges.set(id, row);
      return row;
    }

    addPaper(card, options = {}) {
      const paperID = Agent.LiteratureRanking.identifier(card);
      const paper = this.node("Paper", paperID, { title: card?.metadata?.title || "", local: card?.local || {} });
      for (const author of card?.metadata?.authors || []) {
        const authorNode = this.node("Author", author.name || author);
        this.edge("sameAuthor", paper.id, authorNode.id);
      }
      for (const topic of [...(card?.discovery?.topics || []), ...(card?.discovery?.keywords || [])].slice(0, 50)) {
        const topicNode = this.node("Topic", topic);
        this.edge("sameTopic", paper.id, topicNode.id);
      }
      if (card?.metadata?.venue) this.edge("venue", paper.id, this.node("Venue", card.metadata.venue).id);
      for (const cited of options.references || card?.references || []) {
        const citedID = typeof cited === "string" ? cited : Agent.LiteratureRanking.identifier(cited);
        if (citedID) this.edge("cites", paper.id, this.node("Paper", citedID).id);
      }
      return paper;
    }

    expand(seedCards = [], relations = {}) {
      for (const card of Array.isArray(seedCards) ? seedCards : [seedCards]) this.addPaper(card, relations[Agent.LiteratureRanking.identifier(card)] || {});
      return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
    }

    snapshot() { return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] }; }
  }

  Agent.LiteratureGraph = LiteratureGraph;
})(this);
