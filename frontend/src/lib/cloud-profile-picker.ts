/** Per-model Bambu cloud profile picker (shared by spool + filament pages). */

import { api, ApiError, getCsrfToken } from './api'

export type ConnectedModel = {
  model: string
  printer_ids: number[]
  representative_printer_id: number
}

export type ProfileCoverage = {
  model?: string
  mapped?: boolean
  status?: 'not_set' | 'ok' | 'fallback' | 'missing'
  code?: string
  base_name?: string
  source?: string
  nozzle_requested?: number
  nozzle_resolved?: number
  exact_nozzle?: boolean
  fallback_nozzle?: boolean
  expected_name?: string
  standard_nozzles?: Record<string, boolean>
  requested_nozzle_in_cloud?: boolean
}

const STANDARD_NOZZLE_SIZES = [0.2, 0.4, 0.6, 0.8] as const

export type InitPerModelPickerOptions = {
  entityType: 'spool' | 'filament'
  entityId: number
  t: (key: string) => string
  getCsrfToken: () => string
  getAbortSignal: () => AbortSignal | undefined
  isAbortError: (e: unknown) => boolean
  onSaved?: () => void
}

type SelectionVisual =
  | 'empty'
  | 'draft'
  | 'saving'
  | 'valid'
  | 'fallback'
  | 'invalid'
  | 'linked'

type VisualMeta = {
  border: string
  bg: string
  icon: string
  iconColor: string
  label: string
  hint: string
}

function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  )
}

function presetBases(presets: any[]): Set<string> {
  const bases = new Set<string>()
  for (const p of presets) {
    const b = p.baseName || p.displayName || ''
    if (b) bases.add(b)
  }
  return bases
}

function formatNozzleLine(cov: ProfileCoverage | undefined, model: string): string {
  const st = coverageStatus(cov)
  const req = cov?.nozzle_requested
  const res = cov?.nozzle_resolved
  const reqLabel =
    req != null ? `${req} mm` : '0.4 mm (default if printer offline)'

  if (st === 'ok' && res != null) {
    return `Nozzle on ${model}: ${reqLabel} → ${res} mm cloud variant (exact match)`
  }
  if (st === 'fallback' && res != null) {
    return `Nozzle on ${model}: ${reqLabel} → ${res} mm cloud variant (closest available; no exact ${reqLabel} preset)`
  }
  if (st === 'missing') {
    return `Nozzle on ${model}: ${reqLabel} — no cloud preset for this model (see red nozzle badges)`
  }
  return `Nozzle on ${model}: ${reqLabel} (from live printer, or spool/filament default)`
}

function formatCloudNameLine(
  cov: ProfileCoverage | undefined,
  baseName: string,
  model: string
): string {
  const st = coverageStatus(cov)
  const nozzle = cov?.nozzle_requested ?? 0.4
  const expected =
    cov?.expected_name ||
    (baseName ? `${baseName} @BBL ${model} ${nozzle}g nozzle` : '')

  if (!baseName) {
    return `Selectable profiles must exist in Bambu cloud with an @BBL ${model} or @Bambu Lab ${model} suffix and nozzle size.`
  }
  if (st === 'ok' || st === 'fallback') {
    const code = cov?.code ? ` (${cov.code})` : ''
    const resolved = cov?.nozzle_resolved ?? nozzle
    const suffix =
      resolved === 0.4
        ? `@BBL ${model} or @BBL ${model} 0.4 nozzle (stock on any model often omits 0.4)`
        : `@BBL ${model} ${resolved}g nozzle`
    return `Matched cloud preset${code}. Studio name ends with ${suffix}.`
  }
  if (st === 'missing') {
    if (nozzle === 0.4) {
      return `To make "${baseName}" work on ${model}, create/sync as ${expected} — stock 0.4 mm may use @BBL ${model} only.`
    }
    return `To make "${baseName}" work on ${model}, create/sync in Bambu Studio as: ${expected}`
  }
  if (nozzle === 0.4) {
    return `Stock ${model} 0.4 mm presets are often named @BBL ${model} only (all models); other sizes include the nozzle (0.2, 0.6, 0.8 …).`
  }
  return `In Bambu Studio, ${model} presets are named like: Your Profile Name @BBL ${model} ${nozzle}g nozzle`
}

function renderPickerMeta(
  cov: ProfileCoverage | undefined,
  baseName: string,
  model: string
): string {
  const cloudLine = formatCloudNameLine(cov, baseName, model)
  const st = coverageStatus(cov)
  const cloudStyle =
    st === 'missing'
      ? 'color:var(--warning-text, #b8860b); font-weight:500;'
      : ''
  return `<div class="profile-picker-meta" style="margin-top:8px; padding-top:8px; border-top:1px solid var(--border,#333); font-size:0.72rem; color:var(--text-muted); line-height:1.45;">
    ${baseName ? `<div style="margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;gap:4px;"><span style="font-size:0.7rem;">Cloud variants:</span>${renderStandardNozzleBadges(cov, baseName)}</div>` : ''}
    <div class="profile-picker-nozzle-line">${escapeHtml(formatNozzleLine(cov, model))}</div>
    <div class="profile-picker-cloud-line" style="margin-top:4px; ${cloudStyle}">${escapeHtml(cloudLine)}</div>
  </div>`
}

function stdNozzleAvailable(
  std: Record<string, boolean> | undefined,
  n: number
): boolean {
  if (!std) return false
  return std[`${n}`] === true || std[`${n.toFixed(1)}`] === true
}

function renderStandardNozzleBadges(
  cov: ProfileCoverage | undefined,
  baseName: string
): string {
  if (!baseName) return ''
  const std = cov?.standard_nozzles
  const req = cov?.nozzle_requested ?? 0.4
  const parts = STANDARD_NOZZLE_SIZES.map((n) => {
    const available = stdNozzleAvailable(std, n)
    const requested = Math.abs(n - req) < 0.06
    const color = available ? 'var(--success-text)' : 'var(--error-text)'
    const border = available ? 'var(--success-border)' : 'var(--error-border)'
    const bg = available ? 'var(--success-bg)' : 'var(--error-bg)'
    const ring = requested
      ? 'outline:2px solid var(--accent,#3b82f6); outline-offset:1px;'
      : ''
    const title = available
      ? `${n} mm cloud variant exists`
      : `${n} mm cloud variant missing — create in Bambu Studio and sync`
    return `<span title="${escapeHtml(title)}" style="font-size:0.65rem;padding:1px 7px;border-radius:999px;border:1px solid ${border};color:${color};background:${bg};${ring}">${n}</span>`
  })
  return `<span class="profile-std-nozzles" style="display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;margin-left:4px;" title="Green = in cloud for this profile/model; red = missing; ring = printer nozzle">${parts.join('')}</span>`
}

