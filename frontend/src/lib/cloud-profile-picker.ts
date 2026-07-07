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
  filamentId?: number
  filamentLabel?: string
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

type TranslateFn = (key: string) => string

function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  )
}

function trFmt(t: TranslateFn, key: string, vars: Record<string, string>): string {
  let text = t(key) || key
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
  }
  return text
}

function ptr(t: TranslateFn, key: string, vars: Record<string, string> = {}): string {
  return trFmt(t, `printers.${key}`, vars)
}

function presetBases(presets: any[]): Set<string> {
  const bases = new Set<string>()
  for (const p of presets) {
    const b = p.baseName || p.displayName || ''
    if (b) bases.add(b)
  }
  return bases
}

function formatNozzleLine(
  cov: ProfileCoverage | undefined,
  model: string,
  t: TranslateFn
): string {
  const st = coverageStatus(cov)
  const req = cov?.nozzle_requested
  const res = cov?.nozzle_resolved
  const reqLabel =
    req != null
      ? ptr(t, 'profilePickerNozzleMm', { size: String(req) })
      : ptr(t, 'profilePickerNozzleDefaultOffline')

  if (st === 'ok' && res != null) {
    return ptr(t, 'profilePickerNozzleLineExact', {
      model,
      requested: reqLabel,
      resolved: String(res),
    })
  }
  if (st === 'fallback' && res != null) {
    return ptr(t, 'profilePickerNozzleLineFallback', {
      model,
      requested: reqLabel,
      resolved: String(res),
    })
  }
  if (st === 'missing') {
    return ptr(t, 'profilePickerNozzleLineMissing', { model, requested: reqLabel })
  }
  return ptr(t, 'profilePickerNozzleLineDefault', { model, requested: reqLabel })
}

function formatCloudNameLine(
  cov: ProfileCoverage | undefined,
  baseName: string,
  model: string,
  t: TranslateFn
): string {
  const st = coverageStatus(cov)
  const nozzle = cov?.nozzle_requested ?? 0.4
  const expected =
    cov?.expected_name ||
    (baseName ? `${baseName} @BBL ${model} ${nozzle}g nozzle` : '')

  if (!baseName) {
    return ptr(t, 'profilePickerCloudNameRequirement', { model })
  }
  if (st === 'ok' || st === 'fallback') {
    const code = cov?.code ? ` (${cov.code})` : ''
    const resolved = cov?.nozzle_resolved ?? nozzle
    const suffix =
      resolved === 0.4
        ? ptr(t, 'profilePickerCloudSuffix040', { model })
        : ptr(t, 'profilePickerCloudSuffixNozzle', {
            model,
            nozzle: String(resolved),
          })
    return ptr(t, 'profilePickerCloudMatched', { code, suffix })
  }
  if (st === 'missing') {
    if (nozzle === 0.4) {
      return ptr(t, 'profilePickerCloudCreate040', { name: baseName, model, expected })
    }
    return ptr(t, 'profilePickerCloudCreate', { name: baseName, model, expected })
  }
  if (nozzle === 0.4) {
    return ptr(t, 'profilePickerCloudStock040', { model })
  }
  return ptr(t, 'profilePickerCloudNaming', { model, nozzle: String(nozzle) })
}

