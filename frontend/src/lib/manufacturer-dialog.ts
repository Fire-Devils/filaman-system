import { isAbortError } from './abort'
import { request } from './api'
import { formatPrice, getCurrency } from './format'
import { catalogLinks, catalogSnapshot, filamentDbSource, profileFields, withManufacturerMetadata, type CatalogEntry, type CatalogLinks, type ManufacturerSource } from './manufacturer-catalog'
import '../styles/manufacturer-dialog.css'
import { CACHE_KEYS, invalidateCachePrefix } from './cache'
import { escapeHtml } from './extra-fields'
import { createFilamentDbLookup, fuzzyTokenScore, type LookupInstance } from './filamentdb-lookup'
import { t } from './i18n'

export type Manufacturer = {
  id: number
  name: string
  url?: string | null
  empty_spool_weight_g?: number | null
  spool_material?: string | null
  spool_outer_diameter_mm?: number | null
  spool_width_mm?: number | null
  custom_fields?: Record<string, unknown> | null
  [key: string]: unknown
}

export type ManufacturerDialog = {
  open: (manufacturer?: Manufacturer | null, options?: { mode: 'view' | 'edit' }) => void
  close: () => void
}

export const ADD_MANUFACTURER_VALUE = '__add_manufacturer__'

export function bindManufacturerCreateOption(select: HTMLSelectElement, open: () => void): HTMLOptionElement {
  let previousValue = select.value
  const option = document.createElement('option')
  option.value = ADD_MANUFACTURER_VALUE
  option.textContent = `+ ${t('manufacturers.addManufacturer')}`
  select.appendChild(option)
  select.addEventListener('focus', () => {
    if (select.value !== ADD_MANUFACTURER_VALUE) previousValue = select.value
  })
  select.addEventListener('change', () => {
    if (select.value === ADD_MANUFACTURER_VALUE) {
      select.value = previousValue
      open()
    } else {
      previousValue = select.value
    }
  })
  return option
}

