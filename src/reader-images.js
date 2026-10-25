(() => {
  "use strict";

  const selector = '#translation-layout img, #translation-content img';
  const records = new WeakMap();
  const backgroundRecords = new WeakMap();
  let theme = null;
  let initialized = false;

  function applyThemePixels(context, width, height) {
    const pixels = context.getImageData(0, 0, width, height);
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
  }

  function clearBackground(source) {
    const previous = backgroundRecords.get(source);
    if (previous) {
      previous.canvas?.remove();
      if (previous.canvas) previous.canvas.width = previous.canvas.height = 1;
      backgroundRecords.delete(source);
    }
    source.classList.remove('reader-color-background');
    source.closest('.layout-page')?.classList.remove('has-themed-pdf-bg');
  }

  function backgroundTextColor(rgb) {
    const min = Math.min(...rgb), max = Math.max(...rgb);
    const coverage = 1 - min / 255;
    const chroma = coverage ? (max - min) / (255 - min) : 0;
    const displayed = rgb.map((value, channel) => {
      const color = coverage ? (value - min) / (255 - min) : 0;
      return (color + (1 - chroma) * theme.foreground[channel]) * coverage + theme.background[channel] * (1 - coverage);
    });
    const luminance = color => color.reduce((sum, value, channel) =>
      sum + [0.2126, 0.7152, 0.0722][channel] * (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4), 0);
    const background = luminance(displayed);
    const contrast = color => (Math.max(luminance(color), background) + .05) / (Math.min(luminance(color), background) + .05);
    return contrast(theme.foreground) >= contrast(theme.background) ? theme.ink : theme.paper;
  }

  function installBackground(source, canvas, record, displayBackgrounds = null, displayRetainedImages = []) {
    if (backgroundRecords.get(source) !== record || !source.isConnected || source._litmtransBgVersion !== record.version) {
      canvas.width = canvas.height = 1;
      return;
    }
    applyThemePixels(canvas.getContext('2d'), canvas.width, canvas.height);
    canvas.className = 'reader-background-overlay';
    canvas.setAttribute('aria-hidden', 'true');
    source.after(canvas);
    source.classList.add('reader-color-background');
    const page = source.closest('.layout-page');
    page?.classList.add('has-themed-pdf-bg');
    if (displayBackgrounds) {
      for (const { node, rgb } of displayBackgrounds) {
        node.style.setProperty('--layout-background-ink', backgroundTextColor(rgb));
        node.dataset.themedBackgroundInk = '1';
      }
    } else {
      page?.querySelectorAll('[data-pdf-background-rgb]').forEach(node => {
        node.style.setProperty('--layout-background-ink', backgroundTextColor(node.dataset.pdfBackgroundRgb.split(',').map(Number)));
      });
    }
    for (const node of displayRetainedImages) {
      node.dataset.pdfScreenRetained = '1';
      node.querySelectorAll('img').forEach(image => clear(image));
    }
    record.canvas = canvas;
  }

  function paintFallbackBackground(source, record) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const context = canvas.getContext('2d');
      context.drawImage(source, 0, 0);
      installBackground(source, canvas, record);
    }
    catch (_) {
      if (backgroundRecords.get(source) === record) clearBackground(source);
    }
  }

  function paintBackground(source) {
    if (!theme || source.width <= 1 || source.height <= 1 || !source.closest('.has-pdf-bg')) {
      clearBackground(source);
      return;
    }
    const previous = backgroundRecords.get(source);
    if (previous && previous.version === source._litmtransBgVersion && previous.theme === theme.backgroundKey) return previous.task;
    clearBackground(source);
    const record = { theme: theme.backgroundKey, version: source._litmtransBgVersion };
    backgroundRecords.set(source, record);
    if (source._litmtransRenderTheme) {
      // 原色显示副本保留复合图，再统一进行白底融合；打印始终使用原始画布。
      record.task = source._litmtransRenderTheme().then(result => {
        if (result) installBackground(source, result.canvas, record, result.displayBackgrounds, result.displayRetainedImages);
        else if (backgroundRecords.get(source) === record) paintFallbackBackground(source, record);
      }).catch(() => {
        if (backgroundRecords.get(source) === record) paintFallbackBackground(source, record);
      });
      return record.task;
    }
    paintFallbackBackground(source, record);
  }

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
    if (image.closest('.has-themed-pdf-bg [data-pdf-screen-retained="1"]')) {
      clear(image);
      return;
    }
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
      applyThemePixels(context, canvas.width, canvas.height);
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
      document.querySelectorAll('#translation-layout canvas.layout-page-bg').forEach(clearBackground);
      return;
    }
    const channels = color => {
      const hex = color.slice(1);
      const full = hex.length === 3 ? [...hex].map(char => char + char).join('') : hex;
      return [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16) / 255);
    };
    theme = {
      key: value.foreground,
      backgroundKey: `${value.background}:${value.foreground}:${Boolean(value.invertImages)}`,
      foreground: channels(value.foreground), background: channels(value.background),
      ink: value.foreground, paper: value.background, invertImages: Boolean(value.invertImages)
    };
    initialize();
    document.querySelectorAll(selector).forEach(paint);
    document.querySelectorAll('#translation-layout canvas.layout-page-bg').forEach(paintBackground);
  }

  window.LitMTrans = window.LitMTrans || {};
  window.LitMTrans.ReaderImages = { setTheme, paintBackground, clearBackground };
})();