function rowNozzleBadge(cov?: ProfileCoverage, baseName = ''): string {
  return renderStandardNozzleBadges(cov, baseName)
}

function coverageStatus(c?: ProfileCoverage): ProfileCoverage['status'] {
  if (!c) return 'not_set'
  if (c.status) return c.status
  if (c.mapped) return c.fallback_nozzle ? 'fallback' : 'ok'
  return c.base_name ? 'missing' : 'not_set'
}

function visualMeta(
  visual: SelectionVisual,
  cov?: ProfileCoverage,
  linked = false
): VisualMeta {
  const nozzle =
    cov?.nozzle_resolved != null ? `${cov.nozzle_resolved} mm nozzle` : ''
  const code = cov?.code ? ` · ${cov.code}` : ''

  switch (visual) {
    case 'saving':
      return {
        border: 'var(--accent, #3b82f6)',
        bg: 'rgba(59, 130, 246, 0.08)',
        icon: '…',
        iconColor: 'var(--accent, #3b82f6)',
        label: 'Saving…',
        hint: '',
      }
    case 'draft':
      return {
        border: 'var(--warning-text, #b8860b)',
        bg: 'rgba(247, 200, 106, 0.1)',
        icon: '!',
        iconColor: 'var(--warning-text, #b8860b)',
        label: 'Not saved',
        hint: 'Pick a profile from the dropdown — typed text alone is not saved',
      }
    case 'valid':
      return {
        border: 'var(--success-border)',
        bg: 'var(--success-bg)',
        icon: '✓',
        iconColor: 'var(--success-text)',
        label: linked ? 'Linked profile' : 'Profile saved',
        hint: nozzle
          ? `Resolves for this printer${code}`
          : `Saved in FilaMan${code}`,
      }
    case 'fallback':
      return {
        border: 'var(--warning-text, #b8860b)',
        bg: 'rgba(247, 200, 106, 0.12)',
        icon: '≈',
        iconColor: 'var(--warning-text, #b8860b)',
        label: linked ? 'Linked (closest nozzle)' : 'Closest nozzle used',
        hint:
          (cov?.expected_name
            ? `Expected ${cov.expected_name}. `
            : '') +
          (nozzle ? `Using ${nozzle}${code}` : 'Exact nozzle variant not in cloud'),
      }
    case 'invalid':
      return {
        border: 'var(--error-border)',
        bg: 'var(--error-bg)',
        icon: '✕',
        iconColor: 'var(--error-text)',
        label: 'No cloud preset for this model',
        hint:
          cov?.expected_name ||
          'This name is not available for this printer model — pick another profile or create it in Bambu Studio',
      }
    case 'linked':
      return {
        border: 'var(--border, #444)',
        bg: 'transparent',
        icon: '↪',
        iconColor: 'var(--text-muted)',
        label: 'Using default profile',
        hint: 'Matches the default profile above unless you override for this model',
      }
    case 'empty':
    default:
      return {
        border: 'var(--border, #444)',
        bg: 'transparent',
        icon: '○',
        iconColor: 'var(--text-muted)',
        label: 'No profile selected',
        hint: 'Search and choose a profile from the list',
      }
  }
}

function isProfileInvalid(
  cov: ProfileCoverage | undefined,
  selectedBase: string
): boolean {
  if (!selectedBase) return false
  if (cov?.mapped === false) return true
  return coverageStatus(cov) === 'missing'
}

function displayBaseForPicker(
  selectedBase: string,
  cov: ProfileCoverage | undefined,
  presets: any[]
): string {
  if (!selectedBase) return ''
  if (isProfileInvalid(cov, selectedBase)) return ''
  if (presets.length > 0 && !presetBases(presets).has(selectedBase)) return ''
  return selectedBase
}

function renderStaleNotice(staleBase: string, model: string): string {
  if (!staleBase) return ''
  return `<p class="profile-stale-notice" style="margin:0 0 8px;font-size:0.8rem;color:var(--warning-text,#b8860b);">Previously saved <strong>${escapeHtml(staleBase)}</strong> is not available for ${escapeHtml(model)} in Bambu cloud — pick a compatible profile below.</p>`
}

function committedVisual(
  baseName: string,
  presets: any[],
  cov?: ProfileCoverage
): SelectionVisual {
  if (!baseName) return 'empty'
  if (cov?.mapped === true) return cov.fallback_nozzle ? 'fallback' : 'valid'
  if (cov?.mapped === false) return 'invalid'
  const st = coverageStatus(cov)
  if (st === 'ok') return 'valid'
  if (st === 'fallback') return 'fallback'
  if (st === 'missing') return 'invalid'
  if (presets.length > 0 && !presetBases(presets).has(baseName)) return 'invalid'
  return 'empty'
}

function applyShellState(
  shell: HTMLElement,
  visual: SelectionVisual,
  meta: VisualMeta,
  cov?: ProfileCoverage,
  baseName = '',
  model = ''
) {
  shell.dataset.state = visual
  shell.style.borderColor = meta.border
  shell.style.background = meta.bg

  const icon = shell.querySelector('.profile-picker-icon') as HTMLElement | null
  const statusLabel = shell.querySelector('.profile-picker-status-label') as HTMLElement | null
  const hint = shell.querySelector('.profile-picker-hint') as HTMLElement | null
  const metaEl = shell.querySelector('.profile-picker-meta') as HTMLElement | null

  if (icon) {
    icon.textContent = meta.icon
    icon.style.color = meta.iconColor
  }
  if (statusLabel) {
    statusLabel.textContent = meta.label
    statusLabel.style.color = meta.iconColor
  }
  if (hint) {
    hint.textContent = meta.hint
    hint.style.display = meta.hint ? 'block' : 'none'
  }
  if (metaEl && model) {
    metaEl.outerHTML = renderPickerMeta(cov, baseName, model)
  }
}

