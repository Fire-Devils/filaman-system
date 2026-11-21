// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { syncPluginTheme } from './plugin-theme'

const controllers: AbortController[] = []
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.abort())
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

function mount() {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const controller = new AbortController()
  controllers.push(controller)
  syncPluginTheme(frame, controller.signal)
  return { frame, root: frame.contentDocument!.documentElement, controller }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

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
