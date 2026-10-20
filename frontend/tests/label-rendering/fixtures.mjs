// Synthetic V2 presets shared by unit and browser parity tests.
const text = (id, x, y, w, h, template, extra = {}) => ({ id, type: 'text', x, y, w, h,
  template, fontFamily: 'Space Grotesk', fontWeight: 400, fontSizeMm: 2.3, color: '#000000',
  align: 'left', wrap: true, fitToWidth: true, minFontSizeMm: 1.2, ...extra });
const preset = (elements, label = {}) => ({ version: 2, design: { version: 2,
  label: { widthMm: 40, heightMm: 30, marginMm: 1, border: false, ...label }, elements } });

export const data = { id: 295, 'filament.type': 'PLA', 'filament.name': 'Matte — Crèmeweiß',
  'filament.color': 'Weiß / crème', 'filament.manufacturer': 'FilaWorks',
  'filament.color_hex': '#138c81', 'filament.color_hexes': '#138c81',
  extra: { added: 'Donnerstag, 8. Oktober 2026', article: '11101' } };

export const fixtures = [
  { id: 'wrapped', title: 'Wrapped accents + five information lines', preset: preset([
    text('title', 1, 1, 38, 5, '{filament.name}', { fontWeight: 700, fontSizeMm: 3.4, align: 'center' }),
    text('info', 1, 7, 38, 22, 'ID: {id}\nHinzugefügt: {extra.added}\nFarbe: {filament.color}\nArtikel Nr: {extra.article}\nGröße: größer, süß, été'),
  ]) },
  { id: 'images', title: 'Transparent logo + inverse title + cropped image', preset: preset([
    { id: 'backdrop', type: 'shape', shape: 'rectangle', x: 1, y: 1, w: 7, h: 7, fill: '#dddddd', stroke: '', strokeWidthMm: 0, z: -1 },
    { id: 'logo', type: 'manufacturerLogo', x: 1, y: 1, w: 7, h: 7, objectFit: 'contain' },
    text('brand', 10, 1, 29, 7, '{filament.manufacturer}', { fontWeight: 700, fontSizeMm: 3.6, verticalAlign: 'middle' }),
    text('band', 1, 10, 38, 5, '=={filament.type}==', { fontWeight: 700, align: 'center', fontSizeMm: 3 }),
    { id: 'photo', type: 'image', x: 1, y: 17, w: 12, h: 12, assetId: 'photo', objectFit: 'contain', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } },
    text('info', 15, 17, 24, 12, '{filament.color}\nArtikel {extra.article}', { fontSizeMm: 2.6 }),
  ]) },
  { id: 'thermal', title: 'Thermal QR over background artwork', preset: preset([
    text('title', 1, 1, 38, 5, '=={filament.type}==', { fontWeight: 700, align: 'center', fontSizeMm: 3 }),
    text('info', 1, 8, 18, 21, 'ID: {id}\nFarbe: {filament.color}\nArtikel Nr: {extra.article}', { fontSizeMm: 2.5 }),
    { id: 'qr', type: 'qr', x: 20, y: 10, w: 19, h: 19, mode: 'colorLogo', linkMode: 'url', urlTemplate: 'https://fila.test', z: -5 },
    { id: 'background', type: 'shape', shape: 'rectangle', x: 20, y: 10, w: 19, h: 19, fill: '#666666', stroke: '', strokeWidthMm: 0, z: 20 },
  ]) },
  { id: 'fonts', title: 'All four fonts + German umlauts + weights', preset: preset([
    ...['Space Grotesk', 'Roboto Condensed', 'Fraunces', 'Space Mono'].map((fontFamily, i) =>
      text(i === 3 ? 'info' : `font-${i}`, 1, 1 + i * 7, 38, 6,
        `${fontFamily}: ÄÖÜ äöü ß`, { fontFamily, fontWeight: [400, 500, 600, 700][i], fontSizeMm: 2.6 })),
  ]) },
  { id: 'mixed', title: 'Mixed inline fonts + wrap/fit + drawing elements', preset: preset([
    text('info', 1, 1, 38, 16,
      'Grüße [font=Fraunces]größere[/font] [font=Space Mono]Füße[/font]\n[font=Roboto Condensed][b]ÄÖÜ äöü ß[/b][/font] — **süß** und crème',
      { fontSizeMm: 3.2 }),
    ...['circle', 'square', 'rectangle', 'line'].map((shape, i) => ({ id: shape, type: 'shape', shape,
      x: 1 + i * 9.5, y: 20, w: 8, h: shape === 'rectangle' ? 5 : 8,
      fill: '', stroke: '#000000', strokeWidthMm: 0.5, radiusMm: 0 })),
  ]) },
  { id: 'styled', title: 'Italic/underline + inline sizes/inverse + swatches', preset: preset([
    text('info', 1, 1, 38, 18, '[i]Grüße[/i] __größer__ [size=150][font=Fraunces]Üß[/font][/size]\n==Weiß== @@Farbe@@\n{color_swatch[5]} Artikel 11101', { fontSizeMm: 3 }),
    { id: 'swatch', type: 'swatch', x: 1, y: 23, w: 20, h: 5, radiusMm: 1 },
    { id: 'logo', type: 'manufacturerLogo', x: 23, y: 21, w: 16, h: 8, align: 'right', manualSizeMm: 5 },
  ], { border: true }) },
];
