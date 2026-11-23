// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountColorPluginHooks } from './color-plugin-hooks'
import { mountPluginUiLaunchers, type PluginUiSurfaceAdapter, type PluginSession } from './plugin-ui-launchers'
const get = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api: { get } }))
vi.mock('./plugin-theme', () => ({ syncPluginTheme: vi.fn() }))
vi.mock('./plugin-drawer', () => ({ mountPluginDrawer: (dialog: HTMLDialogElement) => ({ open: () => dialog.setAttribute('open', ''), close: () => dialog.removeAttribute('open') }) }))
const controllers: AbortController[] = []
const plugin = (id = 'tool') => ({ plugin_key: 'fixture', plugin_name: 'Fixture', launcher_id: id, surface: 'colors.library', label: '<b>Research</b>', page_url: '/plugin-page/fixture', icon_url: null, legacy: false })
function mount(options: Partial<PluginUiSurfaceAdapter> = {}) {
  const host = document.createElement('div')
  host.innerHTML = '<div data-plugin-hook-actions></div><dialog><h2></h2><button>Close</button><div data-plugin-hook-content></div></dialog>'
  document.body.append(host)
  const abort = new AbortController(); controllers.push(abort)
  const controller = mountPluginUiLaunchers(host, { surface: 'colors.library', workspace: document.body, isEligible: () => ({ enabled: true }), ...options }, abort.signal)
  return { host, controller }
}
beforeEach(() => { get.mockReset(); get.mockResolvedValue([plugin()]); Object.assign(window, { __fmConfirm: vi.fn(async () => true) }) })
afterEach(() => { controllers.splice(0).forEach(c => c.abort()); document.body.replaceChildren() })
it('renders safe accessible labels, fallback icons and overflow after three tools', async () => {
  get.mockResolvedValue(Array.from({length: 5}, (_, i) => plugin(String(i))))
  const {host, controller} = mount(); await controller.refresh()
  expect(host.querySelector('b')).toBeNull()
  expect(host.querySelectorAll('[data-plugin-hook-actions] > button')).toHaveLength(3)
  expect(host.querySelectorAll('details button')).toHaveLength(2)
  expect(host.querySelector('button')!.getAttribute('aria-label')).toBe('<b>Research</b> — Fixture')
  expect(host.querySelector('use')).not.toBeNull()
  const menu = host.querySelector('details')!; menu.open = true
  menu.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
  expect(menu.open).toBe(false)
})
it('provides retry after discovery failure', async () => {
  get.mockRejectedValueOnce(new Error('offline'))
  const {host, controller} = mount(); await controller.refresh()
  expect(host.textContent).toContain('Retry')
  get.mockResolvedValue([plugin()]); host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('[data-plugin-hook-actions] button')?.getAttribute('title')).toContain('Fixture'))
})
it('updates selection eligibility without refetching', async () => {
  let enabled = false
  const {host, controller} = mount({ isEligible: () => ({ enabled, reason: 'Select records' }) }); await controller.refresh()
  const button = host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!
  expect(button.disabled).toBe(true)
  enabled = true; controller.updateEligibility(); expect(button.disabled).toBe(false)
  expect(get).toHaveBeenCalledTimes(1)
})
it('arbitrates replacement across mounts and preserves the first tool on cancel', async () => {
  const first = mount(), second = mount(); await first.controller.refresh(); await second.controller.refresh()
  first.host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(first.host.querySelector('iframe')).not.toBeNull())
  const frame = first.host.querySelector('iframe')
  Object.assign(window, { __fmConfirm: vi.fn(async () => false) })
  second.host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(first.host.querySelector('iframe')).toBe(frame); expect(second.host.querySelector('iframe')).toBeNull()
})
it('ignores late discovery and removes frames on abort', async () => {
  let release!: (value: unknown) => void
  get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const {host, controller} = mount(); const old = controller.refresh()
  get.mockResolvedValue([plugin('new')]); await controller.refresh(); release([plugin('old')]); await old
  expect(host.querySelector('button')?.dataset.launcherId).toBe('new')
  host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  controllers.at(-1)!.abort(); expect(host.querySelector('iframe')).toBeNull()
})

