(() => {
  "use strict";

  const LitMTrans = globalThis.LitMTrans = globalThis.LitMTrans || {};
  let zoom = 1, active = null, drag = null, windowDrag = null;
  const $ = id => document.getElementById(id);

  function stage() { return $("diagram-viewer-stage"); }
  function world() { return stage()?.firstElementChild || null; }
  function applyZoom() {
    const content = world();
    if (content) content.style.transform = `scale(${zoom})`;
    const output = $("diagram-viewer-scale");
    if (output) output.value = `${Math.round(zoom * 100)}%`;
  }
  function setZoom(value, anchor = null) {
    const viewport = stage(); const previous = zoom;
    zoom = Math.max(.25, Math.min(3, value));
    if (viewport && anchor) {
      const rect = viewport.getBoundingClientRect();
      const x = anchor.clientX - rect.left + viewport.scrollLeft;
      const y = anchor.clientY - rect.top + viewport.scrollTop;
      viewport.scrollLeft = x * zoom / previous - (anchor.clientX - rect.left);
      viewport.scrollTop = y * zoom / previous - (anchor.clientY - rect.top);
    }
    applyZoom();
  }
  function askAboutNode(node) {
    active?.onAsk?.(node);
  }
  function fit() {
    const viewport = stage(); const content = world(); if (!viewport || !content) return;
    zoom = 1; applyZoom();
    const diagram = content.querySelector(".mindmap-v2-canvas, .flowchart-interactive-canvas") || content;
    const width = Math.max(1, diagram.scrollWidth || diagram.offsetWidth); const height = Math.max(1, diagram.scrollHeight || diagram.offsetHeight);
    setZoom(Math.min(1, (viewport.clientWidth - 48) / width, (viewport.clientHeight - 48) / height));
    requestAnimationFrame(() => centerOnElements(diagram, { behavior: "auto" }));
  }
  function centerOnElements(...elements) {
    const viewport = stage();
    const config = elements.at(-1)?.behavior ? elements.pop() : {};
    const boxes = elements.filter(Boolean).map(element => element.getBoundingClientRect?.()).filter(Boolean);
    if (!viewport || !boxes.length) return;
    const view = viewport.getBoundingClientRect();
    const left = Math.min(...boxes.map(box => box.left)); const right = Math.max(...boxes.map(box => box.right));
    const top = Math.min(...boxes.map(box => box.top)); const bottom = Math.max(...boxes.map(box => box.bottom));
    const nextLeft = viewport.scrollLeft + (left + right) / 2 - (view.left + view.right) / 2;
    const nextTop = viewport.scrollTop + (top + bottom) / 2 - (view.top + view.bottom) / 2;
    if (typeof viewport.scrollTo === "function") viewport.scrollTo({ left: Math.max(0, nextLeft), top: Math.max(0, nextTop), behavior: config.behavior || "smooth" });
    else { viewport.scrollLeft = Math.max(0, nextLeft); viewport.scrollTop = Math.max(0, nextTop); }
  }
  function open(payload) {
    active = payload; zoom = 1;
    const dialog = $("diagram-viewer-dialog"), heading = $("diagram-viewer-title"), viewport = stage();
    if (!dialog || !viewport) return;
    heading.textContent = payload.title || "图形阅读";
    viewport.replaceChildren();
    const frame = document.createElement("div"); frame.className = `diagram-viewer-content diagram-${payload.mode}`; viewport.appendChild(frame);
    if (payload.mode === "mindmap") {
      LitMTrans.MindmapV2.render(frame, payload.diagram, {
        interactive: true,
        toggleOnClick: true,
        onAsk: askAboutNode,
        resolveEvidence: payload.resolveEvidence,
        onLocate: payload.onLocate,
        onFocus: centerOnElements
      });
    }
    else if (payload.mode === "flowchart" && payload.diagram) {
      LitMTrans.Flowchart.renderInteractive(frame, payload.diagram, {
        image: payload.image,
        onAsk: askAboutNode,
        resolveEvidence: payload.resolveEvidence,
        onLocate: payload.onLocate,
        onFocus: centerOnElements,
        onReady: fit
      });
    }
    else {
      const notice = document.createElement("div"); notice.className = "chat-diagram-pending"; notice.textContent = "流程图尚未准备好。"; frame.appendChild(notice);
    }
    const clearBtn = $("diagram-viewer-clear");
    if (clearBtn) {
      clearBtn.style.display = typeof payload.onClear === "function" ? "" : "none";
    }
    // This viewer must remain modeless: evidence jumps target the reader
    // behind it, and users need to inspect/scroll that source without first
    // closing the diagram that supplied the evidence.
    if (!dialog.open) dialog.show();
    requestAnimationFrame(fit);
  }
  function close() { $("diagram-viewer-dialog")?.close(); active = null; }
  async function exportDiagram() {
    if (!active?.onExport) return;
    const image = active.mode === "mindmap"
      ? LitMTrans.MindmapV2.imageForMap(active.diagram)
      : active.image;
    if (!image?.dataURL) return;
    await active.onExport(image);
  }
  function bindPan() {
    const viewport = stage(); if (!viewport) return;
    viewport.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button, a, input, textarea")) return;
      drag = { pointerID: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture?.(event.pointerId); viewport.classList.add("dragging");
    });
    viewport.addEventListener("pointermove", event => {
      if (!drag || drag.pointerID !== event.pointerId) return;
      viewport.scrollLeft = drag.left - (event.clientX - drag.x); viewport.scrollTop = drag.top - (event.clientY - drag.y);
    });
    const finish = event => { if (!drag || drag.pointerID !== event.pointerId) return; viewport.releasePointerCapture?.(event.pointerId); drag = null; viewport.classList.remove("dragging"); };
    viewport.addEventListener("pointerup", finish); viewport.addEventListener("pointercancel", finish);
    viewport.addEventListener("wheel", event => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event); }, { passive: false });
  }
  function bindWindowDrag() {
    const dialog = $("diagram-viewer-dialog");
    const header = dialog?.querySelector(".diagram-viewer-header");
    if (!dialog || !header) return;
    header.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button") || dialog.classList.contains("maximized")) return;
      const rect = dialog.getBoundingClientRect();
      windowDrag = { pointerID: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      dialog.style.left = `${rect.left}px`; dialog.style.top = `${rect.top}px`; dialog.style.transform = "none"; dialog.style.margin = "0";
      header.setPointerCapture?.(event.pointerId); header.classList.add("dragging");
      event.preventDefault();
    });
    header.addEventListener("pointermove", event => {
      if (!windowDrag || windowDrag.pointerID !== event.pointerId) return;
      const rect = dialog.getBoundingClientRect();
      const minLeft = Math.min(0, 120 - rect.width);
      const maxLeft = Math.max(minLeft, window.innerWidth - 120);
      const maxTop = Math.max(0, window.innerHeight - 48);
      dialog.style.left = `${Math.max(minLeft, Math.min(maxLeft, windowDrag.left + event.clientX - windowDrag.x))}px`;
      dialog.style.top = `${Math.max(0, Math.min(maxTop, windowDrag.top + event.clientY - windowDrag.y))}px`;
    });
    const finish = event => {
      if (!windowDrag || windowDrag.pointerID !== event.pointerId) return;
      header.releasePointerCapture?.(event.pointerId); windowDrag = null; header.classList.remove("dragging");
    };
    header.addEventListener("pointerup", finish); header.addEventListener("pointercancel", finish);
  }
  function init() {
    $("diagram-viewer-close")?.addEventListener("click", close);
    $("diagram-viewer-maximize")?.addEventListener("click", () => {
      const dialog = $("diagram-viewer-dialog");
      if (dialog) dialog.classList.toggle("maximized");
    });
    $("diagram-viewer-zoom-in")?.addEventListener("click", () => setZoom(zoom * 1.2));
    $("diagram-viewer-zoom-out")?.addEventListener("click", () => setZoom(zoom / 1.2));
    $("diagram-viewer-fit")?.addEventListener("click", fit);
    $("diagram-viewer-clear")?.addEventListener("click", async () => {
      if (typeof active?.onClear === "function") {
        await active.onClear();
      }
    });
    $("diagram-viewer-export")?.addEventListener("click", () => void exportDiagram());
    $("diagram-viewer-dialog")?.addEventListener("close", () => { active = null; });
    bindPan();
    bindWindowDrag();
  }
  LitMTrans.DiagramViewer = { open, close, init };
})();
