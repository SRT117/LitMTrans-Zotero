(function (global) {
  "use strict";

  function recolor(data, bgR, bgG, bgB, fgR, fgG, fgB, background) {
    if (background) {
      let lumSum = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 255) return false;
        lumSum += 2126 * data[i] + 7152 * data[i + 1] + 722 * data[i + 2];
      }
      if (lumSum / (data.length >> 2) / 10000 < 150) return false;
    }
    const paper = [bgR, bgG, bgB], ink = [fgR, fgG, fgB];
    const grayColors = new Uint8ClampedArray(256 * 3);
    for (let gray = 0; gray < 256; gray++) {
      const coverage = 1 - gray / 255;
      for (let channel = 0; channel < 3; channel++) {
        grayColors[gray * 3 + channel] = Math.round(ink[channel] * coverage + paper[channel] * (1 - coverage));
      }
    }
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === data[i + 1] && data[i] === data[i + 2]) {
        const offset = data[i] * 3;
        data[i] = grayColors[offset];
        data[i + 1] = grayColors[offset + 1];
        data[i + 2] = grayColors[offset + 2];
        continue;
      }
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const coverage = 1 - min / 255;
      const chroma = coverage ? (max - min) / (255 - min) : 0;
      for (let channel = 0; channel < 3; channel++) {
        const color = coverage ? (data[i + channel] - min) / (255 - min) : 0;
        const value = 255 * color + (1 - chroma) * ink[channel];
        data[i + channel] = Math.round(value * coverage + paper[channel] * (1 - coverage));
      }
    }
    return true;
  }

  global.LitMTransReaderImageTheme = Object.freeze({ recolor });
})(this);
