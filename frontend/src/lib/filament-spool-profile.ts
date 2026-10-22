import { request } from './api'
import { escapeHtml } from './extra-fields'
import { createFilamentDbLookup, type LookupInstance } from './filamentdb-lookup'
import { renderFilamentSpoolImage, spoolProfileImageUrl } from './filament-detail'
import { t } from './i18n'

export interface SpoolProfile {
  id: number
  name: string
  empty_weight_g: number | null
  spool_material: string | null
  outer_diameter_mm: number | null
  width_mm: number | null
  image_file?: string | null
}

type ReelValues = Record<string, unknown>
const properties = [
  ['default_spool_weight_g', 'empty_weight_g'],
  ['spool_material', 'spool_material'],
  ['spool_outer_diameter_mm', 'outer_diameter_mm'],
  ['spool_width_mm', 'width_mm'],
] as const

export function matchSpoolProfile(values: ReelValues, profiles: SpoolProfile[]): SpoolProfile[] {
  return profiles.filter(profile => properties.every(([field, catalog]) => {
    const value = values[field]
    if (catalog === 'spool_material') {
      return typeof value === 'string' && !!value.trim() && value.trim().toLowerCase() === profile.spool_material?.trim().toLowerCase()
    }
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value === profile[catalog]
  }))
}

export function createSpoolProfilePicker(form: HTMLFormElement, onChange: (id: number | null, image: string | null) => void) {
  const host = form.querySelector<HTMLElement>('#filament-spool-profile')!
  const status = host.querySelector<HTMLElement>('[role="status"]')!
  const preview = host.querySelector<HTMLElement>('.spool-profile-preview')!
  const lookupHost = host.querySelector<HTMLElement>('.spool-profile-lookup')!
  const choose = host.querySelector<HTMLButtonElement>('.spool-profile-choose')!
  const clear = host.querySelector<HTMLButtonElement>('.spool-profile-clear')!
  let profiles: SpoolProfile[] = []
  let lookup: LookupInstance | undefined
  let selectedId: number | null = null
  let selectedImage: string | null = null
  let pinned = false
  let destroyed = false
  let loaded = false
  let pendingMatch = false

  function render(message?: string) {
    const selected = profiles.find(profile => profile.id === selectedId)
    status.textContent = message ?? selected?.name ?? (selectedId ? `${t('filamentdbLookup.spoolType')} #${selectedId}` : t('filamentdbLookup.noSpoolType'))
    if (!message && !pinned && selected) status.textContent += ` · ${t('filamentdbLookup.matchedSpoolType')}`
    preview.innerHTML = renderFilamentSpoolImage(selectedImage, t('filamentdbLookup.spoolImage'))
    clear.hidden = selectedId == null && !selectedImage
  }
  function select(profile: SpoolProfile) {
    selectedId = profile.id
    selectedImage = profile.image_file ?? null
    render()
    onChange(selectedId, selectedImage)
  }
  function match() {
    if (pinned) return
    if (!loaded) { pendingMatch = true; return }
    const values: ReelValues = {}
    for (const [key] of properties) {
      const input = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement
      values[key] = key === 'spool_material' ? input.value : input.value === '' ? null : Number(input.value)
    }
    const matches = matchSpoolProfile(values, profiles)
    if (matches.length === 1) select(matches[0])
    else {
      selectedId = null
      selectedImage = null
      render(matches.length > 1 ? t('filamentdbLookup.ambiguousSpoolType') : undefined)
      onChange(null, null)
    }
  }
  function chooseProfile() {
    lookupHost.hidden = !lookupHost.hidden
    choose.setAttribute('aria-expanded', String(!lookupHost.hidden))
    if (lookup || lookupHost.hidden) return
    lookup = createFilamentDbLookup<SpoolProfile>({
      container: lookupHost, endpoint: '/filamentdb/spool-profiles',
      placeholder: t('filamentdbLookup.searchSpoolProfile'), minChars: 0, pageSize: 100,
      renderItem(profile) {
        const url = spoolProfileImageUrl(profile.image_file)
        const image = url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()">` : ''
        const details = [profile.empty_weight_g == null ? '' : `${profile.empty_weight_g} g`, profile.spool_material, profile.outer_diameter_mm == null ? '' : `${profile.outer_diameter_mm} × ${profile.width_mm ?? '—'} mm`].filter(Boolean).join(' · ')
        return `<div class="spool-profile-choice">${image}<span><strong>${escapeHtml(profile.name)}</strong><br>${escapeHtml(details)}</span></div>`
      },
      onSelect(profile) {
        pinned = true
        // Explicit selection applies catalog defaults; later measured edits retain the selected reel.
        for (const [field, catalog] of properties) {
          const input = form.elements.namedItem(field) as HTMLInputElement | HTMLSelectElement
          if (profile[catalog] != null) input.value = String(profile[catalog])
        }
        profiles = [...profiles.filter(item => item.id !== profile.id), profile]
        select(profile)
        lookupHost.hidden = true
        choose.setAttribute('aria-expanded', 'false')
      },
    })
  }
  function clearProfile() {
    pinned = false
    selectedId = null
    selectedImage = null
    match()
  }
  choose.addEventListener('click', chooseProfile)
  clear.addEventListener('click', clearProfile)
  return {
    async load() {
      host.hidden = false
      try {
        const all: SpoolProfile[] = []
        let page = 1
        let total = 0
        do {
          const response = await request<{ items: SpoolProfile[]; total: number }>(`/filamentdb/spool-profiles?page=${page++}&page_size=100`)
          if (destroyed) return
          all.push(...response.items)
          total = response.total
          if (!response.items.length) break
        } while (all.length < total)
        profiles = all
        loaded = true
        render()
        if (pendingMatch) match()
      } catch {
        // Catalog outages must not discard an existing saved selection.
        choose.disabled = true
        clear.disabled = true
        choose.title = t('filamentdbLookup.spoolTypesUnavailable')
        status.textContent = t('filamentdbLookup.spoolTypesUnavailable')
      }
    },
    setLink(id: number | null, image: string | null) {
      selectedId = id
      selectedImage = image
      pinned = id != null || image != null
      pendingMatch = false
      render()
    },
    match,
    destroy() {
      destroyed = true
      lookup?.destroy()
      choose.removeEventListener('click', chooseProfile)
      clear.removeEventListener('click', clearProfile)
    },
  }
}
