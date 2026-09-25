// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import CanvasTextToolbar from '../../components/freeform-label/CanvasTextToolbar.astro'
import DesignerWorkspace from '../../components/freeform-label/DesignerWorkspace.astro'
import ElementInspector from '../../components/freeform-label/ElementInspector.astro'
import FieldDock from '../../components/freeform-label/FieldDock.astro'
import { bindDesignerTooltips } from './designer-tooltips'
import { designerIcon } from './icons'

afterEach(() => vi.useRealTimers())

describe('designer tooltips', () => {
  it('shows a prompt tooltip for titled, labeled, and QR choice controls without a duplicate native title', () => {
    vi.useFakeTimers()
    document.body.innerHTML = `<div id="workspace"><button title="Add text">Text</button><button aria-label="Scale font to fit"></button><label class="freeform-qr-center-option" title="No center logo"><input type="radio" />None</label></div>`
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const [add, fit] = Array.from(workspace.querySelectorAll('button'))
    const choice = workspace.querySelector<HTMLElement>('label')!
    const unbind = bindDesignerTooltips(workspace)

    add.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.hidden).toBe(true)
    vi.advanceTimersByTime(299)
    expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.hidden).toBe(true)
    vi.advanceTimersByTime(1)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Add text')
    expect(add.hasAttribute('title')).toBe(false)

    fit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    vi.advanceTimersByTime(300)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Scale font to fit')
    expect(add.title).toBe('Add text')

    choice.querySelector('input')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('No center logo')
    unbind()
    vi.useRealTimers()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    expect(choice.title).toBe('No center logo')
  })

  it('does not put an element-type tooltip over selectable label artwork', () => {
    document.body.innerHTML = '<div id="workspace"><div role="button" aria-label="Text element" data-label-element-id="text">Preview text</div></div>'
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const unbind = bindDesignerTooltips(workspace)
    workspace.querySelector<HTMLElement>('[data-label-element-id]')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(document.querySelector<HTMLElement>('[role="tooltip"]')!.hidden).toBe(true)
    unbind()
  })

  it('cancels a pending hover tooltip when the pointer leaves', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="workspace"><button title="Add text">Text</button></div>'
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const button = workspace.querySelector('button')!
    const unbind = bindDesignerTooltips(workspace)
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    vi.advanceTimersByTime(300)
    expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.hidden).toBe(true)
    expect(button.title).toBe('Add text')
    unbind()
  })

  it('lets the fit icon follow its button color in both toggle states', () => {
    document.body.innerHTML = `<button style="color: white">${designerIcon('fitText')}</button>`
    const svg = document.querySelector('svg')!
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect([...svg.querySelectorAll('path')].every(path => !path.hasAttribute('stroke'))).toBe(true)
    expect(svg.innerHTML).toContain('M8 8h8')
  })

  it('keeps Min beside Fit before Wrap and explains the text actions accurately', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = `<div id="workspace">${await container.renderToString(CanvasTextToolbar)}</div>`
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const font = workspace.querySelector<HTMLElement>('.freeform-font-menu summary')!
    const fit = workspace.querySelector<HTMLButtonElement>('[data-element-toggle="fitToWidth"]')!
    const wrap = workspace.querySelector<HTMLButtonElement>('[data-element-toggle="wrap"]')!
    const min = workspace.querySelector<HTMLElement>('#freeform-fit-settings')!
    const pair = workspace.querySelector<HTMLElement>('.freeform-fit-pair')!
    expect(pair.children[0]).toBe(min)
    expect(pair.children[1]).toBe(fit)
    expect(pair.nextElementSibling).toBe(wrap)

    const unbind = bindDesignerTooltips(workspace)
    vi.useFakeTimers()
    font.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    vi.advanceTimersByTime(300)
    expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.hidden).toBe(true)
    expect(font.closest('details')?.previousElementSibling?.textContent).toBe('Font')
    fit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    vi.advanceTimersByTime(300)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Shrink all text in this element to fit its box.')
    expect(fit.getAttribute('aria-label')).toBe('Scale font to fit')
    wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    vi.advanceTimersByTime(300)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Wrap this text element within its width; Wrap alone doesn't shrink the font. With Scale font to fit, use at most two lines.")
    unbind()
    vi.useRealTimers()
  })

  it('keeps familiar and visibly labeled controls tooltip-free', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = `<div id="workspace">${await container.renderToString(CanvasTextToolbar)}</div>`
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const unbind = bindDesignerTooltips(workspace)
    vi.useFakeTimers()
    const controls = ['bold', 'italic', 'underline'].map(modifier => workspace.querySelector<HTMLElement>(`[data-text-modifier="${modifier}"]`)!)
    controls.push(workspace.querySelector<HTMLElement>('#freeform-image-crop')!)
    for (const control of controls) {
      control.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(300)
      expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.hidden).toBe(true)
      expect(control.hasAttribute('title')).toBe(false)
    }
    unbind()
    vi.useRealTimers()
  })

  it('does not repeat the visible Element JSON label in a tooltip', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = `<div id="workspace">${await container.renderToString(ElementInspector)}</div>`
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const trigger = document.querySelector<HTMLElement>('#freeform-json-expand')!
    const unbind = bindDesignerTooltips(workspace)

    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.hidden).toBe(true)
    unbind()
  })

  it('does not repeat token-selector tab labels in tooltips', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = `<div id="workspace">${await container.renderToString(FieldDock)}</div>`
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const unbind = bindDesignerTooltips(workspace)
    vi.useFakeTimers()
    for (const tab of workspace.querySelectorAll<HTMLElement>('[data-field-group-tab]')) {
      tab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(300)
      expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.hidden).toBe(true)
    }
    unbind()
  })

  it('does not repeat visible Add Element or shape-choice labels in tooltips', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(DesignerWorkspace)
    const workspace = document.querySelector<HTMLElement>('#freeform-designer-workspace')!
    const controls = workspace.querySelectorAll<HTMLElement>('[data-designer-add], [data-shape-menu-trigger], [data-designer-shape]')
    const unbind = bindDesignerTooltips(workspace)
    vi.useFakeTimers()

    expect(controls).toHaveLength(10)
    for (const control of controls) {
      control.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(300)
      expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.hidden).toBe(true)
      expect(control.hasAttribute('title')).toBe(false)
    }
    unbind()
    vi.useRealTimers()
  })

  it('explains font weight and size when their labels are hovered', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = `<div id="workspace">${await container.renderToString(CanvasTextToolbar)}</div>`
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const weight = document.querySelector<HTMLElement>('[data-element-prop="fontWeight"]')!.closest('label')!
    const size = document.querySelector<HTMLElement>('[data-element-prop="fontSizeMm"]')!.closest('label')!
    const unbind = bindDesignerTooltips(workspace)
    vi.useFakeTimers()

    weight.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    vi.advanceTimersByTime(300)
    expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.textContent).toContain('whole text element')
    size.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    vi.advanceTimersByTime(300)
    expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.textContent).toContain('millimeters')
    unbind()
    vi.useRealTimers()
  })
})