function renderPickerMeta(
  cov: ProfileCoverage | undefined,
  baseName: string,
  model: string,
  t: TranslateFn
): string {
  const cloudLine = formatCloudNameLine(cov, baseName, model, t)
  const st = coverageStatus(cov)
  const cloudStyle =
    st === 'missing'
      ? 'color:var(--warning-text, #b8860b); font-weight:500;'
      : ''
  return `<div class="profile-picker-meta" style="margin-top:8px; padding-top:8px; border-top:1px solid var(--border,#333); font-size:0.72rem; color:var(--text-muted); line-height:1.45;">
    ${baseName ? `<div style="margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;gap:4px;"><span style="font-size:0.7rem;">${escapeHtml(ptr(t, 'profilePickerCloudVariants'))}</span>${renderStandardNozzleBadges(cov, baseName, t)}</div>` : ''}
    <div class="profile-picker-nozzle-line">${escapeHtml(formatNozzleLine(cov, model, t))}</div>
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
  baseName: string,
  t: TranslateFn
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
      ? ptr(t, 'profilePickerStdNozzleExists', { size: String(n) })
      : ptr(t, 'profilePickerStdNozzleMissing', { size: String(n) })
    return `<span title="${escapeHtml(title)}" style="font-size:0.65rem;padding:1px 7px;border-radius:999px;border:1px solid ${border};color:${color};background:${bg};${ring}">${n}</span>`
  })
  return `<span class="profile-std-nozzles" style="display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;margin-left:4px;" title="${escapeHtml(ptr(t, 'profilePickerStdNozzleLegend'))}">${parts.join('')}</span>`
}

function rowNozzleBadge(cov: ProfileCoverage | undefined, baseName: string, t: TranslateFn): string {
  return renderStandardNozzleBadges(cov, baseName, t)
}

function coverageStatus(c?: ProfileCoverage): ProfileCoverage['status'] {
  if (!c) return 'not_set'
  if (c.status) return c.status
  if (c.mapped) return c.fallback_nozzle ? 'fallback' : 'ok'
  return c.base_name ? 'missing' : 'not_set'
}

function visualMeta(
  visual: SelectionVisual,
  cov: ProfileCoverage | undefined,
  linked: boolean,
  t: TranslateFn
): VisualMeta {
  const nozzle =
    cov?.nozzle_resolved != null
      ? ptr(t, 'profilePickerNozzleMmNozzle', { size: String(cov.nozzle_resolved) })
      : ''
  const code = cov?.code ? ` · ${cov.code}` : ''

  switch (visual) {
    case 'saving':
      return {
        border: 'var(--accent, #3b82f6)',
        bg: 'rgba(59, 130, 246, 0.08)',
        icon: '…',
        iconColor: 'var(--accent, #3b82f6)',
        label: ptr(t, 'profilePickerStatusSaving'),
        hint: '',
      }
    case 'draft':
      return {
        border: 'var(--warning-text, #b8860b)',
        bg: 'rgba(247, 200, 106, 0.1)',
        icon: '!',
        iconColor: 'var(--warning-text, #b8860b)',
        label: ptr(t, 'profilePickerStatusNotSaved'),
        hint: ptr(t, 'profilePickerStatusNotSavedHint'),
      }
    case 'valid':
      return {
        border: 'var(--success-border)',
        bg: 'var(--success-bg)',
        icon: '✓',
        iconColor: 'var(--success-text)',
        label: linked
          ? ptr(t, 'profilePickerStatusLinkedProfile')
          : ptr(t, 'profilePickerStatusProfileSaved'),
        hint: nozzle
          ? ptr(t, 'profilePickerStatusResolvesPrinter', { code })
          : ptr(t, 'profilePickerStatusSavedInFilaman', { code }),
      }
    case 'fallback':
      return {
        border: 'var(--warning-text, #b8860b)',
        bg: 'rgba(247, 200, 106, 0.12)',
        icon: '≈',
        iconColor: 'var(--warning-text, #b8860b)',
        label: linked
          ? ptr(t, 'profilePickerStatusLinkedClosest')
          : ptr(t, 'profilePickerStatusClosestNozzle'),
        hint:
          (cov?.expected_name
            ? ptr(t, 'profilePickerStatusExpectedPrefix', { name: cov.expected_name })
            : '') +
          (nozzle
            ? ptr(t, 'profilePickerStatusUsingNozzle', { nozzle, code })
            : ptr(t, 'profilePickerStatusExactNozzleMissing')),
      }
    case 'invalid':
      return {
        border: 'var(--error-border)',
        bg: 'var(--error-bg)',
        icon: '✕',
        iconColor: 'var(--error-text)',
        label: ptr(t, 'profilePickerStatusNoCloudPreset'),
        hint:
          cov?.expected_name || ptr(t, 'profilePickerStatusNoCloudPresetHint'),
      }
    case 'linked':
      return {
        border: 'var(--border, #444)',
        bg: 'transparent',
        icon: '↪',
        iconColor: 'var(--text-muted)',
        label: ptr(t, 'profilePickerStatusUsingDefault'),
        hint: ptr(t, 'profilePickerStatusUsingDefaultHint'),
      }
    case 'empty':
    default:
      return {
        border: 'var(--border, #444)',
        bg: 'transparent',
        icon: '○',
        iconColor: 'var(--text-muted)',
        label: ptr(t, 'profilePickerStatusNoProfileSelected'),
        hint: ptr(t, 'profilePickerStatusNoProfileSelectedHint'),
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

function renderStaleNotice(staleBase: string, model: string, t: TranslateFn): string {
  if (!staleBase) return ''
  return `<p class="profile-stale-notice" style="margin:0 0 8px;font-size:0.8rem;color:var(--warning-text,#b8860b);">${escapeHtml(
    ptr(t, 'profilePickerStaleNotice', { name: staleBase, model })
  )}</p>`
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
  t: TranslateFn,
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
    metaEl.outerHTML = renderPickerMeta(cov, baseName, model, t)
  }
}

function renderPickerShell(
  innerHtml: string,
  visual: SelectionVisual,
  meta: VisualMeta,
  t: TranslateFn,
  cov?: ProfileCoverage,
  baseName = '',
  model = ''
): string {
  const metaBlock = model ? renderPickerMeta(cov, baseName, model, t) : ''
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
  cov: ProfileCoverage | undefined,
  t: TranslateFn
): string {
  const visual = committedVisual(selectedBase, presets, cov)
  const meta = visualMeta(visual, cov, false, t)
  const inner = `<div class="cloud-combo per-model-combo" data-model="${escapeHtml(dataModel)}" style="position:relative;">
    <input type="hidden" class="slicer-profile-base" value="${escapeHtml(selectedBase)}" />
    <input type="text" class="fm-input cloud-combo-search" autocomplete="off" spellcheck="false"
      placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(selectedBase)}" style="width:100%; margin:0;" />
    <div class="cloud-combo-list" style="display:none; position:absolute; z-index:50; left:0; right:0; max-height:260px; overflow-y:auto; background:var(--surface, #1e1e1e); border:1px solid var(--border, #444); border-radius:6px; margin-top:2px; box-shadow:0 4px 16px rgba(0,0,0,0.3);"></div>
  </div>`
  return renderPickerShell(inner, visual, meta, t, cov, selectedBase, dataModel)
}

function renderLinkedCard(
  baseName: string,
  model: string,
  cov: ProfileCoverage | undefined,
  t: TranslateFn,
  missing = false
): string {
  if (missing) {
    const meta = visualMeta('invalid', cov, false, t)
    const inner = `<p style="margin:0; font-size:0.9rem; color:var(--text);">${escapeHtml(baseName)}</p>`
    return renderPickerShell(inner, 'invalid', meta, t, cov, baseName, model)
  }
  const visual = committedVisual(baseName, [], cov)
  const meta = visualMeta(visual, cov, true, t)
  const inner = `<p style="margin:0; font-size:0.9rem; font-weight:500; color:var(--text);">${escapeHtml(baseName)}</p>`
  return renderPickerShell(inner, visual, meta, t, cov, baseName, model)
}

function updateComboVisual(
  mount: HTMLElement,
  presets: any[],
  cov: ProfileCoverage | undefined,
  t: TranslateFn,
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
  applyShellState(shell, visual, visualMeta(visual, cov, false, t), t, cov, hidden.value, model)
}

function wireCombo(
  mount: HTMLElement,
  presets: any[],
  cov: ProfileCoverage | undefined,
  model: string,
  t: TranslateFn,
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
      list.innerHTML = `<div style="padding:8px 10px; color:var(--text-muted); font-size:0.85rem;">${escapeHtml(t('printers.noProfileMatches'))}</div>`
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
        updateComboVisual(mount, presets, cov, t, 'saving', model)
        void Promise.resolve(onSelect(base)).catch((e: unknown) => {
          onError(formatApiError(e, t))
          updateComboVisual(mount, presets, cov, t, 'committed', model)
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
      t,
      search.value.trim() === hidden.value ? 'committed' : 'draft',
      model
    )
  })
  search.addEventListener('blur', () => {
    setTimeout(() => {
      list.style.display = 'none'
      search.value = hidden.value
      updateComboVisual(mount, presets, cov, t, 'committed', model)
    }, 150)
  })

  updateComboVisual(mount, presets, cov, t, 'committed', model)
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

function formatApiError(e: unknown, t: TranslateFn): string {
  if (e instanceof ApiError) {
    if (e.code === 'csrf_failed') {
      return ptr(t, 'profilePickerCsrfError')
    }
    return e.message
  }
  if (e instanceof Error) return e.message
  return ptr(t, 'profilePickerSaveFailed')
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

function rowHeaderBadge(
  model: string,
  c: ProfileCoverage | undefined,
  baseName: string,
  t: TranslateFn
): string {
  const raw = baseName || c?.base_name || ''
  const badges = rowNozzleBadge(c, raw, t)
  if (!c) return badges
  const visual = committedVisual(raw, [], c)
  if (visual === 'empty' || visual === 'invalid') return badges
  const meta = visualMeta(visual, c, false, t)
  return `${badges}<span class="profile-row-badge" title="${escapeHtml(meta.hint || meta.label)}" style="font-size:0.7rem;padding:1px 7px;border-radius:999px;border:1px solid ${meta.border};color:${meta.iconColor};">${escapeHtml(meta.label)}</span>`
}

function renderPickerHelp(connectedModels: ConnectedModel[], t: TranslateFn): string {
  const modelList =
    connectedModels.map((m) => m.model).join(', ') ||
    ptr(t, 'profilePickerConnectedModelsFallback')
  return `<div class="profile-picker-help" style="margin-bottom:16px; padding:12px 14px; border-radius:8px; border:1px solid var(--border,#333); background:rgba(255,255,255,0.03); font-size:0.78rem; color:var(--text-muted); line-height:1.5;">
    <strong style="color:var(--text);">${escapeHtml(ptr(t, 'profilePickerHelpTitle'))}</strong> — ${escapeHtml(ptr(t, 'profilePickerHelpIntro', { models: modelList }))}
    ${escapeHtml(ptr(t, 'profilePickerHelpResolve'))}
    ${escapeHtml(ptr(t, 'profilePickerHelpOverride'))}
    ${escapeHtml(ptr(t, 'profilePickerHelpStock040'))}
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
  coverage: Record<string, ProfileCoverage>,
  t: TranslateFn
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
      label: ptr(t, 'profilePickerPartialCoverage'),
      hint:
        missing.length > 0
          ? ptr(t, 'profilePickerPartialCoverageMissing', {
              models: missing.join(', '),
            })
          : ptr(t, 'profilePickerPartialCoverageGeneric'),
    }
  }
  if (visual === 'valid' || visual === 'fallback' || visual === 'invalid') {
    return visualMeta(visual, undefined, false, t)
  }
  return visualMeta('empty', undefined, false, t)
}