it('does not reopen after the target entry closes during replacement confirmation', async () => {
  const first = mount(), second = mount(); await first.controller.refresh(); await second.controller.refresh()
  first.host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(first.host.querySelector('iframe')).not.toBeNull())
  let release!: (value: boolean) => void
  Object.assign(window, {__fmConfirm: () => new Promise<boolean>(resolve => {release = resolve})})
  second.host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  second.controller.close(); release(true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(second.host.querySelector('iframe')).toBeNull()
  expect(first.host.querySelector('iframe')).not.toBeNull()
})

it('binds context before load, rejects forged sources and invalidates same-path replacement documents', async () => {
  let ids = [1, 2]
  const {host, controller} = mount({surface: 'colors.selection', context: () => ({color_ids: [...ids]})})
  get.mockResolvedValue([{...plugin(), surface: 'colors.selection'}]); await controller.refresh()
  host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const frame = host.querySelector('iframe')!
  const sender = {location: {origin: location.origin, pathname: '/plugin-page/fixture'}, document: document.implementation.createHTMLDocument(), postMessage: vi.fn()}
  Object.defineProperty(frame, 'contentWindow', {value: sender, configurable: true})
  const data = {type: 'filaman:launcher-context', request_id: 'initial', version: 1}
  window.dispatchEvent(new MessageEvent('message', {data, origin: location.origin, source: window}))
  expect(sender.postMessage).not.toHaveBeenCalled()
  window.dispatchEvent(new MessageEvent('message', {data, origin: location.origin, source: sender as unknown as Window}))
  expect(sender.postMessage.mock.lastCall![0].context).toEqual({color_ids: [1, 2]})
  frame.dispatchEvent(new Event('load'))
  expect(host.querySelector('iframe')).toBe(frame)
  ids = [3]
  window.dispatchEvent(new MessageEvent('message', {data, origin: location.origin, source: sender as unknown as Window}))
  expect(sender.postMessage.mock.lastCall![0].context).toEqual({color_ids: [1, 2]})
  sender.document = document.implementation.createHTMLDocument()
  frame.dispatchEvent(new Event('load'))
  expect(host.querySelector('iframe')).toBeNull()
})

it('disposes an unsignaled page mount on Astro navigation', async () => {
  const host = document.createElement('div')
  host.innerHTML = '<div data-plugin-hook-actions></div><dialog><h2></h2><button>Close</button><div data-plugin-hook-content></div></dialog>'
  document.body.append(host)
  const controller = mountPluginUiLaunchers(host, {surface: 'colors.library', workspace: document.body, isEligible: () => ({enabled: true})})
  await controller.refresh(); host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const event = new Event('astro:before-swap')
  Object.defineProperty(event, 'newDocument', {value: document.implementation.createHTMLDocument()})
  document.dispatchEvent(event)
  expect(host.querySelector('iframe')).toBeNull()
})

it('refreshes and closes the tool after cross-tab plugin changes', async () => {
  const {host, controller} = mount(); await controller.refresh()
  host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  get.mockResolvedValue([])
  window.dispatchEvent(new StorageEvent('storage', {key: 'filaman:plugin-nav-changed', newValue: '{}'}))
  await vi.waitFor(() => expect(host.querySelector('iframe')).toBeNull())
  expect(host.querySelectorAll('[data-plugin-hook-actions] button')).toHaveLength(0)
})

it('invalidates stale buttons and pending opens at the start of rediscovery', async () => {
  const {host, controller} = mount(); await controller.refresh()
  const stale = host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!
  stale.click(); await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  let release!: (value: unknown) => void
  get.mockImplementationOnce(() => new Promise(resolve => {release = resolve}))
  const pending = controller.refresh()
  expect(host.querySelector('iframe')).toBeNull()
  expect(host.querySelectorAll('[data-plugin-hook-actions] button')).toHaveLength(0)
  stale.click(); await new Promise(resolve => setTimeout(resolve, 0))
  expect(host.querySelector('iframe')).toBeNull()
  release([]); await pending
})

