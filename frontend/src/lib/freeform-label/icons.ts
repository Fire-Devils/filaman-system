export type DesignerIconName =
  | 'text'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'objectAlignLeft'
  | 'objectAlignCenter'
  | 'objectAlignRight'
  | 'alignTop'
  | 'alignMiddle'
  | 'alignBottom'
  | 'fitText'
  | 'wordWrap'
  | 'qr'
  | 'logo'
  | 'image'
  | 'upload'
  | 'crop'
  | 'swatch'
  | 'shape'
  | 'undo'
  | 'redo'
  | 'duplicate'
  | 'delete'
  | 'forward'
  | 'back'
  | 'uppercase'
  | 'inverse'
  | 'colorInverse'
  | 'date'

const paths: Record<DesignerIconName, string> = {
  text: '<path d="M5 5h14M12 5v14M8 19h8"/>',
  alignLeft: '<path d="M4 5h16M4 10h10M4 15h16M4 20h10"/>',
  alignCenter: '<path d="M4 5h16M7 10h10M4 15h16M7 20h10"/>',
  alignRight: '<path d="M4 5h16M10 10h10M4 15h16M10 20h10"/>',
  objectAlignLeft: '<path d="M4 4v16"/><rect x="7" y="8" width="10" height="8" rx="1" fill="currentColor" stroke="none"/>',
  objectAlignCenter: '<path d="M12 3v5m0 8v5"/><rect x="7" y="8" width="10" height="8" rx="1" fill="currentColor" stroke="none"/>',
  objectAlignRight: '<path d="M20 4v16"/><rect x="7" y="8" width="10" height="8" rx="1" fill="currentColor" stroke="none"/>',
  alignTop: '<path d="M4 4h16M8 8v12M16 8v8"/>',
  alignMiddle: '<path d="M4 12h16M8 4v16M16 7v10"/>',
  alignBottom: '<path d="M4 20h16M8 4v12M16 8v8"/>',
  fitText: '<path d="M8 8h8M12 8v9M9.5 17h5"/><path d="M4 3h16m-16 0 2-2m-2 2 2 2m14-2-2-2m2 2-2 2M4 21h16m-16 0 2-2m-2 2 2 2m14-2-2-2m2 2-2 2M2 6v12m0-12L0 8m2-2 2 2m-2 10-2-2m2 2 2-2M22 6v12m0-12-2 2m2-2 2 2m-2 10-2-2m2 2 2-2"/>',
  wordWrap: '<path d="M4 6h16M4 11h13a3 3 0 0 1 0 6h-3M16 14l-3 3 3 3M4 17h5"/>',
  qr: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h2v2h-2zM18 14h2v6h-6v-2"/>',
  logo: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m6 16 4-4 3 3 2-2 3 3"/><circle cx="8" cy="9" r="1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  crop: '<path d="M6 3v12a3 3 0 0 0 3 3h12M3 6h12a3 3 0 0 1 3 3v12"/>',
  swatch: '<path d="M5 4h14v16H5z"/><path d="M5 15h14M10 4v11M15 4v11"/>',
  shape: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  undo: '<path d="M9 7 4 12l5 5M5 12h8a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 5 5-5 5M19 12h-8a6 6 0 0 0-6 6"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  delete: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
  forward: '<path d="M7 17 17 7M10 7h7v7"/>',
  back: '<path d="m17 7-10 10M7 10v7h7"/>',
  uppercase: '<path d="m2 18 4.5-12L11 18M3.5 14h6M21 12v6"/><circle cx="18" cy="15" r="3"/>',
  inverse: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  colorInverse: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/><path d="M8 8h8v8H8z"/>',
  date: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M8 14h2M12 14h2M16 14h1M8 17h2M12 17h2"/>',
}

export function designerIcon(name: DesignerIconName) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`
}
