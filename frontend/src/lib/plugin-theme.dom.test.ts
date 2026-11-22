// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { syncPluginTheme } from './plugin-theme'

const controllers: AbortController[] = []
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.abort())
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(onDocumentReady?: (embedded: Document) => void) {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const controller = new AbortController()
  controllers.push(controller)
  syncPluginTheme(frame, controller.signal, onDocumentReady)
  return { frame, root: frame.contentDocument!.documentElement, controller }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function pendingDocument(onDocumentReady?: (embedded: Document) => void) {
  const callbacks: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => callbacks.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  document.documentElement.dataset.theme = 'dark'
  const mounted = mount(onDocumentReady)
  const replacement = document.implementation.createHTMLDocument('Plugin with a stalled image')
  Object.defineProperty(replacement, 'URL', { value: 'http://localhost/plugin' })
  Object.defineProperty(replacement, 'readyState', { value: 'interactive' })
  replacement.documentElement.dataset.theme = 'brand'
  vi.spyOn(mounted.frame, 'contentDocument', 'get').mockReturnValue(replacement)
  return { ...mounted, replacement, paint: () => callbacks.shift()?.(0) }
}

it('reveals a parsed and themed document without waiting for its resources to load', () => {
  const { frame, replacement, paint } = pendingDocument()
  paint()
  expect(replacement.documentElement.dataset.theme).toBe('dark')
  expect(frame.style.visibility).toBe('visible')
})

it('does not reveal or theme a pending document after its panel is unmounted', () => {
  const { frame, replacement, controller, paint } = pendingDocument()
  controller.abort()
  paint()
  expect(replacement.documentElement.dataset.theme).toBe('brand')
  expect(frame.style.visibility).toBe('hidden')
})

it('initializes each plugin document once before revealing it, without waiting for load', () => {
  const visibility: string[] = []
  const onReady = () => { visibility.push(frame.style.visibility) }
  const { frame, paint } = pendingDocument(onReady)
  paint()
  expect(visibility).toEqual(['hidden'])
  frame.dispatchEvent(new Event('load'))
  frame.contentWindow!.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(visibility).toEqual(['hidden'])
})

it('does not reveal the outgoing document while navigation waits for a replacement', () => {
  const { frame, paint } = pendingDocument()
  paint()
  expect(frame.style.visibility).toBe('visible')
  frame.contentWindow!.dispatchEvent(new Event('pagehide'))
  paint()
  expect(frame.style.visibility).toBe('hidden')
})

it('conceals the plugin until its loaded document has the host theme', () => {
  document.documentElement.dataset.theme = 'dark'
  const { frame, root } = mount()
  expect(frame.style.visibility).toBe('hidden')
  root.dataset.theme = 'brand'
  frame.dispatchEvent(new Event('load'))
  expect(root.dataset.theme).toBe('dark')
  expect(frame.style.visibility).toBe('visible')
})

it('conceals in-frame navigation and reapplies the theme when restored from the browser cache', () => {
  document.documentElement.dataset.theme = 'dark'
  const { frame, root } = mount()
  frame.dispatchEvent(new Event('load'))
  frame.contentWindow!.dispatchEvent(new Event('pagehide'))
  expect(frame.style.visibility).toBe('hidden')
  root.dataset.theme = 'brand'
  frame.contentWindow!.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(root.dataset.theme).toBe('dark')
  expect(frame.style.visibility).toBe('visible')
})

it('uses the selected host theme on load and follows changes without reloading', async () => {
  document.documentElement.dataset.theme = 'light'
  const { frame, root } = mount()
  frame.dispatchEvent(new Event('load'))
  expect(root.dataset.theme).toBe('light')
  const child = frame.contentDocument
  document.documentElement.dataset.theme = 'dark'
  await settle()
  expect(root.dataset.theme).toBe('dark')
  expect(frame.contentDocument).toBe(child)
})

it('keeps the host theme when asynchronous plugin initialization resets it', async () => {
  document.documentElement.dataset.theme = 'dark'
  const { frame, root } = mount()
  frame.dispatchEvent(new Event('load'))
  root.dataset.theme = 'brand'
  await settle()
  expect(root.dataset.theme).toBe('dark')
})

it('stops synchronizing when its panel is unmounted', async () => {
  document.documentElement.dataset.theme = 'light'
  const { frame, root, controller } = mount()
  frame.dispatchEvent(new Event('load'))
  controller.abort()
  document.documentElement.dataset.theme = 'dark'
  root.dataset.theme = 'brand'
  frame.dispatchEvent(new Event('load'))
  await settle()
  expect(root.dataset.theme).toBe('brand')
})

it('reconnects after navigation and leaves inaccessible external pages alone', async () => {
  document.documentElement.dataset.theme = 'light'
  const { frame } = mount()
  const replacement = document.implementation.createHTMLDocument('Plugin settings')
  const content = vi.spyOn(frame, 'contentDocument', 'get').mockReturnValue(replacement)
  frame.dispatchEvent(new Event('load'))
  expect(replacement.documentElement.dataset.theme).toBe('light')
  content.mockImplementation(() => { throw new DOMException('Cross-origin', 'SecurityError') })
  expect(() => frame.dispatchEvent(new Event('load'))).not.toThrow()
  document.documentElement.dataset.theme = 'dark'
  await settle()
  expect(replacement.documentElement.dataset.theme).toBe('light')
})