it('shares ownership between a page and its nested color dialog', async () => {
  const page = document.createElement('main'); page.className = 'fm-main'; document.body.append(page)
  const modal = document.createElement('dialog'); page.append(modal)
  const first = mount({workspace: page}), second = mount({workspace: modal})
  await first.controller.refresh(); await second.controller.refresh()
  first.host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(first.host.querySelector('iframe')).not.toBeNull())
  const confirm = vi.fn(async () => false); Object.assign(window, {__fmConfirm: confirm})
  second.host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(confirm).toHaveBeenCalled()
  expect(second.host.querySelector('iframe')).toBeNull()
})

it('does not bind an unknown context message to an editor session', async () => {
  const onMessage = vi.fn()
  get.mockResolvedValue([{...plugin(), surface: 'colors.editor'}])
  const {host, controller} = mount({surface: 'colors.editor', mode: 'create', onMessage}); await controller.refresh()
  host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const frame = host.querySelector('iframe')!
  const sender = {location: {origin: location.origin, pathname: '/plugin-page/fixture'}, document: document.implementation.createHTMLDocument(), postMessage: vi.fn()}
  Object.defineProperty(frame, 'contentWindow', {value: sender, configurable: true})
  for(const type of ['fake-context', 'filaman:color-open']) window.dispatchEvent(new MessageEvent('message', {data: {type, request_id: 'fake', color_id: 1}, source: sender as unknown as Window, origin: location.origin}))
  expect(onMessage).not.toHaveBeenCalled()
})


it('keeps the conversation on submit while invalidating pending bridge operations', async () => {
  const sessions: PluginSession[] = []
  get.mockResolvedValue([{...plugin(), surface: 'colors.editor'}])
  const {host, controller} = mount({surface: 'colors.editor', mode: 'create', contextType: 'filaman:color-context',
    onMessage: (_message, session) => {sessions.push(session)}})
  await controller.refresh(); host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const frame = host.querySelector('iframe')!
  const sender = {location: {origin: location.origin, pathname: '/plugin-page/fixture'}, document: document.implementation.createHTMLDocument(), postMessage: vi.fn()}
  Object.defineProperty(frame, 'contentWindow', {value: sender, configurable: true})
  const request = () => window.dispatchEvent(new MessageEvent('message', {data: {type: 'filaman:color-context', request_id: 'read'}, source: sender as unknown as Window, origin: location.origin}))
  request(); expect(sessions[0].isCurrent()).toBe(true)
  const form = document.createElement('form'); document.body.append(form)
  form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
  expect(host.querySelector('iframe')).toBe(frame)
  expect(sessions[0].isCurrent()).toBe(false)
  sessions[0].reply({type: 'filaman:color-open', request_id: 'pending'}, {opened: false})
  expect(sender.postMessage).toHaveBeenLastCalledWith({type: 'filaman:color-open', request_id: 'pending', opened: false}, location.origin)
  request(); expect(sessions[1].isCurrent()).toBe(true)
  const replies = sender.postMessage.mock.calls.length
  sender.document = document.implementation.createHTMLDocument()
  sessions[1].reply({type: 'filaman:color-open', request_id: 'obsolete'}, {opened: false})
  expect(sender.postMessage).toHaveBeenCalledTimes(replies)
  expect(host.querySelector('iframe')).toBeNull()
})


