import { create } from 'fontkit';
import QRCode from 'qrcode';
import { Resvg, initWasm as initializeWasm } from '@resvg/resvg-wasm';
import { expandTemplate, getFilamentSwatchColors, getFilamentSwatchMode, getReadableTextColorForColors } from '../label-template.ts';
import { templateMarkupMatches, parseTemplateMarkup } from '../freeform-label/template-markup.ts';
import { LABEL_FONT_FAMILIES, LABEL_FONT_WEIGHTS } from '../freeform-label/types.ts';
import { escapeHtml } from '../extra-fields.ts';
import { buildQrUrl } from '../qr-code.ts';

let initialization;
export const initWasm = bytes => initialization ??= initializeWasm(bytes).catch(error => { initialization = undefined; throw error; });
export const loadFont = bytes => create(bytes);
export const fontFiles = LABEL_FONT_FAMILIES.flatMap(family =>
  (family === 'Space Mono' ? [400, 700] : LABEL_FONT_WEIGHTS).map(weight => {
    const slug = family.toLowerCase().replaceAll(' ', '-');
    return { key: `${family}:${weight}`, file: `@fontsource/${slug}/files/${slug}-latin-${weight}-normal.woff2` };
  }));
export const loadFonts = async read => Object.fromEntries(await Promise.all(fontFiles.map(async ({ key, file }, index) =>
  [key, loadFont(await read(file, index))])));
const measure = (text, font, size) => font.layout(text).advanceWidth * size / font.unitsPerEm;
// Checkbox fields use symbols absent from the bundled Latin fonts.
const checkboxPaths = { '✓': 'M0.1 0.35L0.3 0.1L0.7 0.7', '✗': 'M0.1 0.1L0.7 0.7M0.1 0.7L0.7 0.1' };

export function layoutText(text, element, font) {
  return layoutRuns([{ text, font }], element, font);
}

// Merge adjacent same-face characters before shaping: kerning/ligatures survive wrapping.
function groupRuns(characters) {
  const groups = [];
  for (const char of characters) {
    if (!char.swatch && !char.symbol && groups.at(-1)?.font === char.font && groups.at(-1)?.style === char.style && !groups.at(-1)?.swatch && !groups.at(-1)?.symbol) groups.at(-1).text += char.text;
    else groups.push({ ...char });
  }
  return groups;
}

function runWidth(run, size, measurements) {
  const em = size * (run.style?.factor ?? 1);
  if (run.swatch) return measure('0', run.font, em) * (run.swatch.widthCh + 0.4);
  if (run.symbol) return em * (run.style?.italic ? 0.95 : 0.8);
  let cache = measurements?.get(run.font);
  if (measurements && !cache) measurements.set(run.font, cache = new Map());
  let width = cache?.get(run.text);
  if (!width) {
    const shaped = run.font.layout(run.text);
    // Synthetic italic includes its ink overhang; both widths are size-independent.
    width = { normal: shaped.advanceWidth, italic: Math.max(shaped.advanceWidth,
      shaped.bbox.maxX + Math.tan(14 * Math.PI / 180) * shaped.bbox.maxY) };
    if (cache && cache.size < 512) cache.set(run.text, width);
  }
  return (run.style?.italic ? width.italic : width.normal) * em / run.font.unitsPerEm;
}

function lineMetrics(groups, size, defaultFont, role, measurements) {
  let width = 0;
  groups.forEach((run, i) => {
    if (run.style?.background && groups[i - 1]?.style?.background !== run.style.background) width += 0.6;
    width += runWidth(run, size, measurements);
    if (run.style?.background && groups[i + 1]?.style?.background !== run.style.background) width += 0.6;
  });
  const faces = [{ font: defaultFont }, ...groups];
  const ascent = Math.max(...faces.map(run => run.font.ascent / run.font.unitsPerEm * (run.style?.factor ?? 1))) * size;
  const descent = Math.max(...faces.map(run => -run.font.descent / run.font.unitsPerEm * (run.style?.factor ?? 1))) * size;
  const factor = Math.max(1, ...groups.map(run => run.style?.factor ?? 1));
  const height = role && factor === 1 ? size * (role === 'info' ? 1.4 : 1)
    : Math.max(size * (role === 'info' ? 1.4 : 1.15) * factor, ascent + descent);
  return { width, height, ascent: (height - ascent - descent) / 2 + ascent };
}