function renderDefaultCoverageStrip(
  models: ConnectedModel[],
  defaultBase: string,
  coverage: Record<string, ProfileCoverage>,
  t: TranslateFn
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
        ? c?.expected_name ||
          ptr(t, 'profilePickerNoVariantInCloud', { model: m.model })
        : ptr(t, 'profilePickerModelResolved', {
            model: m.model,
            code: c?.code || 'resolved',
          })
    return `<span title="${escapeHtml(title)}" style="font-size:0.72rem;padding:2px 8px;border-radius:999px;border:1px solid var(--border,#444);color:${color};">${escapeHtml(m.model)} ${icon}</span>`
  })
  return `<div class="default-coverage-strip" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center;"><span style="font-size:0.7rem;color:var(--text-muted);">${escapeHtml(ptr(t, 'profilePickerVariantsLabel'))}</span>${parts.join('')}</div>`
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

type BackfillPreview = {
  can_backfill?: boolean
  reason?: string
  filament_id?: number
  filament_designation?: string
  filament_manufacturer?: string
  connected_models?: string[]
  source?: {
    default_base_name?: string
    overrides?: Record<string, string>
  }
  current_filament?: {
    default_base_name?: string
    overrides?: Record<string, string>
  }
  changes?: {
    default_changes?: boolean
    model_changes?: Array<{
      model: string
      from_base?: string
      to_base?: string
      to_kind?: string
    }>
    filament_already_matches?: boolean
  }
  sibling_spools?: { total_count?: number; other_count?: number }
  filament_already_matches?: boolean
}

