import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const base = process.argv[2] || 'http://127.0.0.1:4321'
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH })
const color = { id: 11, name: 'Shared red', hex_code: '#FF000080', usage_count: 3 }
const plugin = { plugin_key: 'fixture', name: 'Fixture Plugin', page_url: '/plugin-page/fixture', editor_launcher: { style: 'icon' } }
const writes = []
let failNextSave = true
let failedSaveStarted, releaseFailedSave, openReadStarted, releaseOpenRead
let failureStarted = new Promise(resolve => {failedSaveStarted = resolve})
let failureGate = new Promise(resolve => {releaseFailedSave = resolve})
let holdDiscovery = true, revoked = false, releaseDiscovery
const discoveryGate = new Promise(resolve => {releaseDiscovery = resolve})
let holdOpenRead = false
const openStarted = new Promise(resolve => {openReadStarted = resolve})
const openGate = new Promise(resolve => {releaseOpenRead = resolve})
try {
 const page = await browser.newPage({ viewport: { width: 1600, height: 900 } }); page.setDefaultTimeout(6000)
 const errors = []; page.on('pageerror', error => errors.push(error.message))
 await page.route('**/plugin-page/fixture?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Color assistant fixture</title><input aria-label="Assistant draft"><p>Color assistant fixture</p>' }))
 await page.route(/\/(?:api\/|auth\/me$)/, async route => {
  const req = route.request(), path = new URL(req.url()).pathname
  if (req.method() !== 'GET') {
   if (path.startsWith('/api/v1/colors')) {
    writes.push({path, body: req.postDataJSON()})
    if (failNextSave) { failNextSave = false; failedSaveStarted(); await failureGate; return route.fulfill({status: 500, json: {message: 'Temporary save outage'}}) }
   }
   return route.fulfill({json: {...color, ...req.postDataJSON()}})
  }
  let json = []
  if (path.endsWith('/me')) json = { id: 1, is_superadmin: true, language: 'en', permissions: [], roles: [] }
  else if (path.endsWith('/me/preferences/sidebar')) json = { sidebar: null, theme: 'light', expanded: false }
  else if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
  else if (path.endsWith('/plugin-ui-launchers')) {
   const surface = new URL(req.url()).searchParams.get('surface')
   if (holdDiscovery && surface === 'colors.editor') await discoveryGate
   const descriptor = p => ({...p, plugin_name: p.name, label: p.name, launcher_id: 'legacy', surface, legacy: true})
   json = surface === 'colors.editor' && !revoked ? [descriptor(plugin), descriptor({...plugin, page_url: 'https://example.invalid/plugin', name: 'Invalid external'})] : []
  }
  else if (path.endsWith('/colors/11')) {
   if (holdOpenRead) { holdOpenRead = false; openReadStarted(); await openGate }
   json = color
  }
  else if (path.endsWith('/colors')) json = { items: [color], total: 1 }
  return route.fulfill({ json })
 })
 await page.goto(base + '/filaments/colors')
 await page.getByRole('button', { name: 'Add Color', exact: true }).click()
 const outer = page.locator('#modal-container'), assistant = outer.locator('.fm-plugin-drawer')
 const name = page.locator('#color-name'), hex = page.locator('#color-hex'), save = page.locator('#modal-submit')
 await name.fill('Typed draft'); await hex.fill('#12345680')
 await save.click(); await failureStarted
 releaseDiscovery(); holdDiscovery = false
 const tool = outer.getByRole('button', {name: 'Fixture Plugin', exact: true})
 await tool.waitFor(); assert.equal(await tool.isDisabled(), true)
 assert.equal(await tool.getAttribute('title'), 'Saving...')
 releaseFailedSave()
 await page.locator('#modal-error').filter({hasText: 'Temporary save outage'}).waitFor()
 await page.waitForFunction(() => !document.querySelector('[data-color-plugin-hooks] [data-plugin-hook-actions] button').disabled)
 writes.length = 0; failNextSave = true
 failureStarted = new Promise(resolve => {failedSaveStarted = resolve})
 failureGate = new Promise(resolve => {releaseFailedSave = resolve})
 await outer.getByRole('button', { name: 'Fixture Plugin', exact: true }).click()
 await assistant.frameLocator('iframe').getByText('Color assistant fixture', { exact: true }).waitFor()
 let frame = page.frames().find(frame => frame.url().includes('color_host=editor'))
 assert.ok(frame)
 const message = (type, payload = {}) => frame.evaluate(({ type, payload }) => new Promise((resolve, reject) => {
  const request_id = crypto.randomUUID(), timeout = setTimeout(() => reject(new Error('No response: ' + type)), type === 'filaman:color-open' ? 10000 : 4000)
  window.addEventListener('message', function receive(event) {
   if (event.source !== parent || event.origin !== location.origin || event.data?.request_id !== request_id) return
   clearTimeout(timeout); window.removeEventListener('message', receive); resolve(event.data)
  }); parent.postMessage({ type, request_id, ...payload }, location.origin)
 }), { type, payload })
 const context = await message('filaman:color-context')
 assert.equal(context.mode, 'create'); assert.equal(context.color_id, null)
 assert.deepEqual(context.fields, { name: 'Typed draft', hex_code: '#12345680' })
 assert.equal(await assistant.evaluate(el => el.matches(':modal')), false)
 await name.fill('Manual change')
 let result = await message('filaman:color-stage', { expected: context.fields, fields: { name: 'Traffic red (RAL 3020)', hex_code: '#AB1519' } })
 assert.deepEqual(result.staged, []); assert.equal(await name.inputValue(), 'Manual change')
 await name.fill('Typed draft')
 result = await message('filaman:color-stage', { expected: context.fields, fields: { name: 'Injected', hex_code: '#AB1519', id: 11 } })
 assert.deepEqual(result.staged, [])
 result = await message('filaman:color-stage', { expected: context.fields, fields: { name: 'Traffic red (RAL 3020)', hex_code: '#AB1519' } })
 assert.deepEqual(result.staged, [], 'Restoring values does not renew the old context')
 await message('filaman:color-context')
 result = await message('filaman:color-stage', { expected: context.fields, fields: { name: 'Traffic red (RAL 3020)', hex_code: '#AB1519' } })
 assert.deepEqual(result.staged, ['name', 'hex_code'])
 assert.equal(await name.inputValue(), 'Traffic red (RAL 3020)'); assert.equal(await hex.inputValue(), '#AB151980')
 assert.equal(await save.isEnabled(), true); assert.equal(writes.length, 0)
 await save.focus(); assert.equal(await save.evaluate(el => document.activeElement === el), true)
 const firstFields = {...result.fields}
 const secondStage = await message('filaman:color-stage', {expected: firstFields, fields: {name: 'Second choice', hex_code: '#AABBCC'}})
 assert.deepEqual(secondStage.staged, ['name', 'hex_code'], 'A second Use continues from the accepted host fields')
 const restoredStage = await message('filaman:color-stage', {expected: secondStage.fields, fields: firstFields})
 assert.deepEqual(restoredStage.staged, ['name', 'hex_code'])
 await frame.getByRole('textbox', { name: 'Assistant draft' }).fill('Keep my conversation')
 const original = frame
 for (const width of [320, 390, 768, 1024, 1280, 1440, 1920]) {
  await page.setViewportSize({ width, height: 900 })
  await page.waitForFunction(docked => document.querySelector('.fm-plugin-drawer[open]')?.matches(':modal') === !docked, width - 34 >= 1000)
  assert.equal(page.frames().find(item => item.url().includes('color_host=editor')), original)
  assert.equal(await frame.getByRole('textbox', { name: 'Assistant draft' }).inputValue(), 'Keep my conversation')
  assert.equal(await hex.inputValue(), '#AB151980')
 }
 await page.setViewportSize({ width: 1600, height: 900 })
 const beforeFailedSave = await message('filaman:color-context')
 await save.click()
 await failureStarted
 assert.equal((await message('filaman:color-open', {color_id: 11})).opened, false, 'Open during Save must cancel, never leave the client waiting')
 releaseFailedSave()
 await page.locator('#modal-error').filter({hasText: 'Temporary save outage'}).waitFor()
 assert.equal(await outer.isVisible(), true)
 assert.equal(page.frames().find(item => item.url().includes('color_host=editor')), original)
 assert.equal(await frame.getByRole('textbox', {name: 'Assistant draft'}).inputValue(), 'Keep my conversation')
 assert.equal(await name.inputValue(), 'Traffic red (RAL 3020)')
 assert.equal(await save.isEnabled(), true)
 const late = await message('filaman:color-stage', {expected: beforeFailedSave.fields, fields: {name: 'Late old result', hex_code: '#112233'}})
 assert.deepEqual(late.staged, [])
 assert.equal(await name.inputValue(), 'Traffic red (RAL 3020)')
 const afterFailure = await message('filaman:color-context')
 assert.deepEqual(afterFailure.fields, {name: 'Traffic red (RAL 3020)', hex_code: '#AB151980'})
 holdOpenRead = true
 const interruptedOpen = message('filaman:color-open', {color_id: 11})
 void interruptedOpen.catch(() => {})
 await openStarted
 failNextSave = true
 await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/colors')), save.click()])
 await page.locator('#modal-error').filter({hasText: 'Temporary save outage'}).waitFor()
 releaseOpenRead()
 assert.equal((await interruptedOpen).opened, false, 'Open interrupted by Save must cancel in the surviving frame')
 assert.equal(page.frames().find(item => item.url().includes('color_host=editor')), original)
 await save.click()
 await outer.waitFor({ state: 'hidden' })
 assert.equal(writes.length, 3); assert.equal(writes[0].path, '/api/v1/colors')
 assert.deepEqual(writes[1], writes[0])
 assert.deepEqual(writes[2], writes[0])
 assert.deepEqual(writes[0].body, { name: 'Traffic red (RAL 3020)', hex_code: '#AB151980' })
 assert.equal(await assistant.locator('iframe').count(), 0)
 await page.getByRole('button', { name: 'Add Color', exact: true }).click()
 await outer.getByRole('button', { name: 'Fixture Plugin', exact: true }).click()
 await assistant.frameLocator('iframe').getByText('Color assistant fixture', { exact: true }).waitFor()
 frame = page.frames().find(item => item.url().includes('color_host=editor'))
 await message('filaman:color-context')
 await name.fill('Keep this unsaved color')
 const pendingOpen = message('filaman:color-open', {color_id: 11})
 void pendingOpen.catch(() => {})
 const confirm = page.locator('#fm-confirm-overlay'), confirmOk = page.locator('#fm-confirm-ok')
 await confirm.waitFor({state: 'visible'})
 await page.setViewportSize({width: 390, height: 900})
 assert.equal(await confirmOk.evaluate(button => {
  const box = button.getBoundingClientRect()
  return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
 }), true, 'Responsive drawer must not cover a pending human confirmation')
 assert.equal(await confirmOk.textContent(), 'Open color')
 assert.equal(await confirmOk.evaluate(button => button.classList.contains('fm-btn-danger')), false)
 await page.locator('#fm-confirm-cancel').click()
 assert.equal((await pendingOpen).opened, false)
 await page.setViewportSize({width: 1600, height: 900})
 await page.evaluate(() => { window.__fmConfirm = async () => false })
 result = await message('filaman:color-open', { color_id: 11 })
 assert.equal(result.opened, false); assert.equal(await name.inputValue(), 'Keep this unsaved color')
 await page.evaluate(() => { window.__fmConfirm = async () => true })
 await frame.evaluate(() => parent.postMessage({ type: 'filaman:color-open', request_id: crypto.randomUUID(), color_id: 11 }, location.origin))
 await outer.getByRole('heading', { name: 'Edit Color', exact: true }).waitFor()
 assert.equal(await name.inputValue(), color.name); assert.equal(await hex.inputValue(), color.hex_code)
 assert.equal(await assistant.locator('iframe').count(), 0)
 await outer.getByRole('button', { name: 'Fixture Plugin', exact: true }).click()
 await assistant.frameLocator('iframe').getByText('Color assistant fixture', { exact: true }).waitFor()
 frame = page.frames().find(item => item.url().includes('color_host=editor'))
 const editing = await message('filaman:color-context')
 assert.equal(editing.mode, 'edit'); assert.equal(editing.color_id, 11); assert.equal(editing.usage_count, 3)
 assert.equal(writes.length, 3)
 const retainedFrame = frame
 await page.evaluate(() => window.dispatchEvent(new Event('focus')))
 await page.waitForTimeout(100)
 assert.equal(page.frames().find(item => item.url().includes('color_host=editor')), retainedFrame)
 revoked = true
 await frame.evaluate(() => parent.postMessage({type: 'filaman:color-stage', request_id: 'revoked', expected: {name: 'Shared red', hex_code: '#FF000080'}, fields: {name: 'Must not stage', hex_code: '#112233'}}, location.origin))
 await assistant.locator('iframe').waitFor({state: 'detached'})
 assert.equal(await name.inputValue(), color.name)
 assert.equal(await tool.count(), 0)
 assert.deepEqual(errors, [])
 console.log('Native color hook passed: dock/modal, unsaved staging, alpha, dirty Save, stale/invalid proposals, explicit existing match and shared usage; no automatic writes.')
} finally { await browser.close() }