function layoutRuns(runs, element, defaultFont) {
  if (runs.reduce((n, run) => n + run.text.length, 0) > 12000) throw new Error('Label text limit exceeded');
  if (![element.fontSizeMm, element.minFontSizeMm ?? 1].every(v => Number.isFinite(v) && v > 0)) throw new Error('Invalid font size');
  if (runs.every(run => run.text === '' && !run.swatch)) return { lines: [], size: element.fontSizeMm, lineHeight: 0, height: 0, metrics: [], runs: [] };
  const paragraphs = [[]];
  const segmenter = new Intl.Segmenter('de', { granularity: 'grapheme' });
  for (const run of runs) {
    const { text, font } = run;
    if (run.swatch) { paragraphs.at(-1).push(run); continue; }
    for (const char of text.replace(/\s/g, '')) if (!checkboxPaths[char] && !font.hasGlyphForCodePoint(char.codePointAt(0))) throw new Error(`Missing glyph: ${char}`);
    for (const { segment } of segmenter.segment(text.replace(/\\n/g, '\n'))) {
      if (segment === '\n' || segment === '\r\n') paragraphs.push([]);
      else paragraphs.at(-1).push({ ...run, text: segment, symbol: checkboxPaths[segment] });
    }
  }
  // Keep bounded numeric measurements only, and release them after this layout.
  const measurements = new Map();
  const metrics = (chars, size) => lineMetrics(groupRuns(chars), size, defaultFont, element.legacyTextRole, measurements);
  // ponytail: greedy Latin word wrapping; adopt paragraph layout if full CSS/bidi parity is required.
  const wrap = size => paragraphs.flatMap(paragraph => {
    if (!element.wrap) return [paragraph];
    const words = [];
    let word = [], space;
    for (const char of paragraph) {
      if (/\s/u.test(char.text)) {
        if (word.length) { words.push({ word, space }); word = []; space = char; }
        else space ??= char;
      }
      else word.push(char);
    }
    if (word.length) words.push({ word, space });
    const lines = [];
    let line = [];
    for (const { word, space } of words) {
      const candidate = line.length ? [...line, { ...space, text: ' ' }, ...word] : word;
      if (metrics(candidate, size).width <= element.w) { line = candidate; continue; }
      if (line.length) lines.push(line);
      line = [];
      for (const char of word) {
        if (line.length && metrics([...line, char], size).width > element.w) { lines.push(line); line = []; }
        line.push(char);
      }
    }
    return [...lines, line];
  });
  const fits = (lines, size) => (element.legacyTextRole === 'title' && !element.wrap || lines.reduce((sum, line) => sum + metrics(line, size).height, 0) <= element.h)
    && lines.every(line => metrics(line, size).width <= element.w);
  let size = element.fontSizeMm;
  let lines = wrap(size);
  if (!fits(lines, size) && element.fitToWidth) {
    let low = Math.min(size, element.minFontSizeMm ?? (element.wrap ? 2 : 0.265)), high = size;
    if (!fits(wrap(low), low)) throw new Error('Text cannot fit at minimum size');
    for (let i = 0; i < 12; i++) {
      const mid = (low + high) / 2;
      if (fits(wrap(mid), mid)) low = mid; else high = mid;
    }
    size = low;
    lines = wrap(size);
  }
  if (!fits(lines, size)) throw new Error('Text does not fit; enable Scale font to fit or enlarge its box');
  const measured = lines.map(line => metrics(line, size));
  return { lines: lines.map(line => line.map(c => c.text).join('')), size,
    lineHeight: Math.max(0, ...measured.map(line => line.height)), height: measured.reduce((sum, line) => sum + line.height, 0),
    metrics: measured, runs: lines.map(groupRuns) };
}