it('ties late proposals to the context issued before submit, not message arrival', async () => {
  const sessions: PluginSession[] = []
  get.mockResolvedValue([{...plugin(), surface: 'colors.editor'}])
  const {host, controller} = mount({surface: 'colors.editor', mode: 'create', contextType: 'filaman:color-context',
    onMessage: (_message, session) => {sessions.push(session)}})
  await controller.refresh(); host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const sender = {location: {origin: location.origin, pathname: '/plugin-page/fixture'}, document: document.implementation.createHTMLDocument(), postMessage: vi.fn()}
  Object.defineProperty(host.querySelector('iframe')!, 'contentWindow', {value: sender, configurable: true})
  const send = (type: string) => window.dispatchEvent(new MessageEvent('message', {data: {type, request_id: type}, source: sender as unknown as Window, origin: location.origin}))
  send('filaman:color-context')
  const form = document.createElement('form'); document.body.append(form)
  form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
  send('filaman:color-stage')
  await vi.waitFor(() => expect(sessions).toHaveLength(2))
  expect(sessions[1].isCurrent()).toBe(false)
  send('filaman:color-context')
  expect(sessions[2].isCurrent()).toBe(true)
  form.dispatchEvent(new Event('input', {bubbles: true}))
  expect(sessions[2].isCurrent()).toBe(false)
})

it('revalidates on focus without replacing an authorized conversation and closes a revoked tool', async () => {
  const {host, controller} = mount(); await controller.refresh()
  host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const frame = host.querySelector('iframe')
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  expect(host.querySelector('iframe')).toBe(frame)
  get.mockResolvedValue([])
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(host.querySelector('iframe')).toBeNull())
  expect(host.querySelector('[data-plugin-hook-actions] button')).toBeNull()
})

it('rechecks server eligibility before handing a stage request to the adapter', async () => {
  const onMessage = vi.fn()
  get.mockResolvedValue([{...plugin(), surface: 'colors.editor'}])
  const {host, controller} = mount({surface: 'colors.editor', mode: 'create', contextType: 'filaman:color-context', onMessage})
  await controller.refresh(); host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const sender = {location: {origin: location.origin, pathname: '/plugin-page/fixture'}, document: document.implementation.createHTMLDocument(), postMessage: vi.fn()}
  Object.defineProperty(host.querySelector('iframe')!, 'contentWindow', {value: sender, configurable: true})
  const send = (type: string) => window.dispatchEvent(new MessageEvent('message', {data: {type, request_id: type}, source: sender as unknown as Window, origin: location.origin}))
  send('filaman:color-context'); expect(onMessage).toHaveBeenCalledTimes(1)
  get.mockResolvedValue([]); send('filaman:color-stage')
  await vi.waitFor(() => expect(host.querySelector('iframe')).toBeNull())
  expect(onMessage).toHaveBeenCalledTimes(1)
})


it('retains the conversation on a transient focus refresh failure', async () => {
  const {host, controller} = mount(); await controller.refresh()
  host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const frame = host.querySelector('iframe')
  get.mockRejectedValue(new Error('Temporary outage'))
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(host.querySelector('iframe')).toBe(frame)
})

it('returns overflow focus to the visible summary after revalidation', async () => {
  get.mockResolvedValue(Array.from({length: 5}, (_, i) => plugin(String(i))))
  const {host, controller} = mount(); await controller.refresh()
  host.querySelector('details')!.open = true
  host.querySelector<HTMLButtonElement>('details button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  await new Promise(resolve => setTimeout(resolve, 0))
  controller.close()
  expect(document.activeElement).toBe(host.querySelector('summary'))
})


it.each(['edited', 'expired'])('does not revive a stage waiting for discovery after it is %s', async outcome => {
  const stageStates: boolean[] = []
  const onMessage = vi.fn((message: {type: string}, session: PluginSession) => {
    if (message.type === 'filaman:color-stage') stageStates.push(session.isCurrent())
  })
  get.mockResolvedValue([{...plugin(), surface: 'colors.editor'}])
  const {host, controller} = mount({surface: 'colors.editor', mode: 'create', contextType: 'filaman:color-context', onMessage})
  await controller.refresh(); host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const sender = {location: {origin: location.origin, pathname: '/plugin-page/fixture'}, document: document.implementation.createHTMLDocument(), postMessage: vi.fn()}
  Object.defineProperty(host.querySelector('iframe')!, 'contentWindow', {value: sender, configurable: true})
  const send = (type: string) => window.dispatchEvent(new MessageEvent('message', {data: {type, request_id: type}, source: sender as unknown as Window, origin: location.origin}))
  send('filaman:color-context')
  let release!: (value: unknown) => void
  get.mockImplementationOnce(() => new Promise(resolve => {release = resolve}))
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    send('filaman:color-stage')
    if (outcome === 'edited') {
      document.body.dispatchEvent(new Event('input', {bubbles: true}))
      send('filaman:color-context')
    } else clock.mockReturnValue(4000)
    release([{...plugin(), surface: 'colors.editor'}])
    await vi.waitFor(() => expect(stageStates).toEqual([false]))
    expect(host.querySelector('iframe')).not.toBeNull()
  } finally { clock.mockRestore() }
})