function renderPickerShell(
  innerHtml: string,
  visual: SelectionVisual,
  meta: VisualMeta,
  cov?: ProfileCoverage,
  baseName = '',
  model = ''
): string {
  const metaBlock = model ? renderPickerMeta(cov, baseName, model) : ''
  return `<div class="profile-picker-shell" data-state="${visual}" style="border:1px solid ${meta.border}; background:${meta.bg}; border-radius:8px; padding:10px 12px;">
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:${meta.hint ? '6px' : '0'};">
      <span class="profile-picker-icon" style="flex-shrink:0; width:18px; text-align:center; font-weight:700; font-size:0.9rem; color:${meta.iconColor};">${escapeHtml(meta.icon)}</span>
      <span class="profile-picker-status-label" style="font-size:0.75rem; font-weight:600; color:${meta.iconColor};">${escapeHtml(meta.label)}</span>
    </div>
    ${innerHtml}
    <p class="profile-picker-hint" style="margin:6px 0 0; font-size:0.75rem; color:var(--text-muted); line-height:1.35; display:${meta.hint ? 'block' : 'none'};">${escapeHtml(meta.hint)}</p>
    ${metaBlock}
  </div>`
}

function renderCombo(
  presets: any[],
  selectedBase: string,
  placeholder: string,
  dataModel: string,
  cov?: ProfileCoverage
): string {
  const visual = committedVisual(selectedBase, presets, cov)
  const meta = visualMeta(visual, cov)
  const inner = `<div class="cloud-combo per-model-combo" data-model="${escapeHtml(dataModel)}" style="position:relative;">
    <input type="hidden" class="slicer-profile-base" value="${escapeHtml(selectedBase)}" />
    <input type="text" class="fm-input cloud-combo-search" autocomplete="off" spellcheck="false"
      placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(selectedBase)}" style="width:100%; margin:0;" />
    <div class="cloud-combo-list" style="display:none; position:absolute; z-index:50; left:0; right:0; max-height:260px; overflow-y:auto; background:var(--surface, #1e1e1e); border:1px solid var(--border, #444); border-radius:6px; margin-top:2px; box-shadow:0 4px 16px rgba(0,0,0,0.3);"></div>
  </div>`
  return renderPickerShell(inner, visual, meta, cov, selectedBase, dataModel)
}

function renderLinkedCard(
  baseName: string,
  model: string,
  cov?: ProfileCoverage,
  missing = false
): string {
  if (missing) {
    const meta = visualMeta('invalid', cov)
    const inner = `<p style="margin:0; font-size:0.9rem; color:var(--text);">${escapeHtml(baseName)}</p>`
    return renderPickerShell(inner, 'invalid', meta, cov, baseName, model)
  }
  const visual = committedVisual(baseName, [], cov)
  const meta = visualMeta(visual, cov, true)
  const inner = `<p style="margin:0; font-size:0.9rem; font-weight:500; color:var(--text);">${escapeHtml(baseName)}</p>`
  return renderPickerShell(inner, visual, meta, cov, baseName, model)
}

function updateComboVisual(
  mount: HTMLElement,
  presets: any[],
  cov?: ProfileCoverage,
  mode: 'committed' | 'draft' | 'saving' = 'committed',
  model = ''
) {
  const shell = mount.querySelector('.profile-picker-shell') as HTMLElement | null
  const hidden = mount.querySelector('.slicer-profile-base') as HTMLInputElement | null
  const search = mount.querySelector('.cloud-combo-search') as HTMLInputElement | null
  if (!shell || !hidden) return

  let visual: SelectionVisual
  if (mode === 'saving') {
    visual = 'saving'
  } else if (mode === 'draft' && search && search.value.trim() !== hidden.value) {
    visual = 'draft'
  } else {
    visual = committedVisual(hidden.value, presets, cov)
  }
  applyShellState(shell, visual, visualMeta(visual, cov), cov, hidden.value, model)
}

function wireCombo(
  mount: HTMLElement,
  presets: any[],
  cov: ProfileCoverage | undefined,
  model: string,
  onSelect: (baseName: string) => void | Promise<void>,
  onError: (message: string) => void
) {
  const combo = mount.querySelector('.cloud-combo') as HTMLElement
  if (!combo) return

  const hidden = combo.querySelector('.slicer-profile-base') as HTMLInputElement
  const search = combo.querySelector('.cloud-combo-search') as HTMLInputElement
  const list = combo.querySelector('.cloud-combo-list') as HTMLElement

  const renderList = (query: string) => {
    const q = query.trim().toLowerCase()
    const matches = (q
      ? presets.filter((p: any) =>
          (p.displayName || p.baseName || '').toLowerCase().includes(q)
        )
      : presets
    ).slice(0, 200)
    if (matches.length === 0) {
      list.innerHTML = `<div style="padding:8px 10px; color:var(--text-muted); font-size:0.85rem;">No matches</div>`
      return
    }
    list.innerHTML = matches
      .map((p: any) => {
        const base = p.baseName || p.displayName || ''
        const sel =
          base === hidden.value
            ? ' style="background:var(--accent-muted, rgba(59,130,246,0.15));"'
            : ''
        return `<div class="cloud-combo-opt" data-base="${escapeHtml(base)}"${sel}
          style="padding:7px 10px; cursor:pointer; font-size:0.85rem;">${escapeHtml(base)}</div>`
      })
      .join('')
    list.querySelectorAll('.cloud-combo-opt').forEach((opt: Element) => {
      opt.addEventListener('mousedown', (ev: Event) => {
        ev.preventDefault()
        const base = (opt as HTMLElement).dataset.base || ''
        hidden.value = base
        search.value = base
        list.style.display = 'none'
        updateComboVisual(mount, presets, cov, 'saving', model)
        void Promise.resolve(onSelect(base)).catch((e: unknown) => {
          onError(formatApiError(e))
          updateComboVisual(mount, presets, cov, 'committed', model)
        })
      })
    })
  }

  search.addEventListener('focus', () => {
    renderList('')
    list.style.display = 'block'
  })
  search.addEventListener('input', () => {
    renderList(search.value)
    list.style.display = 'block'
    updateComboVisual(
      mount,
      presets,
      cov,
      search.value.trim() === hidden.value ? 'committed' : 'draft',
      model
    )
  })
  search.addEventListener('blur', () => {
    setTimeout(() => {
      list.style.display = 'none'
      search.value = hidden.value
      updateComboVisual(mount, presets, cov, 'committed', model)
    }, 150)
  })

  updateComboVisual(mount, presets, cov, 'committed', model)
}

async function fetchConnectedModels(
  printerId: number,
  opts: InitPerModelPickerOptions
): Promise<ConnectedModel[]> {
  const res = await fetch(
    `/api/v1/printers/${printerId}/driver/connected-models`,
    { credentials: 'include', signal: opts.getAbortSignal() }
  )
  if (!res.ok) throw new Error('connected-models failed')
  const json = await res.json().catch(() => ({}))
  return json?.models || []
}

