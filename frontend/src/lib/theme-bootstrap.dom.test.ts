// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

const layout = readFileSync('src/layouts/Layout.astro', 'utf8')
const bootstrap = new Function('window', layout.match(/<script is:inline>([\s\S]*?)<\/script>/)![1])
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

it.each(['brand', 'light', 'dark'])('restores cached %s before application startup without reviving the legacy preference', theme => {
  localStorage.setItem('filaman-theme-cache', theme)
  localStorage.setItem('theme', 'brand')
  bootstrap(window)
  expect(document.documentElement.dataset.theme).toBe(theme)
})

it('uses legacy preferences when no presentation cache exists', () => {
  localStorage.setItem('theme', 'light')
  bootstrap(window)
  expect(document.documentElement.dataset.theme).toBe('light')
})

it('inherits the immediate parent theme and resists delayed account initialization', async () => {
  const parent = document.implementation.createHTMLDocument('Old FilaBrain')
  parent.documentElement.dataset.theme = 'dark'
  localStorage.setItem('filaman-theme-cache', 'brand')
  bootstrap({ parent: { document: parent }, addEventListener: window.addEventListener.bind(window), innerWidth: 1440 })
  expect(document.documentElement.dataset.theme).toBe('dark')
  document.documentElement.dataset.theme = 'brand'
  await settle()
  expect(document.documentElement.dataset.theme).toBe('dark')
  parent.documentElement.dataset.theme = 'light'
  await settle()
  expect(document.documentElement.dataset.theme).toBe('light')
  window.dispatchEvent(new Event('pagehide'))
  parent.documentElement.dataset.theme = 'brand'
  await settle()
  expect(document.documentElement.dataset.theme).toBe('light')
  window.dispatchEvent(new Event('pageshow'))
  expect(document.documentElement.dataset.theme).toBe('brand')
})

it('still initializes when browser storage is blocked and the parent is cross-origin', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
  expect(() => bootstrap({ get parent() { throw new DOMException('Cross-origin', 'SecurityError') }, innerWidth: 1440 })).not.toThrow()
  expect(document.documentElement.dataset.theme).toBe('brand')
})