it.each(['edit', 'save', 'offline'])('returns the color contract when authorization is interrupted by %s', async outcome => {
  const workspace = document.createElement('dialog'); workspace.open = true
  const host = document.createElement('div')
  host.innerHTML = '<div data-plugin-hook-actions></div><dialog><h2></h2><button>Close</button><div data-plugin-hook-content></div></dialog>'
  workspace.append(host); document.body.append(workspace)
  const lifecycle = new AbortController(); controllers.push(lifecycle)
  const fields = {name: 'Draft', hex_code: '#12345680'}, stage = vi.fn(), openExisting = vi.fn(async () => false)
  get.mockResolvedValue([{...plugin(), surface: 'colors.editor'}])
  const controller = mountColorPluginHooks(host, workspace, {
    read: () => ({mode: 'create', color_id: null, usage_count: 0, fields}), busy: () => false, stage, openExisting,
  }, lifecycle.signal)
  await controller.refresh(); host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  const sender = {location: {origin: location.origin, pathname: '/plugin-page/fixture'}, document: document.implementation.createHTMLDocument(), postMessage: vi.fn()}
  Object.defineProperty(host.querySelector('iframe')!, 'contentWindow', {value: sender, configurable: true})
  const send = (type: string, extra = {}) => window.dispatchEvent(new MessageEvent('message', {data: {type, request_id: type, ...extra}, source: sender as unknown as Window, origin: location.origin}))
  send('filaman:color-context')
  let release!: (value: unknown) => void, fail!: (reason: unknown) => void
  get.mockImplementationOnce(() => new Promise((resolve, reject) => {release = resolve; fail = reject}))
  const type = outcome === 'save' ? 'filaman:color-open' : 'filaman:color-stage'
  send(type, {expected: fields, fields: {name: 'Proposal', hex_code: '#112233'}, color_id: 1})
  if (outcome === 'offline') fail(new Error('Temporary discovery outage'))
  else {
    workspace.dispatchEvent(new Event(outcome === 'save' ? 'submit' : 'input', {bubbles: true, cancelable: true}))
    release([{...plugin(), surface: 'colors.editor'}])
  }
  await vi.waitFor(() => expect(sender.postMessage).toHaveBeenCalledWith(expect.objectContaining({request_id: type}), location.origin))
  const reply = sender.postMessage.mock.calls.find(([message]) => message.request_id === type)![0]
  expect(reply).toEqual({type, request_id: type, ...(outcome === 'offline' ? {error: 'integration_unavailable'}
    : outcome === 'save' ? {opened: false} : {staged: [], skipped: ['name', 'hex_code']})})
  expect(stage).not.toHaveBeenCalled(); expect(openExisting).not.toHaveBeenCalled()
  expect(host.querySelector('iframe')).not.toBeNull()
})