async function fetchProfileCoverage(
  printerId: number,
  params: Record<string, number>,
  opts: InitPerModelPickerOptions
): Promise<{
  default_base_name?: string
  profiles_by_model?: Record<string, any>
  coverage?: Record<string, ProfileCoverage>
}> {
  const qs = new URLSearchParams()
  if (params.spool_id != null) qs.set('spool_id', String(params.spool_id))
  if (params.filament_id != null) qs.set('filament_id', String(params.filament_id))
  const res = await fetch(
    `/api/v1/printers/${printerId}/driver/profile-coverage?${qs}`,
    { credentials: 'include', signal: opts.getAbortSignal() }
  )
  if (!res.ok) throw new Error('profile-coverage failed')
  return res.json().catch(() => ({}))
}

async function ensureCsrfToken(opts: InitPerModelPickerOptions): Promise<string> {
  let token = opts.getCsrfToken() || getCsrfToken() || ''
  if (token) return token
  await fetch('/api/v1/me', {
    credentials: 'include',
    signal: opts.getAbortSignal(),
  })
  token = opts.getCsrfToken() || getCsrfToken() || ''
  return token
}

async function apiPostWithCsrf(
  opts: InitPerModelPickerOptions,
  path: string,
  body: unknown
): Promise<any> {
  const csrfToken = await ensureCsrfToken(opts)
  return api.post(path, body, { csrfToken })
}

async function saveDefaultProfile(
  opts: InitPerModelPickerOptions,
  baseName: string,
  applyToExisting = false
): Promise<any> {
  if (opts.entityType === 'spool') {
    return apiPostWithCsrf(opts, `/spools/${opts.entityId}/slicer-profile/default`, {
      base_name: baseName,
    })
  }
  return apiPostWithCsrf(opts, `/filaments/${opts.entityId}/slicer-profile/default`, {
    base_name: baseName,
    apply_to_existing: applyToExisting,
  })
}

async function saveModelProfile(
  opts: InitPerModelPickerOptions,
  model: string,
  baseName: string
): Promise<any> {
  const body = { base_name: baseName }
  if (opts.entityType === 'spool') {
    return apiPostWithCsrf(
      opts,
      `/spools/${opts.entityId}/slicer-profile/models/${encodeURIComponent(model)}`,
      body
    )
  }
  return apiPostWithCsrf(
    opts,
    `/filaments/${opts.entityId}/slicer-profile/models/${encodeURIComponent(model)}`,
    body
  )
}

async function clearModelProfileOverride(
  opts: InitPerModelPickerOptions,
  model: string
): Promise<any> {
  const body = { clear_override: true }
  if (opts.entityType === 'spool') {
    return apiPostWithCsrf(
      opts,
      `/spools/${opts.entityId}/slicer-profile/models/${encodeURIComponent(model)}`,
      body
    )
  }
  return apiPostWithCsrf(
    opts,
    `/filaments/${opts.entityId}/slicer-profile/models/${encodeURIComponent(model)}`,
    body
  )
}

function formatApiError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'csrf_failed') {
      return 'Session expired or CSRF token missing — refresh the page and try again'
    }
    return e.message
  }
  if (e instanceof Error) return e.message
  return 'Could not save profile'
}

async function loadCloudPresetsForModel(
  printerId: number,
  model: string,
  opts: InitPerModelPickerOptions
): Promise<any[]> {
  const qs = new URLSearchParams({ group: 'base', model })
  const res = await fetch(
    `/api/v1/printers/${printerId}/driver/cloud-presets?${qs}`,
    { credentials: 'include', signal: opts.getAbortSignal() }
  )
  if (!res.ok) return []
  const data = await res.json()
  const modelKey = model.trim().toUpperCase()
  return (data.presets || []).filter(
    (p: any) => !p.model || String(p.model).toUpperCase() === modelKey
  )
}

function rowHeaderBadge(model: string, c?: ProfileCoverage, baseName = ''): string {
  const raw = baseName || c?.base_name || ''
  const badges = rowNozzleBadge(c, raw)
  if (!c) return badges
  const visual = committedVisual(raw, [], c)
  if (visual === 'empty' || visual === 'invalid') return badges
  const meta = visualMeta(visual, c)
  return `${badges}<span class="profile-row-badge" title="${escapeHtml(meta.hint || meta.label)}" style="font-size:0.7rem;padding:1px 7px;border-radius:999px;border:1px solid ${meta.border};color:${meta.iconColor};">${escapeHtml(meta.label)}</span>`
}

function renderPickerHelp(connectedModels: ConnectedModel[]): string {
  const modelList = connectedModels.map((m) => m.model).join(', ') || 'your printers'
  return `<div class="profile-picker-help" style="margin-bottom:16px; padding:12px 14px; border-radius:8px; border:1px solid var(--border,#333); background:rgba(255,255,255,0.03); font-size:0.78rem; color:var(--text-muted); line-height:1.5;">
    <strong style="color:var(--text);">Default profile</strong> — pick one profile name; the list includes any preset available on at least one of your connected models (${escapeHtml(modelList)}).
    FilaMan resolves the correct Bambu cloud variant per model automatically (see badges — ✕ means create that variant or override below).
    Override a model only when it needs a different profile than the default.
    Stock 0.4&nbsp;mm presets often use <code style="font-size:0.75rem;color:var(--text);">@BBL &lt;model&gt;</code> without the nozzle size in the name.
  </div>`
}

type DefaultVisual = SelectionVisual | 'partial'

function defaultProfileVisual(
  defaultBase: string,
  models: ConnectedModel[],
  coverage: Record<string, ProfileCoverage>
): DefaultVisual {
  if (!defaultBase) return 'empty'
  const statuses = models.map((m) => coverageStatus(coverage[m.model]))
  const okish = statuses.filter((s) => s === 'ok' || s === 'fallback').length
  if (okish === models.length) {
    return statuses.some((s) => s === 'fallback') ? 'fallback' : 'valid'
  }
  if (okish > 0) return 'partial'
  if (statuses.some((s) => s === 'missing')) return 'invalid'
  return 'empty'
}

