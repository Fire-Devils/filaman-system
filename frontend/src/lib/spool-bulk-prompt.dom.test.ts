// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createSourceFile, isExpressionStatement, ScriptTarget, transpileModule, type Node } from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { astroPageFunction } from '../../tests/helpers/astro-script'
import { assignableLocations } from './driver-managed-locations'
import { escapeHtml } from './extra-fields'
import { isAbortError } from './abort'

const script = readFileSync('src/pages/spools/index.astro', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
const parsed = createSourceFile('spools.ts', script, ScriptTarget.Latest, true)
const handlers: string[] = []
function visit(node: Node): void {
  if (isExpressionStatement(node) && ['location', 'status'].some(action => node.getText(parsed).startsWith(`document.getElementById('bulk-btn-${action}')?.addEventListener`))) handlers.push(node.getText(parsed))
  node.forEachChild(visit)
}
visit(parsed)
const production = `${astroPageFunction('spools/index', 'openBulkPrompt')}\n${astroPageFunction('spools/index', 'bulkPatch')}\n${transpileModule(handlers.join('\n'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}`

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

function setup(loadLocations: () => Promise<{ items: { id: number; name: string }[] }>) {
  document.body.innerHTML = '<div id="bulk-action-bar"><button id="bulk-btn-location">Location</button><button id="bulk-btn-status">Status</button><button id="bulk-btn-delete" disabled>Delete</button></div><div id="bulk-prompt-modal"><h3 id="bulk-prompt-title"></h3><div id="bulk-prompt-content"></div><button id="bulk-prompt-ok">Confirm</button><button id="bulk-prompt-cancel">Cancel</button></div>'
  const patches: Record<string, unknown>[] = []
  const alert = vi.fn(async () => {})
  vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => {
    patches.push(JSON.parse(String(init?.body)))
    return Response.json({})
  }))
  new Function('fetchAllPages', 'assignableLocations', 'escapeHtml', 'isAbortError', 'alert', `
    const selectedSpoolIds = new Set([1]), statuses = [{ id: 9, key: 'opened', label: 'Opened' }];
    let locations = [];
    const panelSignal = { aborted: false }, getAbortSignal = () => undefined, getCsrfToken = () => '';
    const t = key => key, translatePage = () => {}, updateBulkBar = () => {}, loadSpools = () => {};
    const dialogWindow = { __fmAlert: alert, __fmSuccess: async () => {} };
    ${production}
  `)(loadLocations, assignableLocations, escapeHtml, isAbortError, alert)
  return { patches, alert, button: (action: string) => document.getElementById(`bulk-btn-${action}`) as HTMLButtonElement }
}

it('keeps one bulk prompt owner while fresh location choices are pending', async () => {
  let finish!: (data: { items: { id: number; name: string }[] }) => void
  const fixture = setup(() => new Promise(resolve => { finish = resolve }))
  fixture.button('location').click()
  const statusWasDisabled = fixture.button('status').disabled
  fixture.button('status').click()
  finish({ items: [{ id: 2, name: 'New shelf' }] })
  await vi.waitFor(() => expect(document.getElementById('bulk-prompt-title')!.textContent).toBe('spools.bulkSetLocation'))
  document.getElementById('bulk-prompt-ok')!.click()
  await vi.waitFor(() => expect(fixture.patches).toHaveLength(1))
  expect(fixture.patches).toEqual([{ spool_ids: [1], location_id: 2 }])
  expect(statusWasDisabled).toBe(true)
  await vi.waitFor(() => expect(fixture.button('location').disabled).toBe(false))
  expect(fixture.button('status').disabled).toBe(false)
  expect(fixture.button('delete').disabled).toBe(true)
})

it.each(['offline', 'abort'])('restores bulk actions after a location lookup fails (%s)', async outcome => {
  const fixture = setup(async () => { throw outcome === 'abort' ? new DOMException('Navigation', 'AbortError') : new Error('Offline') })
  fixture.button('location').click()
  await vi.waitFor(() => expect(fixture.button('location').disabled).toBe(false))
  expect(fixture.button('status').disabled).toBe(false)
  expect(fixture.button('delete').disabled).toBe(true)
  expect(document.getElementById('bulk-prompt-modal')!.classList.contains('open')).toBe(false)
  expect(fixture.patches).toEqual([])
  expect(fixture.alert).toHaveBeenCalledTimes(outcome === 'abort' ? 0 : 1)
})
