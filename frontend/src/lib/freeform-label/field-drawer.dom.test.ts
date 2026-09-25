// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import DesignerWorkspace from '../../components/freeform-label/DesignerWorkspace.astro'
import { bindFreeformEditorDom, createFreeformEditorController } from './editor-controller'

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

it('places the text tools below the label without moving the canvas', async () => {
  const container = await AstroContainer.create()
  document.body.innerHTML = await container.renderToString(DesignerWorkspace)
  const row = document.querySelector<HTMLElement>('.freeform-canvas-row')!
  const dock = document.querySelector<HTMLElement>('#freeform-field-dock')!
  const binding = bindFreeformEditorDom({ controller: createFreeformEditorController() })
  await binding.ready
  try {
    expect(row.contains(dock)).toBe(true)
    expect(row.querySelector('#freeform-canvas-host')!.nextElementSibling?.id).toBe('freeform-element-inspector')
    expect([...row.children].indexOf(dock)).toBeGreaterThan([...row.children].indexOf(row.querySelector('#freeform-element-inspector')!))
  } finally { binding.destroy() }
})

it('keeps the under-label token panel collapsible and hides it for non-text selection', async () => {
  const container = await AstroContainer.create()
  document.body.innerHTML = await container.renderToString(DesignerWorkspace)
  const controller = createFreeformEditorController()
  const binding = bindFreeformEditorDom({ controller })
  await binding.ready
  try {
    const dock = document.querySelector<HTMLElement>('#freeform-field-dock')!
    const toggle = document.querySelector<HTMLButtonElement>('#freeform-field-dock-toggle')
    expect(toggle).not.toBeNull()
    const body = document.getElementById(toggle!.getAttribute('aria-controls')!)!
    expect(toggle!.getAttribute('aria-expanded')).toBe('true')
    expect(dock.dataset.available).toBe('true')
    expect(body.hasAttribute('inert')).toBe(false)

    toggle!.click()
    binding.sync()
    expect(dock.dataset.open).toBe('false')
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')
    expect(dock.hasAttribute('inert')).toBe(false)
    expect(body.hasAttribute('inert')).toBe(true)

    toggle!.click()
    expect(dock.dataset.open).toBe('true')
    controller.addElement('qr')
    binding.sync()
    expect(dock.dataset.open).toBe('false')
    expect(dock.dataset.available).toBe('false')
    expect(toggle!.disabled).toBe(true)
    controller.select(controller.getDesign().elements.find(element => element.type === 'text')!.id)
    binding.sync()
    expect(dock.dataset.open).toBe('true')
    await binding.setEditable(false)
    expect(dock.hasAttribute('inert')).toBe(true)
    expect(body.hasAttribute('inert')).toBe(true)
  } finally { binding.destroy() }
})

it('opens the selected text template in a manual editor with shared syntax help', async () => {
  const container = await AstroContainer.create()
  document.body.innerHTML = await container.renderToString(DesignerWorkspace)
  const dock = document.querySelector<HTMLElement>('#freeform-field-dock')!
  const trigger = dock.querySelector<HTMLButtonElement>('#freeform-template-expand')!
  const editor = dock.querySelector<HTMLElement>('#freeform-template-section')!
  expect(trigger?.getAttribute('popovertarget')).toBe('freeform-template-section')
  expect(trigger?.textContent?.trim()).toBe('Template Manual Editor')
  expect(editor?.getAttribute('popover')).toBe('auto')
  expect(editor?.querySelector('#freeform-template')).not.toBeNull()
  const syntaxButton = editor?.querySelector<HTMLButtonElement>('[popovertarget="freeform-syntax-section"]')
  expect(syntaxButton?.textContent?.trim()).toBe('Syntax')
  expect(syntaxButton?.dataset.i18n).toBe('labelDesigner.syntax')
  expect(document.querySelectorAll('#freeform-syntax-section')).toHaveLength(1)
  expect(document.querySelector('#freeform-syntax-section a[href="#freeform-syntax-font"]')).toBeNull()
  const help = document.querySelector<HTMLElement>('#freeform-syntax-section')!.textContent!
  for (const syntax of ['[b]bold[/b]', '[i]italic[/i]', '**bold**', '*italic*', '__underline__', '^^UPPER^^', '==inverse==', '@@color@@', '|date', '[font=', '[size=']) {
    expect(help).toContain(syntax)
  }
  expect(help).toContain('Wrap and Scale font to fit')
  for (const example of ['{filament.color_hex}', '{color_swatch[1]}', '[b]__{filament.name}__[/b]', '[b][i]{filament.name}[/i][/b]', 'Blue uses white text', 'Yellow uses black text']) {
    expect(help).toContain(example)
  }
  expect(document.querySelectorAll('#freeform-syntax-section .freeform-syntax-modifier-icon')).toHaveLength(7)
  const legacy = [...document.querySelectorAll<HTMLElement>('#freeform-syntax-section .freeform-syntax-legacy')]
  expect(legacy.map(label => label.textContent?.trim())).toEqual(['Legacy syntax', 'Legacy syntax'])
  expect(legacy.every(label => label.dataset.i18n === 'labelDesigner.legacySyntax')).toBe(true)
  expect(document.querySelector('#freeform-syntax-section .freeform-syntax-example-swatch')).not.toBeNull()
  expect(dock.querySelector('#freeform-field-hint')).toBeNull()
})