async function fetchBackfillPreview(
  spoolId: number,
  opts: InitPerModelPickerOptions
): Promise<BackfillPreview> {
  const res = await fetch(
    `/api/v1/spools/${spoolId}/slicer-profile/backfill-preview`,
    { credentials: 'include', signal: opts.getAbortSignal() }
  )
  if (!res.ok) {
    throw new Error('backfill-preview failed')
  }
  return res.json().catch(() => ({}))
}

function buildBackfillModalBody(preview: BackfillPreview, opts: InitPerModelPickerOptions): string {
  const t = opts.t
  const filamentId = preview.filament_id || opts.filamentId
  const label =
    preview.filament_designation ||
    opts.filamentLabel ||
    (filamentId ? `#${filamentId}` : '')
  const mfr = preview.filament_manufacturer
    ? ` <span style="color:var(--text-muted);font-size:0.85rem;">(${escapeHtml(preview.filament_manufacturer)})</span>`
    : ''
  const defaultName = preview.source?.default_base_name || '—'
  const overrides = preview.source?.overrides || {}
  const overrideKeys = Object.keys(overrides).sort()
  const connected = (preview.connected_models || []).sort()
  const overrideLines =
    overrideKeys.length > 0
      ? overrideKeys
          .map(
            (model) =>
              `<li><strong>${escapeHtml(model)}</strong>: ${escapeHtml(overrides[model])}</li>`
          )
          .join('')
      : `<li style="color:var(--text-muted);">${escapeHtml(t('printers.backfillNoOverrides') || 'None')}</li>`

  const changeLines: string[] = []
  if (preview.changes?.default_changes && preview.source?.default_base_name) {
    changeLines.push(
      `<li>${escapeHtml(
        trFmt(t, 'printers.backfillWillChangeDefault', {
          name: preview.source.default_base_name,
        })
      )}</li>`
    )
  }
  for (const mc of preview.changes?.model_changes || []) {
    changeLines.push(
      `<li>${escapeHtml(
        trFmt(t, 'printers.backfillWillChangeModel', {
          model: mc.model,
          name: mc.to_base || '',
          kind: mc.to_kind || 'linked',
        })
      )}</li>`
    )
  }
  if (
    preview.filament_already_matches ||
    preview.changes?.filament_already_matches
  ) {
    changeLines.push(
      `<li style="color:var(--text-muted);">${escapeHtml(
        t('printers.backfillFilamentMatches') || 'Filament already matches.'
      )}</li>`
    )
  }

  const connectedLine =
    connected.length > 0
      ? connected.map((m) => escapeHtml(m)).join(', ')
      : '—'

  const otherCount = preview.sibling_spools?.other_count || 0
  const siblingBlock =
    otherCount > 0
      ? `<label style="display:flex;align-items:flex-start;gap:10px;margin-top:16px;cursor:pointer;">
          <input type="checkbox" id="backfill-sibling-checkbox" style="margin-top:3px;width:16px;height:16px;" />
          <span style="font-size:0.85rem;line-height:1.4;">${escapeHtml(
            trFmt(t, 'printers.backfillApplyToSiblingSpools', {
              count: String(otherCount),
            })
          )}<br><span style="color:var(--text-muted);font-size:0.78rem;">${escapeHtml(
            t('printers.backfillSiblingWarning') || ''
          )}</span></span>
        </label>`
      : ''

  return `
    <p style="margin:0 0 12px;font-size:0.9rem;">
      <strong>${escapeHtml(t('printers.backfillToFilamentTarget') || 'Target filament')}:</strong>
      ${
        filamentId
          ? `<a href="/filaments/${filamentId}" style="color:var(--accent);text-decoration:none;">${escapeHtml(label)}</a>${mfr}`
          : escapeHtml(label)
      }
    </p>
    <p style="margin:0 0 4px;font-size:0.85rem;font-weight:600;">${escapeHtml(
      t('printers.backfillDefaultProfile') || 'Default profile'
    )}</p>
    <p style="margin:0 0 12px;font-size:0.9rem;">${escapeHtml(defaultName)}</p>
    <p style="margin:0 0 4px;font-size:0.85rem;font-weight:600;">${escapeHtml(
      t('printers.backfillPerModelOverrides') || 'Per-model overrides'
    )}</p>
    <ul style="margin:0 0 12px;padding-left:18px;font-size:0.85rem;">${overrideLines}</ul>
    <p style="margin:0 0 4px;font-size:0.85rem;font-weight:600;">${escapeHtml(
      t('printers.backfillConnectedModels') || 'Connected printer models'
    )}</p>
    <p style="margin:0 0 12px;font-size:0.85rem;color:var(--text-muted);">${connectedLine}</p>
    ${
      changeLines.length
        ? `<p style="margin:0 0 4px;font-size:0.85rem;font-weight:600;">${escapeHtml(
            t('printers.backfillChanges') || 'Changes'
          )}</p><ul style="margin:0 0 8px;padding-left:18px;font-size:0.85rem;">${changeLines.join('')}</ul>`
        : ''
    }
    ${siblingBlock}
  `
}