function defaultVisualMeta(
  visual: DefaultVisual,
  models: ConnectedModel[],
  coverage: Record<string, ProfileCoverage>
): VisualMeta {
  if (visual === 'partial') {
    const missing = models
      .filter((m) => {
        const st = coverageStatus(coverage[m.model])
        return st !== 'ok' && st !== 'fallback'
      })
      .map((m) => m.model)
    return {
      border: 'var(--warning-text, #b8860b)',
      bg: 'rgba(247, 200, 106, 0.12)',
      icon: '≈',
      iconColor: 'var(--warning-text, #b8860b)',
      label: 'Partial coverage',
      hint:
        missing.length > 0
          ? `No cloud variant on: ${missing.join(', ')} — create in Bambu Studio or override below`
          : 'Some models need a cloud preset for this profile',
    }
  }
  if (visual === 'valid' || visual === 'fallback' || visual === 'invalid') {
    return visualMeta(visual)
  }
  return visualMeta('empty')
}

function renderDefaultCoverageStrip(
  models: ConnectedModel[],
  defaultBase: string,
  coverage: Record<string, ProfileCoverage>
): string {
  if (!defaultBase) return ''
  const parts = models.map((m) => {
    const c = coverage[m.model]
    const st = coverageStatus(c)
    const ok = st === 'ok' || st === 'fallback'
    const icon = ok ? '✓' : '✕'
    const color = ok ? 'var(--success-text)' : 'var(--error-text)'
    const title =
      st === 'missing'
        ? c?.expected_name || `No ${m.model} variant in cloud`
        : `${m.model}: ${c?.code || 'resolved'}`
    return `<span title="${escapeHtml(title)}" style="font-size:0.72rem;padding:2px 8px;border-radius:999px;border:1px solid var(--border,#444);color:${color};">${escapeHtml(m.model)} ${icon}</span>`
  })
  return `<div class="default-coverage-strip" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center;"><span style="font-size:0.7rem;color:var(--text-muted);">Variants:</span>${parts.join('')}</div>`
}

function isOverrideSource(source?: string): boolean {
  return source === 'override' || source === 'manual'
}

function modelGridTemplateColumns(modelCount: number): string {
  if (modelCount <= 1) return 'minmax(0, 1fr)'
  if (modelCount === 2) return 'repeat(2, minmax(0, 1fr))'
  return 'repeat(auto-fit, minmax(260px, 1fr))'
}

