import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('../components/FilamentForm.astro', import.meta.url), 'utf8')
const spoolPage = readFileSync(new URL('../pages/spools/[id]/index.astro', import.meta.url), 'utf8')
const filamentPage = readFileSync(new URL('../pages/filaments/[id]/index.astro', import.meta.url), 'utf8')
const globalCss = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8')

describe('detail editor layout contracts', () => {
  it('keeps numeric values readable without browser steppers', () => {
    expect(component).toContain('input[type="number"]::-webkit-inner-spin-button')
    expect(component).toMatch(/filament-range-inputs[^}]+minmax\(5\.5ch, 1fr\)/s)
    expect(component).toMatch(/filament-unit-input > span[^}]+padding: 0 5px/s)
    expect(spoolPage).toContain('.spool-edit-input[type="number"]::-webkit-inner-spin-button')
  })

  it('renders the spool profile lookup inside the spool rows before material', () => {
    expect(spoolPage).toContain("row.key === 'spool_material' ? spoolProfileLookupHtml : ''")
    expect(spoolPage).not.toMatch(/<form id="spool-inline-form">[\s\S]+<\/div>\s*<div id="spool-profile-lookup-section"/)
  })

  it('uses content-driven hero wrapping instead of the old 980px cutoff', () => {
    expect(globalCss).not.toContain('@media (max-width: 980px)')
    expect(globalCss).toMatch(/\.filament-hero-body[^}]+flex-wrap: wrap/s)
    expect(globalCss).toMatch(/\.detail-page-toolbar[^}]+flex-wrap: wrap/s)
  })

  it('shows a decorative pencil beside the spool filament edit label', () => {
    expect(spoolPage).toMatch(/href="\/filaments\/\$\{spool\.filament_id\}\/edit"[^>]*>\s*<svg\b[^>]*aria-hidden="true"/s)
    expect(spoolPage).toContain("${t('spools.editFilament')}")
  })

  it('clips multicolor swatches inside their rounded border', () => {
    expect(globalCss).toMatch(/\.filament-color-dot[^}]+background-clip: padding-box/s)
  })

  it('keeps both record toolbars outside their heroes with accessible icon actions', () => {
    for (const page of [spoolPage, filamentPage]) {
      expect(page).toContain('class="detail-page-toolbar"')
      expect(page).toMatch(/class="detail-page-actions(?: spool-page-actions)?" role="group"/)
      expect(page).toContain('detail-icon-button')
      expect(page).toContain('class="filament-hero-logo"')
    }
    expect(spoolPage).toContain('id="btn-rfid"')
    expect(filamentPage).toContain('id="btn-duplicate-filament"')
    expect(filamentPage).toContain('id="btn-delete-filament"')
  })

  it('shows two filament facts, three spool facts, and shared quick actions below the hero', () => {
    expect(filamentPage).toContain('class="detail-hero-stats"')
    expect(filamentPage).toContain("t('filaments.diameter')")
    expect(filamentPage).toContain("t('filaments.rawMaterialWeightLabel')")
    expect(spoolPage).toContain("t('spools.status')")
    expect(spoolPage).toContain("t('spools.remaining')")
    expect(spoolPage).toContain("t('spools.location')")
    expect(filamentPage).toContain('class="detail-quick-actions"')
    expect(spoolPage).toContain('class="detail-quick-actions hidden"')
    expect(filamentPage).toContain('id="btn-print-label"')
    expect(spoolPage).toContain('id="btn-print-label"')
  })

  it('groups filament spools in an outlined panel and places totals with price history', () => {
    expect(filamentPage).toContain('class="spool-filament-panel filament-spool-panel"')
    expect(filamentPage).toMatch(/class="spool-filament-panel filament-spool-panel"[\s\S]*id="spools-section"[\s\S]*id="price-history-section"[\s\S]*<\/section>/)
    expect(filamentPage).toMatch(/id="price-history-section"[\s\S]*id="price-summary"/)
    expect(filamentPage).not.toMatch(/id="spools-section"[\s\S]*id="price-summary"[\s\S]*id="price-history-section"/)
  })

  it('puts the filament number above its name and uses visible diameter, scale, and spool symbols', () => {
    expect(filamentPage).toContain('class="detail-record-id"')
    expect(filamentPage).toContain('class="detail-record-name"')
    expect(filamentPage).toContain('class="detail-stat-symbol" aria-hidden="true">⌀</span>')
    expect(filamentPage).toContain('/icons.svg?v=detail3#icon-balance')
    expect(filamentPage).toContain('class="detail-spool-icon"')
  })

  it('puts spool and linked filament numbers above the spool product name', () => {
    expect(spoolPage).toMatch(/<h1><span class="detail-record-id">[\s\S]*class="filament-hero-link"[\s\S]*class="detail-record-name"/)
    expect(spoolPage).toContain("t('spools.filament')} #")
  })

  it('keeps the RFID mark legible with thinner strokes in the spool toolbar', () => {
    expect(globalCss).toMatch(/#btn-rfid svg[^}]+width: 34px; height: 34px; fill: none; stroke: currentColor; stroke-width: 2\.6px/s)
    expect(spoolPage).toMatch(/id="btn-rfid"[\s\S]*?<svg[^>]+viewBox="0 0 48 48"/)
    expect(spoolPage).toContain("'color: var(--text);'")
  })

  it('uses the same compact toolbar buttons for spools and filaments', () => {
    expect(spoolPage).toContain('class="detail-page-actions"')
    expect(globalCss).toMatch(/\.detail-icon-button[^}]+width: 44px; height: 44px/s)
    expect(globalCss).not.toMatch(/\.spool-page-actions \.detail-icon-button|#btn-rfid \{[^}]*width:/s)
    expect(globalCss).toMatch(/\.detail-record-id \.filament-hero-link[^}]+font-size: \.8em/s)
    expect(spoolPage).toContain('/icons.svg?v=detail3#icon-balance')
  })

  it('keeps quick action icons visible when their labels are translated', () => {
    for (const [button, icon, label] of [
      ['btn-measurement', 'icon-record-weight', 'spools.recordWeight'],
      ['btn-adjustment', 'icon-adjust', 'spools.adjust'],
      ['btn-status', 'icon-change-status', 'spools.changeStatus'],
      ['btn-move', 'icon-move', 'spools.move'],
    ]) {
      expect(spoolPage).toMatch(new RegExp(`id="${button}"[^>]*>\\s*<svg[^>]*><use href="/icons\\.svg\\?v=detail4#${icon}"[^>]*></use></svg><span data-i18n="${label}"`))
    }
  })
})
