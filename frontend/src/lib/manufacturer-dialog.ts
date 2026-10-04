import { getAbortSignal, isAbortError } from './abort'
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
  [key: string]: unknown
}

export type ManufacturerDialog = {
  open: (manufacturer?: Manufacturer | null) => void
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
  filamentDbActive: boolean
  onSaved: (manufacturer: Manufacturer) => void | Promise<void>
}): ManufacturerDialog {
  const overlay = document.createElement('dialog')
  overlay.className = 'fm-modal-overlay'
  overlay.setAttribute('aria-labelledby', 'manufacturer-dialog-title')
  overlay.innerHTML = `
    <div class="fm-card" style="width:100%;max-width:480px;margin:16px;">
      <h3 id="manufacturer-dialog-title" style="font-size:1.1rem;font-weight:600;margin-bottom:16px;"></h3>
      <div class="fdb-mode-toggle" data-manufacturer-mode style="display:none;">
        <label>
          <input type="radio" name="manufacturer-dialog-mode" value="db" />
          <span>${escapeHtml(t('filamentdbLookup.fromDatabase'))}</span>
        </label>
        <label>
          <input type="radio" name="manufacturer-dialog-mode" value="manual" checked />
          <span>${escapeHtml(t('filamentdbLookup.manualEntry'))}</span>
        </label>
      </div>
      <div class="fdb-lookup-section" data-manufacturer-db-lookup style="display:none;">
        <div class="fdb-lookup-section-title">${escapeHtml(t('filamentdbLookup.loadFromDb'))}</div>
        <div data-manufacturer-lookup></div>
        <div data-manufacturer-lookup-toast style="display:none;"></div>
      </div>
      <form data-manufacturer-form style="display:grid;gap:16px;">
        <div>
          <label class="fm-label" for="manufacturer-dialog-name"><span>${escapeHtml(t('manufacturers.name'))}</span> *</label>
          <input id="manufacturer-dialog-name" type="text" required class="fm-input" data-manufacturer-name placeholder="${escapeHtml(t('manufacturers.namePlaceholder'))}" />
        </div>
        <div>
          <label class="fm-label" for="manufacturer-dialog-url">${escapeHtml(t('manufacturers.url'))}</label>
          <input id="manufacturer-dialog-url" type="url" class="fm-input" data-manufacturer-url placeholder="${escapeHtml(t('manufacturers.urlPlaceholder'))}" />
        </div>
        <div class="fm-card" style="padding:16px;margin-top:8px;">
          <h3 class="fm-label" style="font-size:1rem;margin:0 0 16px;color:var(--text);">${escapeHtml(t('common.spoolDefaultSettings'))}</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div>
              <label class="fm-label" for="manufacturer-dialog-empty-weight">${escapeHtml(t('spools.emptySpoolWeight'))}</label>
              <input id="manufacturer-dialog-empty-weight" type="number" step="1" class="fm-input" data-manufacturer-empty-weight />
            </div>
            <div>
              <label class="fm-label" for="manufacturer-dialog-material">${escapeHtml(t('spools.spoolMaterial'))}</label>
              <select id="manufacturer-dialog-material" class="fm-select" data-manufacturer-material>
                <option value="">-</option>
                <option value="Plastic">${escapeHtml(t('spools.spoolMaterialPlastic'))}</option>
                <option value="Cardboard">${escapeHtml(t('spools.spoolMaterialCardboard'))}</option>
                <option value="Metal">${escapeHtml(t('spools.spoolMaterialMetal'))}</option>
                <option value="Other">${escapeHtml(t('spools.spoolMaterialOther'))}</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;">
            <div>
              <label class="fm-label" for="manufacturer-dialog-outer-diameter">${escapeHtml(t('spools.spoolOuterDiameter'))}</label>
              <input id="manufacturer-dialog-outer-diameter" type="number" step="0.1" class="fm-input" data-manufacturer-outer-diameter />
            </div>
            <div>
              <label class="fm-label" for="manufacturer-dialog-width">${escapeHtml(t('spools.spoolWidth'))}</label>
              <input id="manufacturer-dialog-width" type="number" step="0.1" class="fm-input" data-manufacturer-width />
            </div>
          </div>
        </div>
        <div class="fm-alert-error hidden" data-manufacturer-error></div>
        <div style="display:flex;gap:12px;">
          <button type="submit" class="fm-btn fm-btn-primary" data-manufacturer-submit>${escapeHtml(t('common.save'))}</button>
          <button type="button" class="fm-btn fm-btn-outline" data-manufacturer-cancel>${escapeHtml(t('common.cancel'))}</button>
        </div>
      </form>
    </div>
  `
  document.body.appendChild(overlay)

  const title = overlay.querySelector<HTMLElement>('#manufacturer-dialog-title')!
  const form = overlay.querySelector<HTMLFormElement>('[data-manufacturer-form]')!
  const modeToggle = overlay.querySelector<HTMLElement>('[data-manufacturer-mode]')!
  const dbLookup = overlay.querySelector<HTMLElement>('[data-manufacturer-db-lookup]')!
  const lookupContainer = overlay.querySelector<HTMLElement>('[data-manufacturer-lookup]')!
  const lookupToast = overlay.querySelector<HTMLElement>('[data-manufacturer-lookup-toast]')!
  const nameInput = overlay.querySelector<HTMLInputElement>('[data-manufacturer-name]')!
  const urlInput = overlay.querySelector<HTMLInputElement>('[data-manufacturer-url]')!
  const emptyWeightInput = overlay.querySelector<HTMLInputElement>('[data-manufacturer-empty-weight]')!
  const materialInput = overlay.querySelector<HTMLSelectElement>('[data-manufacturer-material]')!
  const outerDiameterInput = overlay.querySelector<HTMLInputElement>('[data-manufacturer-outer-diameter]')!
  const widthInput = overlay.querySelector<HTMLInputElement>('[data-manufacturer-width]')!
  const error = overlay.querySelector<HTMLElement>('[data-manufacturer-error]')!
  const submit = overlay.querySelector<HTMLButtonElement>('[data-manufacturer-submit]')!
  let current: Manufacturer | null = null
  let lookup: LookupInstance | null = null
  let pendingLogoSlug: string | null = null
  let pendingHasLabelLogo = false
  let restoreFocus: HTMLElement | null = null

  const destroyLookup = () => {
    lookup?.destroy()
    lookup = null
    lookupContainer.replaceChildren()
  }

  const onLookupSelect = (item: Record<string, unknown>) => {
    nameInput.value = String(item.name || '')
    urlInput.value = String(item.website || '')
    pendingLogoSlug = item.has_web_logo || item.has_label_logo ? String(item.slug || '') || null : null
    pendingHasLabelLogo = Boolean(item.has_label_logo)
    lookupToast.className = 'fdb-toast fdb-toast-success'
    lookupToast.textContent = t('filamentdbLookup.prefillSuccess')
    lookupToast.style.display = ''
  }

  const initLookup = (initialQuery?: string) => {
    if (lookup) return
    lookup = createFilamentDbLookup<Record<string, unknown>>({
      container: lookupContainer,
      endpoint: '/filamentdb/manufacturers',
      placeholder: t('filamentdbLookup.searchManufacturer'),
      renderItem: (item) => {
        const website = item.website ? `<div class="fdb-lookup-item-sub">${escapeHtml(String(item.website))}</div>` : ''
        const count = item.filament_count
          ? `<span style="color:var(--text-muted);font-size:0.8rem;margin-left:8px;">${escapeHtml(String(item.filament_count))} filaments</span>`
          : ''
        return `<div class="fdb-lookup-item-name">${escapeHtml(String(item.name || ''))}${count}</div>${website}`
      },
      onSelect: onLookupSelect,
      initialQuery,
      fuzzyScore: initialQuery ? (item) => fuzzyTokenScore(String(item.name || ''), initialQuery) : undefined,
    })
  }

  const close = () => {
    if (overlay.open) overlay.close()
    overlay.classList.remove('open')
    destroyLookup()
    restoreFocus?.focus()
    restoreFocus = null
  }
  overlay.addEventListener('cancel', event => {
    event.preventDefault()
    close()
  })

  const open = (manufacturer: Manufacturer | null = null) => {
    current = manufacturer
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    destroyLookup()
    pendingLogoSlug = null
    pendingHasLabelLogo = false
    dbLookup.style.display = 'none'
    lookupToast.style.display = 'none'
    error.classList.add('hidden')
    title.textContent = manufacturer ? t('manufacturers.editManufacturer') : t('manufacturers.addManufacturer')
    nameInput.value = manufacturer?.name || ''
    urlInput.value = manufacturer?.url || ''
    emptyWeightInput.value = manufacturer
      ? manufacturer.empty_spool_weight_g == null
        ? ''
        : String(manufacturer.empty_spool_weight_g)
      : '250'
    materialInput.value = manufacturer?.spool_material || ''
    outerDiameterInput.value = manufacturer
      ? manufacturer.spool_outer_diameter_mm == null
        ? ''
        : String(manufacturer.spool_outer_diameter_mm)
      : '200'
    widthInput.value = manufacturer
      ? manufacturer.spool_width_mm == null
        ? ''
        : String(manufacturer.spool_width_mm)
      : '65'

    modeToggle.style.display = !manufacturer && options.filamentDbActive ? 'flex' : 'none'
    modeToggle.querySelector<HTMLInputElement>('input[value="manual"]')!.checked = true
    if (manufacturer && options.filamentDbActive) {
      initLookup(manufacturer.name)
      dbLookup.style.display = ''
    }
    overlay.showModal()
    overlay.classList.add('open')
    nameInput.focus()
  }

  modeToggle.addEventListener('change', () => {
    const mode = modeToggle.querySelector<HTMLInputElement>('input:checked')?.value
    if (mode === 'db') {
      initLookup()
      dbLookup.style.display = ''
      lookup?.reset()
    } else {
      dbLookup.style.display = 'none'
      pendingLogoSlug = null
      pendingHasLabelLogo = false
    }
    lookupToast.style.display = 'none'
  })
  overlay.querySelector('[data-manufacturer-cancel]')!.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = {
      name: nameInput.value,
      url: urlInput.value || null,
      empty_spool_weight_g: emptyWeightInput.value ? Number(emptyWeightInput.value) : null,
      spool_material: materialInput.value || null,
      spool_outer_diameter_mm: outerDiameterInput.value ? Number(outerDiameterInput.value) : null,
      spool_width_mm: widthInput.value ? Number(widthInput.value) : null,
    }
    error.classList.add('hidden')
    submit.disabled = true
    submit.textContent = t('common.saving')
    try {
      const response = await fetch(current ? `/api/v1/manufacturers/${current.id}` : '/api/v1/manufacturers', {
        method: current ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCsrfToken(),
        },
        credentials: 'include',
        signal: getAbortSignal(),
        body: JSON.stringify(data),
      })
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          detail?: { message?: string }
          message?: string
        }
        throw new Error(errorData.detail?.message || errorData.message || t('manufacturers.failedSave'))
      }
      const saved = (await response.json()) as Manufacturer
      if (pendingLogoSlug) {
        try {
          await fetch(`/api/v1/manufacturers/${saved.id}/download-logo`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': getCsrfToken(),
            },
            credentials: 'include',
            body: JSON.stringify({
              slug: pendingLogoSlug,
              has_label_logo: pendingHasLabelLogo,
            }),
          })
        } catch {
          console.warn('Logo download failed (non-critical)')
        }
      }
      invalidateCachePrefix(CACHE_KEYS.MANUFACTURERS)
      close()
      await options.onSaved(saved)
    } catch (err) {
      if (isAbortError(err)) return
      error.textContent = err instanceof Error ? err.message : t('manufacturers.failedSave')
      error.classList.remove('hidden')
    } finally {
      submit.disabled = false
      submit.textContent = t('common.save')
    }
  })

  return { open, close }
}

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}