function mergeDefaultPresets(modelLists: any[][]): any[] {
  const seen = new Map<string, any>()
  for (const presets of modelLists) {
    for (const p of presets) {
      const b = (p.baseName || p.displayName || '').trim()
      if (b && !seen.has(b)) {
        seen.set(b, { ...p, baseName: b, displayName: b })
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) =>
    (a.baseName || '').localeCompare(b.baseName || '')
  )
}

function renderDefaultCombo(
  presets: any[],
  defaultBase: string,
  models: ConnectedModel[],
  coverage: Record<string, ProfileCoverage>,
  placeholder: string
): string {
  const visual = defaultProfileVisual(defaultBase, models, coverage)
  const meta = defaultVisualMeta(visual, models, coverage)
  const inner = `<div class="cloud-combo default-profile-combo" data-model="default" style="position:relative;">
    <input type="hidden" class="slicer-profile-base" value="${escapeHtml(defaultBase)}" />
    <input type="text" class="fm-input cloud-combo-search" autocomplete="off" spellcheck="false"
      placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultBase)}" style="width:100%; margin:0;" />
    <div class="cloud-combo-list" style="display:none; position:absolute; z-index:50; left:0; right:0; max-height:260px; overflow-y:auto; background:var(--surface, #1e1e1e); border:1px solid var(--border, #444); border-radius:6px; margin-top:2px; box-shadow:0 4px 16px rgba(0,0,0,0.3);"></div>
  </div>${renderDefaultCoverageStrip(models, defaultBase, coverage)}`
  return renderPickerShell(inner, visual === 'partial' ? 'fallback' : visual, meta, undefined, defaultBase, '')
}

function updateDefaultComboVisual(
  mount: HTMLElement,
  presets: any[],
  defaultBase: string,
  models: ConnectedModel[],
  coverage: Record<string, ProfileCoverage>,
  mode: 'committed' | 'draft' | 'saving' = 'committed'
) {
  const shell = mount.querySelector('.profile-picker-shell') as HTMLElement | null
  const hidden = mount.querySelector('.slicer-profile-base') as HTMLInputElement | null
  const search = mount.querySelector('.cloud-combo-search') as HTMLInputElement | null
  if (!shell || !hidden) return

  let visual: DefaultVisual
  if (mode === 'saving') {
    visual = 'saving'
  } else if (mode === 'draft' && search && search.value.trim() !== hidden.value) {
    visual = 'draft'
  } else {
    visual = defaultProfileVisual(hidden.value, models, coverage)
  }
  const meta = defaultVisualMeta(visual, models, coverage)
  applyShellState(
    shell,
    visual === 'partial' ? 'fallback' : visual,
    meta,
    undefined,
    hidden.value,
    ''
  )
  const strip = mount.querySelector('.default-coverage-strip')
  if (strip) {
    strip.outerHTML = renderDefaultCoverageStrip(models, hidden.value, coverage)
  }
}

function wireDefaultCombo(
  mount: HTMLElement,
  presets: any[],
  models: ConnectedModel[],
  coverage: Record<string, ProfileCoverage>,
  onSelect: (baseName: string) => void | Promise<void>,
  onError: (message: string) => void
) {
  const combo = mount.querySelector('.cloud-combo') as HTMLElement
  if (!combo) return

  const hidden = combo.querySelector('.slicer-profile-base') as HTMLInputElement
  const search = combo.querySelector('.cloud-combo-search') as HTMLInputElement
  const list = combo.querySelector('.cloud-combo-list') as HTMLElement

  const renderList = (query: string) => {
    const q = query.trim().toLowerCase()
    const matches = (q
      ? presets.filter((p: any) =>
          (p.displayName || p.baseName || '').toLowerCase().includes(q)
        )
      : presets
    ).slice(0, 200)
    if (matches.length === 0) {
      list.innerHTML = `<div style="padding:8px 10px; color:var(--text-muted); font-size:0.85rem;">No matches</div>`
      return
    }
    list.innerHTML = matches
      .map((p: any) => {
        const base = p.baseName || p.displayName || ''
        const sel =
          base === hidden.value
            ? ' style="background:var(--accent-muted, rgba(59,130,246,0.15));"'
            : ''
        return `<div class="cloud-combo-opt" data-base="${escapeHtml(base)}"${sel}
          style="padding:7px 10px; cursor:pointer; font-size:0.85rem;">${escapeHtml(base)}</div>`
      })
      .join('')
    list.querySelectorAll('.cloud-combo-opt').forEach((opt: Element) => {
      opt.addEventListener('mousedown', (ev: Event) => {
        ev.preventDefault()
        const base = (opt as HTMLElement).dataset.base || ''
        hidden.value = base
        search.value = base
        list.style.display = 'none'
        updateDefaultComboVisual(mount, presets, base, models, coverage, 'saving')
        void Promise.resolve(onSelect(base)).catch((e: unknown) => {
          onError(formatApiError(e))
          updateDefaultComboVisual(
            mount,
            presets,
            hidden.value,
            models,
            coverage,
            'committed'
          )
        })
      })
    })
  }

  search.addEventListener('focus', () => {
    renderList('')
    list.style.display = 'block'
  })
  search.addEventListener('input', () => {
    renderList(search.value)
    list.style.display = 'block'
    updateDefaultComboVisual(
      mount,
      presets,
      hidden.value,
      models,
      coverage,
      search.value.trim() === hidden.value ? 'committed' : 'draft'
    )
  })
  search.addEventListener('blur', () => {
    setTimeout(() => {
      list.style.display = 'none'
      search.value = hidden.value
      updateDefaultComboVisual(mount, presets, hidden.value, models, coverage, 'committed')
    }, 150)
  })

  updateDefaultComboVisual(
    mount,
    presets,
    hidden.value,
    models,
    coverage,
    'committed'
  )
}

function renderLinkedToDefault(
  effectiveBase: string,
  model: string,
  cov?: ProfileCoverage
): string {
  const visual = committedVisual(effectiveBase, [], cov)
  const meta = visualMeta(visual === 'empty' ? 'linked' : visual, cov, true)
  const inner = `<p style="margin:0; font-size:0.9rem; color:var(--text);"><span style="color:var(--text-muted);">↪</span> ${escapeHtml(effectiveBase)}</p>`
  return renderPickerShell(inner, visual === 'empty' ? 'linked' : visual, meta, cov, effectiveBase, model)
}

export async function initPerModelProfilePicker(
  opts: InitPerModelPickerOptions
): Promise<number> {
  const section = document.getElementById('slicer-profile-section')
  const picker = document.getElementById('slicer-profile-picker')
  const coverageEl = document.getElementById('slicer-profile-coverage')
  const msgEl = document.getElementById('slicer-profile-msg')
  if (!section || !picker) return 0

  const showMsg = (text: string, isError: boolean) => {
    if (!msgEl) return
    msgEl.textContent = text
    msgEl.style.color = isError ? 'var(--error-text)' : 'var(--success-text)'
    msgEl.classList.remove('hidden')
    setTimeout(() => msgEl.classList.add('hidden'), 4000)
  }

  try {
    const res = await fetch('/api/v1/printers', {
      credentials: 'include',
      signal: opts.getAbortSignal(),
    })
    if (!res.ok) return 0
    const data = await res.json()
    const bambuPrinters = (data.items || data || []).filter(
      (p: any) => p.driver_key === 'bambuddy'
    )
    if (!bambuPrinters.length) return 0

    let rep = 0
    for (const p of bambuPrinters) {
      try {
        const h = await fetch(`/api/v1/printers/${p.id}/driver/health`, {
          credentials: 'include',
          signal: opts.getAbortSignal(),
        })
        if (h.ok) {
          const hj = await h.json()
          if (hj && (hj.connected || hj.running)) {
            rep = p.id
            break
          }
        }
      } catch {}
    }
    if (!rep) rep = bambuPrinters[0].id

    const modelsResult = await fetchConnectedModels(rep, opts)
    const models: ConnectedModel[] = modelsResult || []
    if (!models.length) {
      picker.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;">No Bambu printer models connected. Check that Bambuddy drivers are running.</p>`
      section.classList.remove('hidden')
      return 0
    }

    const coverageParams =
      opts.entityType === 'spool'
        ? { spool_id: opts.entityId }
        : { filament_id: opts.entityId }

    let profilesByModel: Record<string, { base_name?: string; source?: string }> = {}
    let coverage: Record<string, ProfileCoverage> = {}
    let defaultBaseName = ''
    try {
      const cov = await fetchProfileCoverage(rep, coverageParams, opts)
      profilesByModel = cov?.profiles_by_model || {}
      coverage = cov?.coverage || {}
      defaultBaseName = cov?.default_base_name || ''
    } catch (e) {
      if (!opts.isAbortError(e)) {
        console.warn('Profile coverage load failed:', e)
      }
    }

    const presetsCache: Record<string, any[]> = {}
    const rowMounts: Record<string, HTMLElement> = {}
    const rowHeaders: Record<string, HTMLElement> = {}
    let defaultMount: HTMLElement | null = null
    let defaultPresets: any[] = []
    let modelOverrideMode: Record<string, boolean> = {}

    const loadPresets = async (model: string) => {
      if (!presetsCache[model]) {
        presetsCache[model] = await loadCloudPresetsForModel(rep, model, opts)
      }
      return presetsCache[model]
    }

    const loadAllDefaultPresets = async () => {
      const lists = await Promise.all(models.map((m) => loadPresets(m.model)))
      defaultPresets = mergeDefaultPresets(lists)
      return defaultPresets
    }

    const refreshDefaultVisual = () => {
      if (!defaultMount) return
      const hidden = defaultMount.querySelector(
        '.slicer-profile-base'
      ) as HTMLInputElement | null
      const search = defaultMount.querySelector(
        '.cloud-combo-search'
      ) as HTMLInputElement | null
      const base = defaultBaseName || hidden?.value || ''
      if (hidden && hidden.value !== base) hidden.value = base
      if (search && search.value !== base) search.value = base
      if (defaultMount.querySelector('.default-profile-combo')) {
        updateDefaultComboVisual(
          defaultMount,
          defaultPresets,
          base,
          models,
          coverage,
          'committed'
        )
      }
    }

    const refreshRowVisual = (model: string) => {
      const mount = rowMounts[model]
      if (!mount) return
      const presets = presetsCache[model] || []
      const cov = coverage[model]
      const entry = profilesByModel[model] || {}
      const isOverride =
        modelOverrideMode[model] || isOverrideSource(entry.source)
      const effectiveBase = isOverride
        ? entry.base_name || ''
        : defaultBaseName || entry.base_name || ''

      if (!isOverride && !mount.querySelector('.cloud-combo')) {
        mount.innerHTML = renderLinkedToDefault(effectiveBase, model, cov)
      }

      const base = isOverride
        ? displayBaseForPicker(effectiveBase, cov, presets)
        : effectiveBase
      const hidden = mount.querySelector('.slicer-profile-base') as HTMLInputElement | null
      const search = mount.querySelector('.cloud-combo-search') as HTMLInputElement | null
      if (hidden && hidden.value !== base) hidden.value = base
      if (search && search.value !== base) search.value = base
      if (mount.querySelector('.cloud-combo')) {
        updateComboVisual(mount, presets, cov, 'committed', model)
      } else if (mount.querySelector('.profile-picker-shell')) {
        const shell = mount.querySelector('.profile-picker-shell') as HTMLElement
        const visual = isOverride
          ? committedVisual(base, presets, cov)
          : committedVisual(effectiveBase, [], cov)
        applyShellState(
          shell,
          isOverride && visual === 'empty' ? 'linked' : visual,
          visualMeta(
            isOverride && visual === 'empty' ? 'linked' : visual,
            cov,
            !isOverride
          ),
          cov,
          base || effectiveBase,
          model
        )
      }
      const header = rowHeaders[model]
      if (header) {
        const badgeBase = isOverride ? base : effectiveBase
        header.innerHTML = `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
          <span style="font-weight:600; font-size:0.9rem;">${escapeHtml(model)}</span>
          ${isOverride ? '<span style="font-size:0.68rem;padding:1px 6px;border-radius:999px;border:1px solid var(--border,#444);color:var(--text-muted);">override</span>' : ''}
          ${rowHeaderBadge(model, cov, badgeBase)}
        </div>`
      }
      const row = mount.closest('.per-model-profile-row')
      const overrideBtn = row?.querySelector('button.fm-btn-outline') as HTMLButtonElement | null
      if (overrideBtn) {
        overrideBtn.textContent = isOverride ? 'Use default' : 'Override'
      }
    }

    const refreshAll = () => {
      refreshDefaultVisual()
      for (const m of Object.keys(rowMounts)) refreshRowVisual(m)
    }

    const reloadCoverage = async () => {
      try {
        const cov = await fetchProfileCoverage(rep, coverageParams, opts)
        profilesByModel = cov?.profiles_by_model || profilesByModel
        coverage = cov?.coverage || coverage
        defaultBaseName = cov?.default_base_name || defaultBaseName
      } catch (e) {
        if (!opts.isAbortError(e)) console.warn('Coverage reload failed:', e)
      }
    }

    const refreshModelRowsFromDefault = () => {
      for (const m of models) {
        const entry = profilesByModel[m.model] || {}
        if (isOverrideSource(entry.source)) continue
        const mount = rowMounts[m.model]
        if (!mount) continue
        mount.innerHTML = renderLinkedToDefault(
          defaultBaseName,
          m.model,
          coverage[m.model]
        )
      }
    }

    const saveDefault = async (baseName: string) => {
      let applyToExisting = false
      if (opts.entityType === 'filament') {
        applyToExisting = window.confirm(
          opts.t('printers.applyProfileToExisting') ||
            'Apply this default profile to existing spools of this filament?\n\nOK = update all existing spools\nCancel = only new spools'
        )
      }
      const result = await saveDefaultProfile(opts, baseName, applyToExisting)
      profilesByModel = result?.profiles_by_model || profilesByModel
      coverage = result?.coverage || coverage
      defaultBaseName = result?.default_base_name || result?.base_name || baseName
      await reloadCoverage()
      refreshModelRowsFromDefault()
      refreshAll()
      showMsg((opts.t('common.saved') || 'Saved') + ` — ${baseName}`, false)
      opts.onSaved?.()
      return result
    }

    const saveForModel = async (model: string, baseName: string) => {
      const result = await saveModelProfile(opts, model, baseName)
      profilesByModel = result?.profiles_by_model || profilesByModel
      coverage = result?.coverage || coverage
      modelOverrideMode[model] = true
      refreshAll()
      showMsg(
        (opts.t('common.saved') || 'Saved') +
          ` — ${model}: ${result?.base_name || baseName}`,
        false
      )
      opts.onSaved?.()
      return result
    }

    const clearModelOverride = async (model: string) => {
      const result = await clearModelProfileOverride(opts, model)
      profilesByModel = result?.profiles_by_model || profilesByModel
      coverage = result?.coverage || coverage
      modelOverrideMode[model] = false
      const mount = rowMounts[model]
      if (mount) {
        const entry = profilesByModel[model] || {}
        const cov = coverage[model]
        const effective = defaultBaseName || entry.base_name || ''
        mount.innerHTML = renderLinkedToDefault(effective, model, cov)
      }
      refreshAll()
      showMsg((opts.t('common.saved') || 'Saved') + ` — ${model} uses default`, false)
      opts.onSaved?.()
    }

    if (!defaultBaseName) {
      defaultBaseName = Object.values(profilesByModel).find((e) =>
        !isOverrideSource(e?.source) && e?.base_name
      )?.base_name || Object.values(profilesByModel).find((e) => e?.base_name)?.base_name || ''
    }

    picker.innerHTML = renderPickerHelp(models)
    picker.style.maxWidth = '100%'

    const defaultSection = document.createElement('div')
    defaultSection.className = 'default-profile-section'
    defaultSection.style.cssText =
      'margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border, #333);'
    defaultSection.innerHTML = `<div style="font-weight:600; font-size:0.95rem; margin-bottom: 8px;">Default profile</div>`
    defaultMount = document.createElement('div')
    defaultMount.className = 'default-profile-mount'
    defaultSection.appendChild(defaultMount)
    picker.appendChild(defaultSection)

    await loadAllDefaultPresets()
    if (defaultPresets.length === 0) {
      defaultMount.innerHTML = `<p style="margin:0;font-size:0.85rem;color:var(--text-muted);line-height:1.45;">No Bambu cloud presets found for your connected models. Sync presets in Bambu Studio and click Refresh below.</p>`
    } else {
      defaultMount.innerHTML = renderDefaultCombo(
        defaultPresets,
        defaultBaseName,
        models,
        coverage,
        opts.t('printers.searchProfile') || 'Search profile…'
      )
      wireDefaultCombo(
        defaultMount,
        defaultPresets,
        models,
        coverage,
        saveDefault,
        (msg) => showMsg(msg, true)
      )
    }

    const modelsHeader = document.createElement('div')
    modelsHeader.style.cssText =
      'font-weight:600; font-size:0.9rem; margin: 4px 0 12px; color:var(--text-muted);'
    modelsHeader.textContent = 'Per-model overrides (optional)'
    picker.appendChild(modelsHeader)

    const modelsGrid = document.createElement('div')
    modelsGrid.className = 'per-model-profile-grid'
    modelsGrid.dataset.modelCount = String(models.length)
    modelsGrid.style.cssText = `display: grid; grid-template-columns: ${modelGridTemplateColumns(models.length)}; gap: 16px; align-items: stretch; width: 100%;`
    picker.appendChild(modelsGrid)

    for (const m of models) {
      const entry = profilesByModel[m.model] || {}
      const cov = coverage[m.model]
      const isOverride = isOverrideSource(entry.source)
      modelOverrideMode[m.model] = isOverride
      const effectiveBase = isOverride
        ? entry.base_name || ''
        : defaultBaseName || entry.base_name || ''

      const row = document.createElement('div')
      row.className = 'per-model-profile-row'
      row.dataset.model = m.model
      row.style.cssText =
        'display: flex; flex-direction: column; min-height: 100%; padding: 12px 14px; border: 1px solid var(--border, #333); border-radius: 8px; background: rgba(255,255,255,0.02);'

      const header = document.createElement('div')
      header.style.cssText =
        'display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px;'
      const headerTitle = document.createElement('div')
      headerTitle.innerHTML = `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
        <span style="font-weight:600; font-size:0.9rem;">${escapeHtml(m.model)}</span>
        ${isOverride ? '<span style="font-size:0.68rem;padding:1px 6px;border-radius:999px;border:1px solid var(--border,#444);color:var(--text-muted);">override</span>' : ''}
        ${rowHeaderBadge(m.model, cov, effectiveBase)}
      </div>`
      rowHeaders[m.model] = headerTitle
      header.appendChild(headerTitle)

      const overrideBtn = document.createElement('button')
      overrideBtn.type = 'button'
      overrideBtn.className = 'fm-btn fm-btn-outline'
      overrideBtn.style.cssText =
        'font-size: 0.75rem; padding: 2px 8px; align-self: flex-start;'
      overrideBtn.textContent = isOverride ? 'Use default' : 'Override'
      overrideBtn.addEventListener('click', async () => {
        const rowIsOverride =
          modelOverrideMode[m.model] ||
          isOverrideSource(profilesByModel[m.model]?.source)
        if (rowIsOverride) {
          await clearModelOverride(m.model)
        } else {
          modelOverrideMode[m.model] = true
          const presets = await loadPresets(m.model)
          const displayBase = displayBaseForPicker(effectiveBase, cov, presets)
          mount.innerHTML = renderCombo(
            presets,
            displayBase,
            opts.t('printers.searchProfile') || `Search ${m.model} profile…`,
            m.model,
            cov
          )
          wireCombo(mount, presets, cov, m.model, (baseName) =>
            saveForModel(m.model, baseName),
            (msg) => showMsg(msg, true)
          )
          overrideBtn.textContent = 'Use default'
          headerTitle.innerHTML = `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
            <span style="font-weight:600; font-size:0.9rem;">${escapeHtml(m.model)}</span>
            <span style="font-size:0.68rem;padding:1px 6px;border-radius:999px;border:1px solid var(--border,#444);color:var(--text-muted);">override</span>
            ${rowHeaderBadge(m.model, cov, displayBase)}
          </div>`
        }
      })
      header.appendChild(overrideBtn)
      row.appendChild(header)

      const mount = document.createElement('div')
      mount.className = 'per-model-picker-mount'
      mount.style.flex = '1'
      rowMounts[m.model] = mount

      if (isOverride) {
        const presets = await loadPresets(m.model)
        const displayBase = displayBaseForPicker(effectiveBase, cov, presets)
        mount.innerHTML = renderCombo(
          presets,
          displayBase,
          opts.t('printers.searchProfile') || `Search ${m.model} profile…`,
          m.model,
          cov
        )
        wireCombo(mount, presets, cov, m.model, (baseName) =>
          saveForModel(m.model, baseName),
          (msg) => showMsg(msg, true)
        )
      } else {
        mount.innerHTML = renderLinkedToDefault(effectiveBase, m.model, cov)
      }
      row.appendChild(mount)
      modelsGrid.appendChild(row)
    }

    const refreshRow = document.createElement('div')
    refreshRow.style.marginTop = '8px'
    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'fm-btn fm-btn-outline'
    refreshBtn.style.fontSize = '0.8rem'
    refreshBtn.textContent = 'Refresh cloud presets'
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true
      refreshBtn.textContent = 'Refreshing…'
      try {
        await fetch(
          `/api/v1/printers/${rep}/driver/cloud-presets?refresh=1`,
          { credentials: 'include', signal: opts.getAbortSignal() }
        )
        const cov = await fetchProfileCoverage(rep, coverageParams, opts)
        coverage = cov?.coverage || coverage
        profilesByModel = cov?.profiles_by_model || profilesByModel
        defaultBaseName = cov?.default_base_name || defaultBaseName
        for (const m of models) {
          delete presetsCache[m.model]
        }
        defaultPresets = await loadAllDefaultPresets()
        // Re-render any override rows whose combo is already open so they pick up
        // the refreshed preset list.
        for (const m of models) {
          const mount = rowMounts[m.model]
          if (!mount) continue
          if (!modelOverrideMode[m.model]) continue
          if (!mount.querySelector('.cloud-combo')) continue
          const presets = await loadPresets(m.model)
          const entry = profilesByModel[m.model] || {}
          const cov2 = coverage[m.model]
          const effectiveBase = entry.base_name || defaultBaseName || ''
          const displayBase = displayBaseForPicker(effectiveBase, cov2, presets)
          mount.innerHTML = renderCombo(
            presets,
            displayBase,
            opts.t('printers.searchProfile') || `Search ${m.model} profile…`,
            m.model,
            cov2
          )
          wireCombo(mount, presets, cov2, m.model,
            (baseName) => saveForModel(m.model, baseName),
            (msg) => showMsg(msg, true)
          )
        }
        refreshAll()
      } finally {
        refreshBtn.disabled = false
        refreshBtn.textContent = 'Refresh cloud presets'
      }
    })
    refreshRow.appendChild(refreshBtn)
    picker.appendChild(refreshRow)

    if (coverageEl) {
      coverageEl.classList.add('hidden')
      coverageEl.innerHTML = ''
    }

    section.classList.remove('hidden')
    return rep
  } catch (e) {
    if (!opts.isAbortError(e)) {
      console.error('Per-model profile picker init failed:', e)
      if (section && picker) {
        picker.innerHTML = `<p style="color:var(--error-text);font-size:0.85rem;">Could not load slicer profile picker. Try refreshing the page.</p>`
        section.classList.remove('hidden')
      }
    }
    return 0
  }
}