function showBackfillConfirmModal(
  preview: BackfillPreview,
  opts: InitPerModelPickerOptions
): Promise<{ confirmed: boolean; applyToSiblingSpools: boolean } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'fm-modal-overlay'
    const modal = document.createElement('div')
    modal.className = 'fm-modal'
    modal.style.maxWidth = '520px'
    modal.innerHTML = `
      <h3 class="fm-modal-title" style="margin:0 0 12px;">${escapeHtml(
        opts.t('printers.backfillToFilamentTitle') || 'Backfill to filament'
      )}</h3>
      <div class="backfill-modal-body">${buildBackfillModalBody(preview, opts)}</div>
      <div class="fm-modal-actions" style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
        <button type="button" class="fm-btn fm-btn-outline" data-action="cancel">${escapeHtml(
          opts.t('printers.backfillCancel') || opts.t('common.cancel') || 'Cancel'
        )}</button>
        <button type="button" class="fm-btn fm-btn-primary" data-action="confirm">${escapeHtml(
          opts.t('printers.backfillToFilamentConfirm') || 'Apply'
        )}</button>
      </div>
    `
    overlay.appendChild(modal)
    const close = (value: { confirmed: boolean; applyToSiblingSpools: boolean } | null) => {
      overlay.remove()
      resolve(value)
    }
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close(null)
    })
    modal.querySelector('[data-action="cancel"]')?.addEventListener('click', () => close(null))
    modal.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
      const siblingCheckbox = modal.querySelector(
        '#backfill-sibling-checkbox'
      ) as HTMLInputElement | null
      close({
        confirmed: true,
        applyToSiblingSpools: siblingCheckbox?.checked ?? false,
      })
    })
    document.body.appendChild(overlay)
    requestAnimationFrame(() => overlay.classList.add('open'))
  })
}