export function createManufacturerDialog(options: {
  filamentDbActive?: boolean
  sources?: ManufacturerSource[]
  onSaved: (manufacturer: Manufacturer, isCurrentSession: boolean) => void | Promise<void>
}): ManufacturerDialog {
  const sources = options.sources ?? (options.filamentDbActive ? [filamentDbSource()] : [])
  const e = escapeHtml
  const label = (key: string) => e(t(key))
  const icon = (name: string) => `<svg aria-hidden="true"><use href="/icons.svg?v=2#icon-${name}"/></svg>`
  const fields = [
    ['name', 'manufacturers.name', 'text', ''],
    ['url', 'manufacturers.url', 'url', ''],
    ['contact_email', 'manufacturers.contactEmail', 'email', ''],
    ['description', 'manufacturers.description', 'textarea', ''],
    ['empty_spool_weight_g', 'spools.emptySpoolWeight', 'number', 'g'],
    ['spool_material', 'spools.spoolMaterial', 'select', ''],
    ['spool_outer_diameter_mm', 'spools.spoolOuterDiameter', 'number', 'mm'],
    ['spool_width_mm', 'spools.spoolWidth', 'number', 'mm'],
  ]
  const selectors = ['name', 'url', 'email', 'description', 'empty-weight', 'material', 'outer-diameter', 'width']
  const field = (index: number) => {
    const [key, title, type, unit] = fields[index]
    const attrs = `id="manufacturer-dialog-${key}" name="${key}" data-manufacturer-${selectors[index]} class="fm-input${type === 'select' ? ' fm-select' : ''}"`
    const input = type === 'textarea' ? `<textarea ${attrs} rows="2"></textarea>` : type === 'select'
      ? `<select ${attrs}><option value="">–</option>${['Plastic', 'Cardboard', 'Metal', 'Other'].map(value => `<option value="${value}">${label(`spools.spoolMaterial${value}`)}</option>`).join('')}</select>`
      : `<input ${attrs} type="${type}" ${key === 'name' ? 'required' : ''} ${type === 'number' ? 'step="any"' : ''} placeholder="${key === 'name' ? label('manufacturers.namePlaceholder') : '–'}"/>`
    return `<div class="manufacturer-field ${type === 'textarea' ? 'manufacturer-description' : ''}"><label for="manufacturer-dialog-${key}">${label(title).replace(/\s+\((?:g|mm)\)$/, '')}</label><div class="manufacturer-value">${input}${unit ? `<span class="manufacturer-unit">${unit}</span>` : ''}</div></div>`
  }
  const overlay = document.createElement('dialog')
  overlay.className = 'fm-modal-overlay manufacturer-dialog'
  overlay.setAttribute('aria-labelledby', 'manufacturer-dialog-title')
  overlay.innerHTML = `<form data-manufacturer-form class="fm-card manufacturer-panel">
    <header class="manufacturer-header"><div class="manufacturer-toolbar">
      <button type="button" class="fm-btn fm-btn-outline" data-manufacturer-close>${label('common.close')}</button>
      <div class="manufacturer-actions"><span class="manufacturer-changed" hidden>${label('filaments.changed')}</span>
      <button type="button" class="fm-btn fm-btn-outline" data-manufacturer-edit aria-label="${label('manufacturers.editManufacturer')}">${icon('edit')}</button>
      <button type="submit" class="fm-btn fm-btn-primary" data-manufacturer-submit>${label('common.save')}</button>
      <button type="button" class="fm-btn fm-btn-outline" data-manufacturer-cancel>${label('common.cancel')}</button></div></div>
      <div class="manufacturer-identity"><div><div class="manufacturer-number" id="manufacturer-dialog-title"></div>${field(0)}</div><div class="manufacturer-logo" data-manufacturer-logo></div></div>
      <div class="manufacturer-stats" data-manufacturer-stats></div>
    </header>
    <div class="manufacturer-body">
      <div class="manufacturer-columns"><section class="manufacturer-section"><h3>${label('manufacturers.profile')}</h3><div class="manufacturer-section-body">${[1, 2, 3].map(field).join('')}</div></section>
      <section class="manufacturer-section"><h3>${label('common.spoolDefaultSettings')}<small>${label('manufacturers.fallbackValues')}</small></h3><div class="manufacturer-section-body">${[4, 5, 6, 7].map(field).join('')}</div></section></div>
      <div data-manufacturer-sources></div><div class="fm-alert-error hidden" data-manufacturer-error role="alert"></div>
    </div></form>`
  document.body.append(overlay)
  type Input = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  const form = overlay.querySelector<HTMLFormElement>('form')!
  const inputs = Object.fromEntries(fields.map(([key]) => [key, form.elements.namedItem(key) as Input]))
  const submit = overlay.querySelector<HTMLButtonElement>('[data-manufacturer-submit]')!
  const error = overlay.querySelector<HTMLElement>('[data-manufacturer-error]')!
  const sourceContainer = overlay.querySelector<HTMLElement>('[data-manufacturer-sources]')!
  let current: Manufacturer | null = null
  let links: CatalogLinks = {}
  let entries: Record<string, CatalogEntry> = {}
  // Keep fetched display values separate from catalog changes staged by comparison.
  let committedEntries: Record<string, CatalogEntry> = {}
  let baseline = ''
  let editing = false
  let busy = false
  let saveSequence = 0
  let session = 0
  let controller = new AbortController()
  let restoreFocus: HTMLElement | null = null
  const lookups: LookupInstance[] = []
  const pendingLogos = new Map<ManufacturerSource, CatalogEntry>()
  const selectedLogos = new Set<string>()
  const values = () => Object.fromEntries(fields.map(([key, , type]) => [key, type === 'number' ? inputs[key].value === '' ? null : Number(inputs[key].value) : inputs[key].value]))
  const signature = () => JSON.stringify([values(), links])
  const showError = (message: string) => { error.textContent = message; error.classList.remove('hidden') }
  const update = () => {
    const dirty = signature() !== baseline || [...pendingLogos.keys()].some(source => source.saveLogo && selectedLogos.has(source.key))
    form.inert = busy
    form.setAttribute('aria-busy', String(busy))
    submit.disabled = busy || !editing || (!dirty && !!current)
    overlay.querySelector<HTMLElement>('.manufacturer-changed')!.hidden = !dirty || !editing
  }
  const setMode = (edit: boolean) => {
    editing = edit
    overlay.classList.toggle('is-editing', edit)
    for (const input of Object.values(inputs)) {
      if (input instanceof HTMLSelectElement) input.disabled = !edit
      else input.readOnly = !edit
    }
    overlay.querySelector<HTMLElement>('[data-manufacturer-edit]')!.hidden = edit
    submit.hidden = !edit
    overlay.querySelector<HTMLElement>('[data-manufacturer-cancel]')!.hidden = !edit
    update()
  }
  const fill = () => {
    const profile = profileFields(current?.custom_fields)
    const data = { empty_spool_weight_g: 250, spool_outer_diameter_mm: 200, spool_width_mm: 65, ...current, ...profile }
    for (const [key] of fields) inputs[key].value = data[key as keyof typeof data] == null ? '' : String(data[key as keyof typeof data])
    // Retain legacy material values instead of clearing them when the editor opens.
    const material = current?.spool_material
    if (material && !Array.from((inputs.spool_material as HTMLSelectElement).options).some(option => option.value === material)) {
      (inputs.spool_material as HTMLSelectElement).add(new Option(material, material))
      inputs.spool_material.value = material
    }
  }
  const resetDraft = () => {
    fill()
    links = catalogLinks(current?.custom_fields)
    entries = Object.fromEntries(Object.entries(links).flatMap(([key, link]) => {
      const entry = (String(committedEntries[key]?.id) === String(link.id) ? committedEntries[key] : undefined) ?? catalogSnapshot(link.snapshot)
      return entry ? [[key, entry]] : []
    }))
    pendingLogos.clear()
    selectedLogos.clear()
    baseline = signature()
  }
  const safeUrl = (value: unknown) => {
    if (typeof value !== 'string') return ''
    try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' } catch { return '' }
  }
  const logo = () => {
    const draft = [...pendingLogos].filter(([source]) => selectedLogos.has(source.key)).at(-1)?.[1]
    const entry = draft ?? Object.values(entries)[0]
    const url = safeUrl(draft?.logo_url || draft?.label_logo_url || current?.logo_url || current?.label_logo_url || entry?.logo_url || entry?.label_logo_url)
    const holder = overlay.querySelector<HTMLElement>('[data-manufacturer-logo]')!
    holder.innerHTML = url ? `<img src="${e(url)}" alt="${e(inputs.name.value)}"/>` : icon('manufacturers')
    holder.querySelector('img')?.addEventListener('error', () => { holder.innerHTML = icon('manufacturers') }, { once: true })
  }
  const renderStats = () => {
    const stats = overlay.querySelector<HTMLElement>('[data-manufacturer-stats]')!
    stats.hidden = !current
    const count = (key: string) => current?.[key] == null ? '–' : String(current[key])
    if (!current) { stats.replaceChildren(); return }
    const base = `manufacturer_id=${encodeURIComponent(current.id)}&clear_filters=1`
    const filamentUrl = `/filaments?${base}`
    const spoolUrl = (scope: string) => `/spools?${base}&status_scope=${scope}`
    const metric = (key: string, title: string, name: string, href: string, tone: string) =>
      `<a class="manufacturer-metric ${tone}" href="${e(href)}">${icon(name)}<strong>${e(count(key))}</strong><span class="manufacturer-metric-label">${label(title)}</span><span class="manufacturer-metric-arrow" aria-hidden="true">→</span></a>`
    stats.innerHTML = `<div class="manufacturer-metrics">
      ${metric('filament_count', 'manufacturers.filaments', 'filaments', filamentUrl, 'metric-filaments')}
      ${metric('spool_count', 'manufacturers.availableSpools', 'spools', spoolUrl('active'), 'metric-spools')}
      ${metric('archived_spool_count', 'manufacturers.archivedSpools', 'archive', spoolUrl('archived'), 'metric-archived')}
    </div><div class="manufacturer-inventory-context"><div class="manufacturer-materials">${(current.materials as string[] || []).map(material => `<span>${e(material)}</span>`).join('')}</div><div class="manufacturer-values">
      <a href="${e(spoolUrl('active'))}"><span>${label('manufacturers.totalValueAvailable')}</span><strong>${e(formatPrice(current.total_price_available as number, getCurrency()))}</strong></a>
      <a href="${e(spoolUrl('all'))}"><span>${label('manufacturers.totalSpentAllTime')}</span><strong>${e(formatPrice(current.total_price_all as number, getCurrency()))}</strong></a>
    </div></div>`
  }
  const compare = (source: ManufacturerSource, entry: CatalogEntry, host: HTMLElement) => {
    if (busy) return
    const candidates = { name: entry.name, url: entry.website, contact_email: entry.contact_email, description: entry.description }
    const differences = Object.entries(candidates).filter(([key, value]) => value && value !== inputs[key].value)
    const area = host.querySelector<HTMLElement>('[data-catalog-comparison]')!
    area.innerHTML = `<p>${label('manufacturers.compareHelp')}</p>${differences.map(([key, value]) => `<label class="manufacturer-comparison"><input type="checkbox" data-catalog-field="${key}"/><span><b>${label(fields.find(field => field[0] === key)![1])}</b><del>${e(inputs[key].value || '–')}</del><span>${e(value)}</span></span></label>`).join('')}${source.saveLogo && (entry.logo_url || entry.label_logo_url) ? `<label class="manufacturer-comparison"><input type="checkbox" data-catalog-logo ${!current?.logo_url && !current?.label_logo_url ? 'checked' : ''}/><span>${label('manufacturers.useCatalogLogos')}</span></label>` : ''}<button type="button" data-catalog-apply class="fm-btn fm-btn-primary">${label('manufacturers.useSelected')}</button> <button type="button" class="fm-btn fm-btn-outline" data-catalog-cancel>${label('common.cancel')}</button>`
    area.hidden = false
    area.querySelector('[data-catalog-cancel]')!.addEventListener('click', () => { area.hidden = true })
    area.querySelector('[data-catalog-apply]')!.addEventListener('click', () => {
      if (busy) return
      setMode(true)
      for (const input of area.querySelectorAll<HTMLInputElement>('[data-catalog-field]:checked')) {
        const key = input.dataset.catalogField as keyof typeof candidates
        inputs[key].value = candidates[key]
      }
      links = { ...links, [source.key]: { ...links[source.key], id: entry.id, snapshot: entry } }
      entries[source.key] = entry
      if (area.querySelector<HTMLInputElement>('[data-catalog-logo]')?.checked) selectedLogos.add(source.key)
      else selectedLogos.delete(source.key)
      pendingLogos.set(source, entry)
      area.hidden = true
      host.querySelector('h3 small')!.textContent = t('manufacturers.linked')
      renderSourceRecord(source, host); logo(); update()
    })
  }
  const renderSourceRecord = (source: ManufacturerSource, host: HTMLElement) => {
    const entry = entries[source.key]
    const record = host.querySelector<HTMLElement>('[data-catalog-record]')!
    const expanded = record.querySelector<HTMLDetailsElement>('details')?.open ?? false
    const focused = record.contains(document.activeElement)
    host.querySelector<HTMLElement>('.manufacturer-source-summary')!.innerHTML = `<span>${e(source.label)}</span>${entry ? `<strong>${e(entry.name)}</strong>` : ''}`
    const button = host.querySelector<HTMLButtonElement>('[data-catalog-compare]')!
    button.hidden = !entry
    const summary = entry ? (source.summary?.(entry) ?? []).map(value => typeof value === 'string'
      ? `<span>${e(value)}</span>` : `<span class="is-${e(value.tone)}">${e(value.label)}</span>`).join('') : ''
    record.innerHTML = entry ? `<div class="manufacturer-catalog-summary">${summary}</div><details><summary>${label('manufacturers.catalogDetails')}</summary><dl>${Object.entries({ website: entry.website, contact_email: entry.contact_email, description: entry.description, ...entry.details }).map(([key, value]) => `<div><dt>${e(t(`manufacturers.catalog.${key}`) === `manufacturers.catalog.${key}` ? key : t(`manufacturers.catalog.${key}`))}</dt><dd>${e(value == null || value === '' ? '–' : String(value))}</dd></div>`).join('')}</dl>${entry.label_logo_url ? `<img class="manufacturer-print-logo" src="${e(safeUrl(entry.label_logo_url))}" alt="${label('manufacturers.printLogo')}"/>` : ''}</details>` : ''
    const details = record.querySelector<HTMLDetailsElement>('details')
    if (details) details.open = expanded
    if (focused) button?.focus()
  }
  const renderSources = () => {
    for (const lookup of lookups.splice(0)) lookup.destroy()
    sourceContainer.replaceChildren()
    for (const source of sources) {
      const host = document.createElement('section')
      host.className = 'manufacturer-section manufacturer-source'
      host.innerHTML = `<h3><span class="manufacturer-source-summary"></span><span class="manufacturer-source-actions"><small>${links[source.key] ? label('manufacturers.linked') : label('manufacturers.notLinked')}</small><button type="button" class="fm-btn fm-btn-outline" data-catalog-compare hidden>${label('manufacturers.compareValues')}</button></span></h3><div class="manufacturer-section-body">
      <div data-catalog-record></div>
      <details class="manufacturer-lookup-details"><summary>${label('manufacturers.findCatalog')}</summary><div data-catalog-lookup></div></details><div data-catalog-comparison hidden></div><p class="manufacturer-source-error" role="status"></p></div>`
      sourceContainer.append(host)
      renderSourceRecord(source, host)
      host.querySelector('[data-catalog-compare]')!.addEventListener('click', () => compare(source, entries[source.key], host))
      host.querySelector('details.manufacturer-lookup-details')!.addEventListener('toggle', event => {
        if (!(event.target as HTMLDetailsElement).open || host.querySelector('.fdb-lookup')) return
        const activeSession = session
        lookups.push(createFilamentDbLookup<Record<string, unknown>>({
          container: host.querySelector('[data-catalog-lookup]')!, endpoint: source.endpoint,
          placeholder: t('filamentdbLookup.searchManufacturer'), initialQuery: current?.name,
          fuzzyScore: item => fuzzyTokenScore(String(item.name || ''), current?.name || ''),
          renderItem: item => `<span>${e(String(item.name || ''))}</span>`,
          onSelect: item => {
            if (activeSession !== session || !overlay.open || busy) return
            try { compare(source, source.normalize(item), host) } catch { showError(t('manufacturers.failedCatalog')) }
          },
        }))
      })
    }
  }
  const close = () => {
    if (busy) return
    session++
    controller.abort()
    for (const lookup of lookups.splice(0)) lookup.destroy()
    if (overlay.open) overlay.close()
    overlay.classList.remove('open')
    restoreFocus?.focus()
    restoreFocus = null
  }
  const open: ManufacturerDialog['open'] = (manufacturer = null, mode) => {
    controller.abort()
    controller = new AbortController()
    const activeSession = ++session
    current = manufacturer
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    links = catalogLinks(current?.custom_fields)
    entries = Object.fromEntries(Object.entries(links).flatMap(([key, link]) => {
      const entry = catalogSnapshot(link.snapshot)
      return entry ? [[key, entry]] : []
    }))
    committedEntries = { ...entries }
    pendingLogos.clear()
    selectedLogos.clear()
    error.classList.add('hidden')
    fill()
    baseline = signature()
    overlay.querySelector<HTMLElement>('#manufacturer-dialog-title')!.textContent = current ? t('manufacturers.manufacturerNumber', { id: current.id }) : t('manufacturers.addManufacturer')
    setMode(!manufacturer || mode?.mode !== 'view')
    renderStats(); renderSources(); logo()
    overlay.showModal()
    overlay.classList.add('open')
    form.scrollTop = 0
    if (editing) inputs.name.focus()
    for (const source of sources) {
      const link = links[source.key]
      if (!link) continue
      void source.load(link.id, controller.signal).then(entry => {
        if (activeSession !== session || !overlay.open || catalogLinks(current?.custom_fields)[source.key]?.id !== link.id) return
        committedEntries[source.key] = entry
        if (pendingLogos.has(source) || links[source.key]?.id !== link.id) return
        entries[source.key] = entry
        const host = sourceContainer.querySelectorAll<HTMLElement>('.manufacturer-source')[sources.indexOf(source)]
        if (host) renderSourceRecord(source, host)
        logo()
      }).catch(err => {
        if (activeSession !== session || isAbortError(err)) return
        const host = sourceContainer.querySelectorAll('.manufacturer-source')[sources.indexOf(source)]
        if (host) host.querySelector<HTMLElement>('.manufacturer-source-error')!.textContent = t('manufacturers.failedCatalog')
      })
    }
  }
  overlay.querySelector('[data-manufacturer-close]')!.addEventListener('click', close)
  overlay.querySelector('[data-manufacturer-edit]')!.addEventListener('click', () => setMode(true))
  overlay.querySelector('[data-manufacturer-cancel]')!.addEventListener('click', () => {
    if (busy) return
    if (!current) { close(); return }
    resetDraft()
    setMode(false); renderSources(); logo(); error.classList.add('hidden')
  })
  overlay.addEventListener('cancel', event => { event.preventDefault(); close() })
  overlay.addEventListener('click', event => { if (event.target === overlay) close() })
  form.addEventListener('input', update)
  form.addEventListener('change', update)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!editing || busy || !form.reportValidity()) return
    const activeSave = ++saveSequence
    const activeSession = session
    const isCurrent = () => activeSave === saveSequence && activeSession === session && overlay.open
    const data: Record<string, unknown> = values()
    delete data.contact_email; delete data.description
    data.url = data.url || null; data.spool_material = data.spool_material || null
    const profile = { contact_email: inputs.contact_email.value, description: inputs.description.value }
    if (Object.keys(links).length || profile.contact_email || profile.description || current?.custom_fields?.manufacturer_profile) {
      data.custom_fields = withManufacturerMetadata(current?.custom_fields, profile, links)
    }
    const logoJobs = [...pendingLogos].filter(([source]) => selectedLogos.has(source.key))
    busy = true; update(); error.classList.add('hidden')
    try {
      const saved = await request<Manufacturer>(current ? `/manufacturers/${current.id}` : '/manufacturers', { method: current ? 'PATCH' : 'POST', body: JSON.stringify(data), signal: controller.signal })
      let logoFailed = false
      for (const [source, entry] of logoJobs) {
        try { await source.saveLogo?.(saved.id, entry) } catch { logoFailed = true }
      }
      invalidateCachePrefix(CACHE_KEYS.MANUFACTURERS)
      const active = isCurrent()
      if (active) {
        const wasNew = !current
        // Mutation responses do not calculate aggregates; retain the list's inventory stats.
        const stats = Object.fromEntries(['filament_count', 'spool_count', 'archived_spool_count', 'materials', 'total_price_available', 'total_price_all'].filter(key => current?.[key] !== undefined).map(key => [key, current![key]]))
        current = { ...current, ...saved, ...stats }
        if (logoJobs.some(([source]) => source.saveLogo) && !logoFailed) {
          const refreshed = await request<Manufacturer>(`/manufacturers/${saved.id}`, { signal: controller.signal }).catch(() => null)
          if (refreshed) current = { ...current, logo_url: refreshed.logo_url, label_logo_url: refreshed.label_logo_url }
        }
        busy = false
        if (wasNew && !logoFailed) close()
        else {
          committedEntries = { ...entries }
          resetDraft()
          setMode(false); renderStats(); renderSources(); logo()
          if (logoFailed) showError(t('manufacturers.savedLogoFailed'))
        }
      }
      await options.onSaved(saved, active)
    } catch (err) {
      if (isCurrent() && !isAbortError(err)) showError(err instanceof Error ? err.message : t('manufacturers.failedSave'))
    } finally {
      // A previous host refresh must not unlock a newer pending save.
      if (activeSave === saveSequence) { busy = false; update() }
    }
  })
  return { open, close }
}
