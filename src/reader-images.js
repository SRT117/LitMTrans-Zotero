(() => {
  "use strict";

  const selector = '#translation-layout img, #translation-content img';
  const records = new WeakMap();
  let theme = null;
  let initialized = false;

  function clear(image, restoreHost = false) {
    records.get(image)?.canvas.remove();
    records.delete(image);
    image.classList.remove('reader-color-image');
    if (restoreHost && image.parentElement?.classList.contains('reader-image-host')) {
      const host = image.parentElement;
      if (host.tagName.toLowerCase() === 'span' && image.closest('#translation-content')
        && host.childNodes.length === 1 && host.firstChild === image) host.replaceWith(image);
      else host.classList.remove('reader-image-host');
    }
  }

  function paint(image) {
    if (!theme || !image.matches(selector)) return;
    if (!image.getAttribute('src') || !image.complete || !image.naturalWidth) {
      clear(image);
      return;
    }
    const source = image.currentSrc || image.src;
    const previous = records.get(image);
    if (previous?.source === source && previous.theme === theme.key) return;
    clear(image);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const { data } = pixels;
      for (let i = 0; i < data.length; i += 4) {
        const min = Math.min(data[i], data[i + 1], data[i + 2]);
        const max = Math.max(data[i], data[i + 1], data[i + 2]);
        const coverage = 1 - min / 255;
        // 去除白底分量，连同 JPEG 和抗锯齿边缘平滑透明化。
        data[i + 3] = Math.round(data[i + 3] * coverage);
        if (!coverage) continue;
        const chroma = (max - min) / (255 - min);
        for (let channel = 0; channel < 3; channel++) {
          const color = (data[i + channel] - min) / (255 - min);
          // 中性线条使用主题文字色，彩色分量保留，背景由透明度透出。
          data[i + channel] = Math.round(255 * (color + (1 - chroma) * theme.foreground[channel]));
        }
      }
      context.putImageData(pixels, 0, 0);
      canvas.className = 'reader-image-overlay';
      canvas.setAttribute('aria-hidden', 'true');
      if (image.closest('#translation-content') && !image.parentElement.classList.contains('reader-image-host')) {
        const host = document.createElement('span');
        host.className = 'reader-image-host';
        image.before(host);
        host.appendChild(image);
      }
      image.parentElement.classList.add('reader-image-host');
      image.after(canvas);
      image.classList.add('reader-color-image');
      records.set(image, { canvas, source, theme: theme.key });
    }
    catch (_) {
      // 无法读取像素时保留原图。
      clear(image);
    }
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    document.addEventListener('load', event => {
      if (event.target?.tagName?.toLowerCase() === 'img') paint(event.target);
    }, true);
    const observer = new MutationObserver(changes => {
      for (const change of changes) {
        if (change.type === 'attributes') {
          clear(change.target);
          paint(change.target);
        }
        for (const node of change.addedNodes || []) {
          if (node.nodeType !== 1) continue;
          if (node.tagName?.toLowerCase() === 'img') paint(node);
          node.querySelectorAll?.('img').forEach(paint);
        }
      }
    });
    for (const pane of document.querySelectorAll('.document-pane')) {
      observer.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }
  }

  function setTheme(value) {
    // 纯白主题直接显示原图，切回时也移除之前的显示层和临时包裹。
    if (/^#(?:fff|ffffff|ffffffff)$/i.test(value.background)) {
      theme = null;
      document.querySelectorAll(selector).forEach(image => clear(image, true));
      return;
    }
    const hex = value.foreground.slice(1);
    const full = hex.length === 3 ? [...hex].map(char => char + char).join('') : hex;
    theme = {
      key: value.foreground,
      foreground: [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16) / 255)
    };
    initialize();
    document.querySelectorAll(selector).forEach(paint);
  }

  window.LitMTrans = window.LitMTrans || {};
  window.LitMTrans.ReaderImages = { setTheme };
})();