async function runBackfillToFilament(
  opts: InitPerModelPickerOptions,
  applyToSiblingSpools: boolean
): Promise<any> {
  return apiPostWithCsrf(
    opts,
    `/spools/${opts.entityId}/slicer-profile/backfill-to-filament`,
    { apply_to_sibling_spools: applyToSiblingSpools }
  )
}

function renderDefaultCombo(
  presets: any[],
  defaultBase: string,
  models: ConnectedModel[],
  coverage: Record<string, ProfileCoverage>,
  placeholder: string,
  t: TranslateFn
): string {
  const visual = defaultProfileVisual(defaultBase, models, coverage)
  const meta = defaultVisualMeta(visual, models, coverage, t)
  const inner = `<div class="cloud-combo default-profile-combo" data-model="default" style="position:relative;">
    <input type="hidden" class="slicer-profile-base" value="${escapeHtml(defaultBase)}" />
    <input type="text" class="fm-input cloud-combo-search" autocomplete="off" spellcheck="false"
      placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultBase)}" style="width:100%; margin:0;" />
    <div class="cloud-combo-list" style="display:none; position:absolute; z-index:50; left:0; right:0; max-height:260px; overflow-y:auto; background:var(--surface, #1e1e1e); border:1px solid var(--border, #444); border-radius:6px; margin-top:2px; box-shadow:0 4px 16px rgba(0,0,0,0.3);"></div>
  </div>${renderDefaultCoverageStrip(models, defaultBase, coverage, t)}`
  return renderPickerShell(inner, visual === 'partial' ? 'fallback' : visual, meta, t, undefined, defaultBase, '')
}

function updateDefaultComboVisual(
  mount: HTMLElement,
  presets: any[],
  defaultBase: string,
  models: ConnectedModel[],
  coverage: Record<string, ProfileCoverage>,
  t: TranslateFn,
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
  const meta = defaultVisualMeta(visual, models, coverage, t)
  applyShellState(
    shell,
    visual === 'partial' ? 'fallback' : visual,
    meta,
    t,
    undefined,
    hidden.value,
    ''
  )
  const strip = mount.querySelector('.default-coverage-strip')
  if (strip) {
    strip.outerHTML = renderDefaultCoverageStrip(models, hidden.value, coverage, t)
  }
}

function wireDefaultCombo(
  mount: HTMLElement,
  presets: any[],
  models: ConnectedModel[],
  coverage: Record<string, ProfileCoverage>,
  t: TranslateFn,
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
      list.innerHTML = `<div style="padding:8px 10px; color:var(--text-muted); font-size:0.85rem;">${escapeHtml(t('printers.noProfileMatches'))}</div>`
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
        updateDefaultComboVisual(mount, presets, base, models, coverage, t, 'saving')
        void Promise.resolve(onSelect(base)).catch((e: unknown) => {
          onError(formatApiError(e, t))
          updateDefaultComboVisual(
            mount,
            presets,
            hidden.value,
            models,
            coverage,
            t,
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
      t,
      search.value.trim() === hidden.value ? 'committed' : 'draft'
    )
  })
  search.addEventListener('blur', () => {
    setTimeout(() => {
      list.style.display = 'none'
      search.value = hidden.value
      updateDefaultComboVisual(mount, presets, hidden.value, models, coverage, t, 'committed')
    }, 150)
  })

  updateDefaultComboVisual(
    mount,
    presets,
    hidden.value,
    models,
    coverage,
    t,
    'committed'
  )
}

