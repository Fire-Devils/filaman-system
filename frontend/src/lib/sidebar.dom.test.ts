// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { transpileModule, ScriptTarget } from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

const layout = readFileSync('src/layouts/Layout.astro', 'utf8')
const source = layout.split('/* ── Sidebar toggle')[1].split('/* ── SSE live-update')[0].replace(/^[\s\S]*?\*\//, '')
const bootstrap = layout.match(/<script is:inline>([\s\S]*?)<\/script>/)![1]
const start = new Function(bootstrap + transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText)
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.innerHTML = ''; document.documentElement.classList.remove('sidebar-collapsed'); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup(width: number, saved?: string) {
  if (saved) localStorage.setItem('sidebar-collapsed', saved)
  document.body.innerHTML = '<div id="fm-page"><aside class="fm-sidebar"><button id="sidebar-toggle"></button><div id="sidebar-content"><a href="/spools">Spools</a></div></aside><main></main><div id="sidebar-backdrop"></div></div>'
  const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
  vi.stubGlobal('matchMedia', (query: string) => {
    const state = { matches: width <= Number(query.match(/max-width:\s*(\d+)/)![1]), listeners: new Set<() => void>() }
    queries.set(query, state)
    return { get matches() { return state.matches }, addEventListener: (_: string, fn: () => void) => state.listeners.add(fn) }
  })
  vi.stubGlobal('innerWidth', width)
  const add = document.addEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation((...args: Parameters<typeof document.addEventListener>) => {
    add(...args)
    cleanups.push(() => document.removeEventListener(args[0], args[1], args[2]))
  })
  start()
  const collapsed = () => document.documentElement.classList.contains('sidebar-collapsed')
  const resize = (next: number) => {
    vi.stubGlobal('innerWidth', next)
    for (const [query, state] of queries) {
      const matches = next <= Number(query.match(/max-width:\s*(\d+)/)![1])
      if (matches !== state.matches) { state.matches = matches; state.listeners.forEach(fn => fn()) }
    }
  }
  return { collapsed, resize, main: document.querySelector('main')!, content: document.getElementById('sidebar-content')!, toggle: document.getElementById('sidebar-toggle')! }
}

it('uses the icon rail before the mobile drawer without overwriting the desktop preference', () => {
  const ui = setup(1440, 'false')
  expect(ui.collapsed()).toBe(false)
  ui.resize(1000)
  expect(ui.collapsed()).toBe(true)
  expect(ui.content.inert).toBe(false)
  expect(localStorage.getItem('sidebar-collapsed')).toBe('false')
  ui.resize(600)
  expect(ui.content.inert).toBe(false)
  ui.resize(599)
  expect(ui.content.inert).toBe(true)
  ui.resize(1440)
  expect(ui.collapsed()).toBe(false)
})
it('starts compact windows in the caret rail and respects a saved desktop collapse', () => {
  const ui = setup(800)
  expect(ui.collapsed()).toBe(true)
  expect(ui.content.inert).toBe(false)
  ui.toggle.click()
  expect(ui.collapsed()).toBe(false)
  ui.toggle.click()
  ui.resize(1920)
  expect(ui.collapsed()).toBe(true)
  expect(ui.main.inert).toBe(false)
})
it('keeps mobile drawer focus protection and Escape without changing desktop state', () => {
  const ui = setup(390, 'false')
  ui.toggle.click()
  expect(ui.main.inert).toBe(true)
  expect(ui.content.inert).toBe(false)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(ui.collapsed()).toBe(true)
  expect(ui.main.inert).toBe(false)
  expect(ui.content.inert).toBe(true)
  expect(localStorage.getItem('sidebar-collapsed')).toBe('false')
})