it.each(['unchanged', 'renamed', 'removed'])('handles a %s launcher refresh during replacement confirmation', async outcome => {
  const first = mount(), second = mount(); await first.controller.refresh(); await second.controller.refresh()
  first.host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(first.host.querySelector('iframe')).not.toBeNull())
  let confirm!: (value: boolean) => void
  Object.assign(window, {__fmConfirm: vi.fn(() => new Promise<boolean>(resolve => {confirm = resolve}))})
  second.host.querySelector<HTMLButtonElement>('[data-plugin-hook-actions] button')!.click()
  await vi.waitFor(() => expect(confirm).toBeDefined())
  get.mockResolvedValue(outcome === 'removed' ? [] : [{...plugin(), ...(outcome === 'renamed' ? {label: 'Updated'} : {})}])
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4))
  await new Promise(resolve => setTimeout(resolve, 0))
  confirm(true)
  if (outcome === 'removed') {
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.host.querySelector('iframe')).toBeNull()
  } else {
    await vi.waitFor(() => expect(second.host.querySelector('iframe')).not.toBeNull())
    expect(first.host.querySelector('iframe')).toBeNull()
    expect(second.host.querySelector('h2')!.textContent).toBe(outcome === 'renamed' ? 'Updated — Fixture' : '<b>Research</b> — Fixture')
  }
})

it.each([false, true])('preserves focused controls and menu state on unchanged refresh (overflow=%s)', async overflow => {
  get.mockResolvedValue(Array.from({length: 5}, (_, i) => plugin(String(i))))
  const {host, controller} = mount(); await controller.refresh()
  const menu = host.querySelector('details')!; menu.open = overflow
  const button = host.querySelector<HTMLButtonElement>(overflow ? 'details button' : '[data-plugin-hook-actions] > button')!
  button.focus()
  // JSON key order has no effect on launcher identity or presentation.
  get.mockResolvedValue(Array.from({length: 5}, (_, i) => {const {label, ...rest} = plugin(String(i)); return {label, ...rest}}))
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.activeElement).toBe(button)
  expect(host.querySelector('details')).toBe(menu)
  expect(menu.open).toBe(overflow)
})


it('clears a stale Retry control after successful empty focus discovery', async () => {
  get.mockRejectedValueOnce(new Error('Offline'))
  const {host, controller} = mount(); await controller.refresh()
  expect(host.querySelector('[data-plugin-hook-actions]')!.textContent).toContain('Retry')
  get.mockResolvedValue([]); window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(host.querySelector('[data-plugin-hook-actions]')!.children).toHaveLength(0))
})

it.each([true, false])('waits for current placement validation before replacing the conversation (available=%s)', async available => {
  const original = plugin('original'), target = plugin('target')
  get.mockResolvedValue([original, target])
  const first = mount(), second = mount(); await first.controller.refresh(); await second.controller.refresh()
  first.host.querySelector<HTMLButtonElement>('[data-launcher-id="original"]')!.click()
  await vi.waitFor(() => expect(first.host.querySelector('iframe')).not.toBeNull())
  const conversation = first.host.querySelector('iframe')
  let confirm!: (value: boolean) => void
  Object.assign(window, {__fmConfirm: vi.fn(() => new Promise<boolean>(resolve => {confirm = resolve}))})
  second.host.querySelector<HTMLButtonElement>('[data-launcher-id="target"]')!.click()
  let validate!: (value: unknown) => void
  const reads: ((value: unknown) => void)[] = []
  get.mockResolvedValueOnce([original]).mockImplementation(() => new Promise(resolve => {reads.push(resolve); validate = resolve}))
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4))
  confirm(true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(first.host.querySelector('iframe')).toBe(conversation)
  expect(second.host.querySelector('iframe')).toBeNull()
  // Resolve the latest action-time validation; superseded reads must not authorize opening.
  validate(available ? [original, target] : [original])
  if (available) await vi.waitFor(() => expect(second.host.querySelector('iframe')).not.toBeNull())
  else {
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(first.host.querySelector('iframe')).toBe(conversation)
    expect(second.host.querySelector('iframe')).toBeNull()
  }
  for (const finish of reads) finish([original])
  await new Promise(resolve => setTimeout(resolve, 0))
})