function renderLinkedToDefault(
  effectiveBase: string,
  model: string,
  cov: ProfileCoverage | undefined,
  t: TranslateFn
): string {
  const visual = committedVisual(effectiveBase, [], cov)
  const meta = visualMeta(visual === 'empty' ? 'linked' : visual, cov, true, t)
  const inner = `<p style="margin:0; font-size:0.9rem; color:var(--text);"><span style="color:var(--text-muted);">↪</span> ${escapeHtml(effectiveBase)}</p>`
  return renderPickerShell(
    inner,
    visual === 'empty' ? 'linked' : visual,
    meta,
    t,
    cov,
    effectiveBase,
    model
  )
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
    const t = opts.t
    const overrideBadgeHtml = () =>
      `<span style="font-size:0.68rem;padding:1px 6px;border-radius:999px;border:1px solid var(--border,#444);color:var(--text-muted);">${escapeHtml(ptr(t, 'profilePickerOverrideBadge'))}</span>`
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
      picker.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;">${escapeHtml(ptr(t, 'profilePickerNoPrinters'))}</p>`
      section.classList.remove('hidden')
      return 0
    }

    const coverageParams: Record<string, number> =
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
          t,
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
        mount.innerHTML = renderLinkedToDefault(effectiveBase, model, cov, t)
      }

      const base = isOverride
        ? displayBaseForPicker(effectiveBase, cov, presets)
        : effectiveBase
      const hidden = mount.querySelector('.slicer-profile-base') as HTMLInputElement | null
      const search = mount.querySelector('.cloud-combo-search') as HTMLInputElement | null
      if (hidden && hidden.value !== base) hidden.value = base
      if (search && search.value !== base) search.value = base
      if (mount.querySelector('.cloud-combo')) {
        updateComboVisual(mount, presets, cov, t, 'committed', model)
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
            !isOverride,
            t
          ),
          t,
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
          ${isOverride ? overrideBadgeHtml() : ''}
          ${rowHeaderBadge(model, cov, badgeBase, t)}
        </div>`
      }
      const row = mount.closest('.per-model-profile-row')
      const overrideBtn = row?.querySelector('button.fm-btn-outline') as HTMLButtonElement | null
      if (overrideBtn) {
        overrideBtn.textContent = isOverride
          ? ptr(t, 'profilePickerUseDefault')
          : ptr(t, 'profilePickerOverride')
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
          coverage[m.model],
          t
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
        mount.innerHTML = renderLinkedToDefault(effective, model, cov, t)
      }
      refreshAll()
      showMsg(
        (opts.t('common.saved') || 'Saved') +
          ` — ${ptr(t, 'profilePickerSavedUsesDefault', { model })}`,
        false
      )
      opts.onSaved?.()
    }

    if (!defaultBaseName) {
      defaultBaseName = Object.values(profilesByModel).find((e) =>
        !isOverrideSource(e?.source) && e?.base_name
      )?.base_name || Object.values(profilesByModel).find((e) => e?.base_name)?.base_name || ''
    }

    picker.innerHTML = renderPickerHelp(models, t)
    picker.style.maxWidth = '100%'

    const defaultSection = document.createElement('div')
    defaultSection.className = 'default-profile-section'
    defaultSection.style.cssText =
      'margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border, #333);'
    defaultSection.innerHTML = `<div style="font-weight:600; font-size:0.95rem; margin-bottom: 8px;">${escapeHtml(ptr(t, 'profilePickerDefaultProfile'))}</div>`
    defaultMount = document.createElement('div')
    defaultMount.className = 'default-profile-mount'
    defaultSection.appendChild(defaultMount)
    picker.appendChild(defaultSection)

    await loadAllDefaultPresets()
    if (defaultPresets.length === 0) {
      defaultMount.innerHTML = `<p style="margin:0;font-size:0.85rem;color:var(--text-muted);line-height:1.45;">${escapeHtml(ptr(t, 'profilePickerNoPresets'))}</p>`
    } else {
      defaultMount.innerHTML = renderDefaultCombo(
        defaultPresets,
        defaultBaseName,
        models,
        coverage,
        opts.t('printers.searchProfile') || 'Search profile…',
        t
      )
      wireDefaultCombo(
        defaultMount,
        defaultPresets,
        models,
        coverage,
        t,
        saveDefault,
        (msg) => showMsg(msg, true)
      )
    }

    if (opts.entityType === 'spool') {
      const backfillRow = document.createElement('div')
      backfillRow.style.cssText = 'margin-top: 14px;'
      const backfillBtn = document.createElement('button')
      backfillBtn.type = 'button'
      backfillBtn.className = 'fm-btn fm-btn-outline'
      backfillBtn.style.fontSize = '0.85rem'
      backfillBtn.textContent =
        opts.t('printers.backfillToFilament') || 'Backfill to Filament'
      backfillBtn.disabled = true
      backfillRow.appendChild(backfillBtn)
      defaultSection.appendChild(backfillRow)

      fetchBackfillPreview(opts.entityId, opts)
        .then((preview) => {
          backfillBtn.disabled = !preview.can_backfill
          if (!preview.can_backfill && preview.reason === 'no_spool_profiles') {
            backfillBtn.title =
              opts.t('printers.backfillNoSpoolProfiles') ||
              'Save profiles on this spool first'
          }
        })
        .catch(() => {
          backfillBtn.disabled = true
        })

      backfillBtn.addEventListener('click', async () => {
        backfillBtn.disabled = true
        try {
          const preview = await fetchBackfillPreview(opts.entityId, opts)
          if (!preview.can_backfill) {
            showMsg(
              opts.t('printers.backfillNoSpoolProfiles') ||
                'Save a profile on this spool first',
              true
            )
            return
          }
          const confirmed = await showBackfillConfirmModal(preview, opts)
          if (!confirmed?.confirmed) return
          const result = await runBackfillToFilament(
            opts,
            confirmed.applyToSiblingSpools
          )
          const applied = result?.applied_to_spools || 0
          if (confirmed.applyToSiblingSpools && applied > 0) {
            showMsg(
              trFmt(opts.t, 'printers.backfillSuccessWithSpools', {
                count: String(applied),
              }),
              false
            )
          } else {
            showMsg(opts.t('printers.backfillSuccess') || 'Saved', false)
          }
          opts.onSaved?.()
        } catch (e) {
          if (!opts.isAbortError(e)) {
            console.error('Backfill failed:', e)
            showMsg(opts.t('printers.backfillFailed') || 'Failed', true)
          }
        } finally {
          try {
            const preview = await fetchBackfillPreview(opts.entityId, opts)
            backfillBtn.disabled = !preview.can_backfill
          } catch {
            backfillBtn.disabled = false
          }
        }
      })
    }

    const modelsHeader = document.createElement('div')
    modelsHeader.style.cssText =
      'font-weight:600; font-size:0.9rem; margin: 4px 0 12px; color:var(--text-muted);'
    modelsHeader.textContent = ptr(t, 'profilePickerPerModelOverrides')
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
        ${isOverride ? overrideBadgeHtml() : ''}
        ${rowHeaderBadge(m.model, cov, effectiveBase, t)}
      </div>`
      rowHeaders[m.model] = headerTitle
      header.appendChild(headerTitle)

      const overrideBtn = document.createElement('button')
      overrideBtn.type = 'button'
      overrideBtn.className = 'fm-btn fm-btn-outline'
      overrideBtn.style.cssText =
        'font-size: 0.75rem; padding: 2px 8px; align-self: flex-start;'
      overrideBtn.textContent = isOverride
        ? ptr(t, 'profilePickerUseDefault')
        : ptr(t, 'profilePickerOverride')
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
            ptr(t, 'profilePickerSearchModel', { model: m.model }),
            m.model,
            cov,
            t
          )
          wireCombo(
            mount,
            presets,
            cov,
            m.model,
            t,
            (baseName) => saveForModel(m.model, baseName),
            (msg) => showMsg(msg, true)
          )
          overrideBtn.textContent = ptr(t, 'profilePickerUseDefault')
          headerTitle.innerHTML = `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
            <span style="font-weight:600; font-size:0.9rem;">${escapeHtml(m.model)}</span>
            ${overrideBadgeHtml()}
            ${rowHeaderBadge(m.model, cov, displayBase, t)}
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
          ptr(t, 'profilePickerSearchModel', { model: m.model }),
          m.model,
          cov,
          t
        )
        wireCombo(
          mount,
          presets,
          cov,
          m.model,
          t,
          (baseName) => saveForModel(m.model, baseName),
          (msg) => showMsg(msg, true)
        )
      } else {
        mount.innerHTML = renderLinkedToDefault(effectiveBase, m.model, cov, t)
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
    refreshBtn.textContent = ptr(t, 'profilePickerRefresh')
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true
      refreshBtn.textContent = ptr(t, 'profilePickerRefreshing')
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
            ptr(t, 'profilePickerSearchModel', { model: m.model }),
            m.model,
            cov2,
            t
          )
          wireCombo(
            mount,
            presets,
            cov2,
            m.model,
            t,
            (baseName) => saveForModel(m.model, baseName),
            (msg) => showMsg(msg, true)
          )
        }
        refreshAll()
      } finally {
        refreshBtn.disabled = false
        refreshBtn.textContent = ptr(t, 'profilePickerRefresh')
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
        picker.innerHTML = `<p style="color:var(--error-text);font-size:0.85rem;">${escapeHtml(ptr(opts.t, 'profilePickerLoadFailed'))}</p>`
        section.classList.remove('hidden')
      }
    }
    return 0
  }
}