function textSvg(element, data, fonts) {
  const template = element.template;
  const face = (family, weight) => {
    if (!LABEL_FONT_FAMILIES.includes(family) || !LABEL_FONT_WEIGHTS.includes(weight)) throw new Error('Unsupported font family or weight');
    // CSS font matching: Space Mono has only 400/700; 500 chooses 400, 600 chooses 700.
    const selected = family === 'Space Mono' ? (weight <= 500 ? 400 : 700) : weight;
    const font = fonts[`${family}:${selected}`];
    if (!font) throw new Error(`Font not loaded: ${family} ${selected}`);
    return font;
  };
  const family = element.fontFamily ?? 'Space Grotesk', weight = element.fontWeight ?? 400;
  const defaultFont = face(family, weight);
  const { text, sources } = expandTemplate(template, data, true);
  if (text.length > 12000) throw new Error('Label text limit exceeded');
  const mask = text.split('').map((c, i) => sources[i].literal ? '\uFFFC' : c).join('');
  const runs = [];
  const parse = (from, to, style, depth = 0) => {
    if (depth > 32) throw new Error('Label markup nesting limit exceeded');
    const append = (start, end) => { if (end > start) runs.push({ text: text.slice(start, end), font: face(style.family, style.weight), style }); };
    let cursor = from;
    for (const match of templateMarkupMatches(mask.slice(from, to), { swatches: true })) {
      const start = from + match.index, end = start + match[0].length;
      append(cursor, start);
      const markup = parseTemplateMarkup(match[0]);
      if (markup?.kind === 'swatch') {
        const [, widthCh, mode, palette] = text.slice(start, end).match(/^\[\[FM_SWATCH\|(\d+)\|(bands|layers)\|([^\]]+)\]\]$/);
        runs.push({ text: '\uFFFC', font: face(style.family, style.weight), style, swatch: { widthCh: Number(widthCh), mode, colors: palette.split(',') } });
      } else if (markup) {
        const next = { ...style }, opening = markup.opening.toLowerCase();
        if (markup.kind === 'font') next.family = markup.font;
        else if (markup.kind === 'size') next.factor *= markup.sizePercent / 100;
        else if (['**', '[b]', '***'].includes(opening)) next.weight = 700;
        if (['*', '[i]', '***'].includes(opening)) next.italic = true;
        if (opening === '__') next.underline = true;
        if (['==', '@@'].includes(opening)) {
          const colors = opening === '==' ? ['#000000'] : getFilamentSwatchColors(data['filament.color_hexes'], data['filament.color_hex']);
          next.background = { colors: colors.length ? colors : ['#000000'], mode: getFilamentSwatchMode(data['filament.multi_color_style']) };
          next.color = opening === '==' ? '#ffffff' : getReadableTextColorForColors(colors);
        }
        if (!Number.isFinite(next.factor) || next.factor > 27 || next.factor < 0.125) throw new Error('Label nested size limit exceeded');
        parse(start + markup.opening.length, end - markup.closing.length, next, depth + 1);
      } else append(start, end);
      cursor = end;
    }
    append(cursor, to);
  };
  parse(0, text.length, { family, weight, factor: 1, italic: !!element.italic, underline: !!element.underline, color: element.color ?? '#000000' });
  const layout = layoutRuns(runs, element, defaultFont);
  const height = layout.height;
  const top = element.y + (element.verticalAlign === 'middle' ? (element.h - height) / 2 : element.verticalAlign === 'bottom' ? element.h - height : 0);
  const parts = [];
  let lineTop = top;
  layout.runs.forEach((line, index) => {
    const { width, height: rowHeight, ascent } = layout.metrics[index];
    const x = element.x + (element.align === 'center' ? (element.w - width) / 2 : element.align === 'right' ? element.w - width : 0);
    const y = lineTop + ascent;
    let offset = 0;
    for (let i = 0; i < line.length; i++) {
      const segment = line[i], style = segment.style ?? {}, bg = style.background;
      if (bg && line[i - 1]?.style?.background !== bg) {
        let bandWidth = 1.2;
        for (let j = i; j < line.length && line[j].style?.background === bg; j++) bandWidth += runWidth(line[j], layout.size);
        const full = element.legacyTextRole === 'title' && i === 0 && /^\s*(==[\s\S]*==|@@[\s\S]*@@)\s*$/.test(template);
        parts.push(bandsSvg(full ? element.x : x + offset, lineTop, full ? element.w : bandWidth, rowHeight, bg.colors, bg.mode));
        offset += 0.6;
      }
      const em = layout.size * (style.factor ?? 1), advanceWidth = runWidth(segment, layout.size);
      if (segment.swatch) {
        const gap = measure('0', segment.font, em) * 0.2;
        parts.push(bandsSvg(x + offset + gap, y - 0.82 * em, advanceWidth - 2 * gap, 0.82 * em, segment.swatch.colors, segment.swatch.mode, em * 0.14, 0.265));
      } else if (segment.symbol) {
        parts.push(`<path d="${segment.symbol}" fill="none" stroke="${escapeHtml(style.color ?? '#000000')}" stroke-width="${style.weight >= 600 ? 0.12 : 0.08}" stroke-linecap="round" stroke-linejoin="round" transform="translate(${x + offset} ${y}) scale(${em} ${-em})${style.italic ? ' skewX(14)' : ''}"/>`);
      } else {
        const run = segment.font.layout(segment.text), scale = em / segment.font.unitsPerEm;
        let advance = 0;
        const paths = run.glyphs.map((glyph, i) => {
          const pos = run.positions[i];
          const path = `<path transform="translate(${advance + pos.xOffset} ${pos.yOffset})" d="${glyph.path.toSVG()}"/>`;
          advance += pos.xAdvance;
          return path;
        }).join('');
        parts.push(`<g fill="${escapeHtml(style.color ?? '#000000')}" transform="translate(${x + offset} ${y}) scale(${scale} ${-scale})${style.italic ? ' skewX(14)' : ''}">${paths}</g>`);
      }
      if (style.underline && !segment.swatch) {
        const scale = em / segment.font.unitsPerEm, underlineY = y - segment.font.underlinePosition * scale;
        parts.push(`<path d="M${x + offset} ${underlineY}h${advanceWidth}" stroke="${escapeHtml(style.color)}" stroke-width="${Math.max(0.05, segment.font.underlineThickness * scale)}"/>`);
      }
      offset += advanceWidth;
      if (bg && line[i + 1]?.style?.background !== bg) offset += 0.6;
    }
    lineTop += rowHeight;
  });
  const { runs: shapedRuns, ...metrics } = layout;
  return { svg: parts.join(''), layout: { id: element.id, x: element.x, y: element.y, ...metrics, text: runs.map(run => run.text).join('') } };
}

function bandsSvg(x, y, w, h, colors, mode = 'bands', radius = 0, stroke = 0) {
  const palette = colors.length ? colors : ['#9AA0A6'];
  const id = `band_${x}_${y}_${w}_${h}_${mode}_${palette.join('')}`.replace(/[^\w-]/g, '_');
  const stops = palette.map((color, i) => `<stop offset="${i / palette.length}" stop-color="${color}"/><stop offset="${(i + 1) / palette.length}" stop-color="${color}"/>`).join('');
  return `<defs><linearGradient id="${id}" x2="${mode === 'layers' ? '0%' : '100%'}" y2="${mode === 'layers' ? '100%' : '0%'}">${stops}</linearGradient></defs><rect x="${x + stroke / 2}" y="${y + stroke / 2}" width="${Math.max(0, w - stroke)}" height="${Math.max(0, h - stroke)}" rx="${radius}" fill="url(#${id})" stroke="#000" stroke-opacity="0.35" stroke-width="${stroke}"/>`;
}

function imageSvg(element, asset) {
  if (!asset || !/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(asset.dataUrl) || asset.dataUrl.length > Math.ceil(5 * 1024 * 1024 / 3) * 4 + 32
    || ![asset.width, asset.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Missing or unsupported embedded raster image');
  const crop = element.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  if (![crop.x, crop.y, crop.w, crop.h].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1 || crop.y + crop.h > 1) throw new Error('Invalid image crop');
  let { x, y, w, h } = element;
  if (element.manualSizeMm) {
    const target = element.collapseWhenEmpty ? Math.round(element.manualSizeMm * 3.78) * 25.4 / 96 : element.manualSizeMm;
    h = Math.min(h, target, w * asset.height / asset.width);
    w = h * asset.width / asset.height;
    x += element.align === 'right' ? element.w - w : element.align === 'left' ? 0 : (element.w - w) / 2;
    y += (element.h - h) / 2;
  }
  const scale = Math.min(w / (crop.w * asset.width), h / (crop.h * asset.height));
  const drawnW = crop.w * asset.width * scale, drawnH = crop.h * asset.height * scale;
  x += element.align === 'left' ? 0 : element.align === 'right' ? w - drawnW : (w - drawnW) / 2;
  y += (h - drawnH) / 2;
  return `<svg x="${x}" y="${y}" width="${drawnW}" height="${drawnH}" viewBox="${crop.x * asset.width} ${crop.y * asset.height} ${crop.w * asset.width} ${crop.h * asset.height}" overflow="hidden"><image width="${asset.width}" height="${asset.height}" href="${asset.dataUrl}"/></svg>`;
}

function qrSvg(element, url, sx, sy, thermal, assets, fonts) {
  const level = thermal ? 'M' : 'H';
  const matrix = QRCode.create(url, { errorCorrectionLevel: level }).modules;
  if (!thermal) {
    const step = element.w / matrix.size, quiet = 4 * step;
    const parts = [`<rect x="${element.x - quiet}" y="${element.y - quiet}" width="${element.w + 2 * quiet}" height="${element.w + 2 * quiet}" fill="#fff"/>`];
    for (let row = 0; row < matrix.size; row++) for (let col = 0; col < matrix.size; col++) {
      if (matrix.get(row, col)) parts.push(`<rect x="${element.x + col * step}" y="${element.y + row * step}" width="${step}" height="${step}" fill="#000"/>`);
    }
    if (element.mode !== 'simple') {
      const cx = element.x + element.w / 2, cy = element.y + element.w / 2;
      const logo = element.mode === 'colorLogo' && assets.qrLogo;
      let w = element.w * (logo ? 0.32 : 0.34), h = element.w * (logo ? 0.24 : 0.11);
      if (logo) { h = Math.min(h, w * logo.height / logo.width); w = h * logo.width / logo.height; }
      const pad = element.w * (logo ? 0.014 : 0.045);
      parts.push(`<rect x="${cx - w / 2 - pad}" y="${cy - h / 2 - pad}" width="${w + 2 * pad}" height="${h + 2 * pad}" fill="#fff"/>`);
      parts.push(logo ? imageSvg({ x: cx - w / 2, y: cy - h / 2, w, h }, logo)
        : textSvg({ id: 'qr-brand', x: cx - w / 2, y: cy - h, w, h: h * 2, template: 'FilaMan', fontSizeMm: h,
          fontWeight: 700, align: 'center', verticalAlign: 'middle', fitToWidth: true, minFontSizeMm: h / 2 }, {}, fonts).svg);
    }
    return { svg: parts.join(''), dots: step * sx, modules: matrix.size, url, level, decorated: element.mode !== 'simple' };
  }
  const dots = Math.floor(Math.min(Math.round(element.w * sx), Math.round(element.h * sy)) / (matrix.size + 8));
  if (dots < 3) throw new Error(`QR has ${dots} dots per module; requires at least 3`);
  const edge = (matrix.size + 8) * dots;
  const x = Math.round(element.x * sx) + Math.floor((Math.round(element.w * sx) - edge) / 2);
  const y = Math.round(element.y * sy) + Math.floor((Math.round(element.h * sy) - edge) / 2);
  const modules = [];
  for (let row = 0; row < matrix.size; row++) for (let col = 0; col < matrix.size; col++) {
    if (matrix.get(row, col)) modules.push(`<rect x="${x + (col + 4) * dots}" y="${y + (row + 4) * dots}" width="${dots}" height="${dots}"/>`);
  }
  return { svg: `<rect x="${element.x}" y="${element.y}" width="${element.w}" height="${element.h}" fill="#fff"/><g transform="scale(${1 / sx} ${1 / sy})" shape-rendering="crispEdges"><rect x="${x}" y="${y}" width="${edge}" height="${edge}" fill="#fff"/><g fill="#000">${modules.join('')}</g></g>`, dots, modules: matrix.size, x, y, edge, url, level, decorated: false };
}

// Migrated rows carry flow hints. Keep their saved coordinates untouched.
function flowElements(source, data, assets, fonts) {
  const elements = structuredClone(source), hidden = new Set();
  const shiftAfter = (index, shift) => elements.forEach((next, i) => {
    if (i === index || source[i].y <= source[index].y) return;
    next.y -= shift * (next.type === 'qr' && next.legacyVAlign === 'bottom' ? 0 : next.type === 'qr' && next.legacyVAlign === 'center' ? 0.5 : 1);
    if (next.type === 'text' && next.legacyTextRole === 'info' || next.type === 'shape' && next.h > next.w) next.h += shift;
  });
  const logo = elements.findIndex(e => e.type === 'manufacturerLogo' && e.collapseWhenEmpty);
  if (logo >= 0 && !assets.logo) {
    const divider = elements.findIndex(e => e.type === 'shape' && e.legacyLogoDivider);
    hidden.add(logo); if (divider >= 0) hidden.add(divider);
    shiftAfter(logo, elements[logo].h + 0.5 + (divider >= 0 ? elements[divider].h + 0.5 : 0));
  }
  elements.forEach((element, index) => {
    if (element.type !== 'text' || element.legacyTextRole !== 'title') return;
    const { layout } = textSvg(element, data, fonts);
    const empty = !layout.text.trim();
    const below = element.legacyDividerBelow && elements[index + 1]?.type === 'shape' ? index + 1 : -1;
    const shift = empty ? element.h + 2 * (element.legacyTitleMarginMm ?? 0) + (below >= 0 ? elements[below].h : 0)
      : !element.wrap ? element.h - layout.height : 0;
    if (empty) { hidden.add(index); if (below >= 0) hidden.add(below); }
    else if (!element.wrap) element.h = layout.height;
    shiftAfter(index, shift);
  });
  return { elements: elements.filter((_e, i) => !hidden.has(i)),
    boxes: elements.map(({ id, x, y, w, h }, i) => ({ id, x, y, w, h, hidden: hidden.has(i) })) };
}

/** Same V2 preset, same fonts, same code; no DOM or browser text measurement. */
export function renderLabel(preset, data, assets, fonts, dpi, baseUrl, { thermal = true, entityPath = 'spools', pixelWidth = undefined, pixelHeight = undefined } = {}) {
  if (preset?.version !== 2 || preset.design?.version !== 2 || !Array.isArray(preset.design.elements) || preset.design.elements.length > 100) throw new Error('Expected a V2 preset');
  const { label, elements } = preset.design;
  if (![label.widthMm, label.heightMm].every(v => Number.isFinite(v) && v > 0)) throw new Error('Invalid label dimensions');
  const width = pixelWidth ?? Math.round(label.widthMm * dpi / 25.4), height = pixelHeight ?? Math.round(label.heightMm * dpi / 25.4);
  if (![width, height].every(v => Number.isInteger(v) && v > 0) || width * height > 8000000) throw new Error('Invalid pixel dimensions or pixel budget exceeded');
  const sx = width / label.widthMm, sy = height / label.heightMm;
  const parts = [], text = [], qrs = [];
  const flowed = flowElements(elements, data, assets, fonts);
  const sorted = flowed.elements.sort((a, b) => Number(a.type === 'qr') - Number(b.type === 'qr') || (a.z ?? 0) - (b.z ?? 0));
  for (const element of sorted) {
    const zeroArea = element.w === 0 || element.h === 0;
    const legacyInfo = element.type === 'text' && element.legacyTextRole === 'info';
    if (![element.x, element.y, element.w, element.h].every(Number.isFinite) || element.w < 0 || element.h < 0 || zeroArea && !legacyInfo) throw new Error(`Invalid geometry for element ${element.id}`);
    // Parse formatting before deciding whether a migrated zero-area column is empty.
    if (element.type === 'text') {
      const result = textSvg(element, data, fonts);
      if (zeroArea && result.layout.text.trim()) throw new Error(`Invalid geometry for element ${element.id}`);
      parts.push(result.svg); text.push(result.layout);
    } else if (element.type === 'image' || element.type === 'manufacturerLogo') {
      if (element.type === 'manufacturerLogo' && !assets.logo) continue;
      parts.push(imageSvg(element, assets[element.type === 'image' ? element.assetId : 'logo']));
    } else if (element.type === 'qr') {
      let base = new URL(baseUrl).origin;
      try { const custom = new URL(element.urlTemplate); if (element.linkMode === 'url' && ['http:', 'https:'].includes(custom.protocol)) base = custom.href; } catch { /* Same origin fallback as the editor. */ }
      const url = buildQrUrl('url', base, entityPath === 'filaments' ? data['filament.id'] ?? data.id : data.id, entityPath);
      const result = qrSvg(element, url, sx, sy, thermal, assets, fonts);
      if (thermal && (result.x < 0 || result.y < 0 || result.x + result.edge > width || result.y + result.edge > height)) {
        throw new Error('Thermal QR box must fit inside the label');
      }
      parts.push(result.svg); qrs.push({ id: element.id, ...result, svg: undefined });
    } else if (element.type === 'swatch') {
      parts.push(bandsSvg(element.x, element.y, element.w, element.h, getFilamentSwatchColors(data['filament.color_hexes'], data['filament.color_hex']), getFilamentSwatchMode(data['filament.multi_color_style']), element.radiusMm ?? 0, 0.12));
    } else if (element.type === 'shape' && ['rectangle', 'square', 'circle', 'line'].includes(element.shape)) {
      let stroke = element.stroke ? element.strokeWidthMm ?? 0 : 0;
      const radius = element.radiusMm ?? 0;
      if (![stroke, radius].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid shape stroke or radius');
      // Once the border fills the interior, keep a solid shape instead of a zero-size path.
      if (element.shape !== 'line') stroke = Math.min(stroke, element.w / 2, element.h / 2);
      const style = `fill="${escapeHtml(element.fill || 'none')}" stroke="${escapeHtml(element.stroke || 'none')}" stroke-width="${stroke}"`;
      // Match CSS border-box: closed-shape strokes live inside the element bounds.
      const x = element.x + stroke / 2, y = element.y + stroke / 2;
      const w = element.w - stroke, h = element.h - stroke;
      if (element.shape === 'line') parts.push(`<line x1="${element.x}" y1="${element.y + element.h / 2}" x2="${element.x + element.w}" y2="${element.y + element.h / 2}" ${style}/>`);
      else if (element.shape === 'circle') parts.push(`<ellipse cx="${element.x + element.w / 2}" cy="${element.y + element.h / 2}" rx="${w / 2}" ry="${h / 2}" ${style}/>`);
      else parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.max(0, radius - stroke / 2)}" ${style}/>`);
    } else throw new Error(`Unsupported label element: ${element.type}`);
  }
  if (label.border) {
    const margin = label.marginMm ?? 0;
    parts.unshift(`<rect x="${margin + 0.15}" y="${margin + 0.15}" width="${label.widthMm - 2 * margin - 0.3}" height="${label.heightMm - 2 * margin - 0.3}" fill="none" stroke="#000" stroke-width="0.3"/>`);
  }
  return { width, height, text, qrs, boxes: flowed.boxes, svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${label.widthMm} ${label.heightMm}" preserveAspectRatio="none"><rect width="100%" height="100%" fill="#fff"/>${parts.join('')}</svg>` };
}

/** @template T
 * @param {string} svg
 * @param {(image: ReturnType<Resvg['render']>) => T} read
 * @returns {T}
 */
function withRenderedImage(svg, read) {
  const renderer = new Resvg(svg);
  let image;
  try {
    image = renderer.render();
    return read(image);
  } finally { image?.free(); renderer.free(); }
}

export const rasterizePng = svg => withRenderedImage(svg, image => new Uint8Array(image.asPng()));

export function rasterize(svg, threshold = 200) {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new Error('Invalid threshold');
  return withRenderedImage(svg, image => {
    const pixels = new Uint8Array(image.pixels);
    const stride = Math.ceil(image.width / 8);
    const mono = new Uint8Array(stride * image.height);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      // Match Pillow's rounded RGB luminance; SVG always has an opaque white base.
      // Pillow's RGB -> L uses these fixed-point coefficients, including half-up rounding.
      const dark = ((19595 * pixels[i] + 38470 * pixels[i + 1] + 7471 * pixels[i + 2] + 32768) >> 16) < threshold;
      if (dark) mono[y * stride + (x >> 3)] |= 1 << (7 - (x & 7));
    }
    return { png: new Uint8Array(image.asPng()), pixels, mono, width: image.width, height: image.height };
  });
}

/** @param {import('./types').SvgInput} input */
export function renderSvgLabelPng(input, runtime) {
  const result = renderLabel(input.preset, input.data, input.assets, runtime.fonts, undefined, input.origin, input);
  return { ...result, png: rasterizePng(result.svg) };
}

/** @param {import('./types').SvgInput} input */
export function renderSvgLabel(input, runtime, threshold = 200) {
  const result = renderLabel(input.preset, input.data, input.assets, runtime.fonts, undefined, input.origin, input);
  return { ...result, ...rasterize(result.svg, threshold) };
}
