// @vitest-environment happy-dom

import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterEach, describe, expect, it } from 'vitest'

import CanvasTextToolbar from '../../components/freeform-label/CanvasTextToolbar.astro'
import { createDefaultLabelDesign } from './defaults'
import { bindFreeformEditorDom } from './editor-dom'
import { createFreeformEditorController } from './editor-state'

let binding: ReturnType<typeof bindFreeformEditorDom> | undefined

afterEach(() => {
  binding?.destroy()
  binding = undefined
  document.body.innerHTML = ''
})

async function bindPicker() {
  const container = await AstroContainer.create()
  document.body.innerHTML = await container.renderToString(CanvasTextToolbar)
  const controller = createFreeformEditorController({ initialDesign: createDefaultLabelDesign('spool') })
  binding = bindFreeformEditorDom({ controller })
  await binding.ready
  const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-element-section="text"] [data-element-align]')]
  const vertical = [...document.querySelectorAll<HTMLButtonElement>('[data-element-vertical-align]')]
  return { controller, binding, actions, vertical }
}

describe('text alignment picker', () => {
  it('offers three named icon actions with localized tooltips and selection state', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(CanvasTextToolbar)
    const picker = document.querySelector('[role="group"][aria-label="Alignment"]')
    const actions = [...(picker?.querySelectorAll<HTMLButtonElement>('button') ?? [])]

    expect(actions.map(action => [action.dataset.elementAlign, action.getAttribute('aria-label'), action.title])).toEqual([
      ['left', 'Left', 'Left'],
      ['center', 'Center', 'Center'],
      ['right', 'Right', 'Right'],
    ])
    for (const action of actions) {
      expect(action.type).toBe('button')
      expect(action.getAttribute('aria-pressed')).toBe('false')
      expect(action.disabled).toBe(true)
      expect(action.querySelector('svg[aria-hidden="true"] path')).not.toBeNull()
      expect(action.dataset.i18nAriaLabel).toMatch(/^labelDesigner\.align(Left|Center|Right)$/)
      expect(action.dataset.i18nTitle).toBe(action.dataset.i18nAriaLabel)
    }
    expect(picker?.getAttribute('data-i18n-aria-label')).toBe('labelDesigner.alignment')
  })

  it('updates horizontal alignment and pressed state together and restores them on undo', async () => {
    const { controller, binding, actions } = await bindPicker()
    expect(actions.map(action => action.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    for (const [index, align] of [[1, 'center'], [2, 'right'], [0, 'left']] as const) {
      actions[index].click()
      expect(controller.getSelectedElement()).toMatchObject({ align })
      expect(actions.map(action => action.getAttribute('aria-pressed'))).toEqual(
        index === 0 ? ['true', 'false', 'false'] : index === 1 ? ['false', 'true', 'false'] : ['false', 'false', 'true'],
      )
    }
    controller.undo()
    binding.sync()
    expect(controller.getSelectedElement()).toMatchObject({ align: 'right' })
    expect(actions.map(action => action.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })

  it('centers manufacturer logos by default and exposes horizontal alignment', async () => {
    const { controller, binding } = await bindPicker()
    const logo = controller.getDesign().elements.find(element => element.type === 'manufacturerLogo')!
    controller.select(logo.id)
    binding.sync()
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-element-section="manufacturerLogo"] [data-element-align]')]

    expect(actions.map(action => action.disabled)).toEqual([false, false, false])
    expect(actions.map(action => action.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    actions[2].click()
    expect(controller.getSelectedElement()).toMatchObject({ type: 'manufacturerLogo', align: 'right' })
    expect(actions.map(action => action.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })

  it('uses object-alignment glyphs for manufacturer logos', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(CanvasTextToolbar)
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-element-section="manufacturerLogo"] [data-element-align]')]

    expect(actions.map(action => action.querySelector('path')?.getAttribute('d'))).toEqual([
      'M4 4v16',
      'M12 3v5m0 8v5',
      'M20 4v16',
    ])
    expect(actions.every(action => action.querySelector('rect[fill="currentColor"]'))).toBe(true)
  })

  it('disables text layout actions and rejects dispatched changes in read-only and nontext selections', async () => {
    const { controller, binding, actions, vertical } = await bindPicker()
    const wrap = document.querySelector<HTMLButtonElement>('[data-element-toggle="wrap"]')!
    expect(wrap).not.toBeNull()
    const original = controller.getDesign()
    await binding.setEditable(false)
    for (const action of [...actions, ...vertical]) {
      expect(action.disabled).toBe(true)
      action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    expect(wrap.disabled).toBe(true)
    wrap.click()
    expect(controller.getDesign()).toEqual(original)
    await binding.setEditable(true)
    controller.select(original.elements.find(element => element.type === 'qr')!.id)
    binding.sync()
    for (const action of [...actions, ...vertical]) {
      expect(action.disabled).toBe(true)
      expect(action.getAttribute('aria-pressed')).toBe('false')
      action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    wrap.click()
    expect(controller.getDesign()).toEqual(original)
  })

  it('exposes and applies vertical placement with top as the legacy default and undo synchronization', async () => {
    const { controller, binding, vertical } = await bindPicker()
    expect(vertical.map(action => [action.dataset.elementVerticalAlign, action.getAttribute('aria-label'), action.title])).toEqual([
      ['top', 'Top', 'Top'], ['middle', 'Middle', 'Middle'], ['bottom', 'Bottom', 'Bottom'],
    ])
    expect(vertical.map(action => action.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    for (const [index, verticalAlign] of [[1, 'middle'], [2, 'bottom'], [0, 'top']] as const) {
      vertical[index].click()
      expect(controller.getSelectedElement()).toMatchObject({ verticalAlign })
      expect(vertical.map(action => action.getAttribute('aria-pressed'))).toEqual(
        index === 0 ? ['true', 'false', 'false'] : index === 1 ? ['false', 'true', 'false'] : ['false', 'false', 'true'],
      )
      expect(vertical[index].dataset.i18nAriaLabel).toBe(vertical[index].dataset.i18nTitle)
    }
    controller.undo()
    binding.sync()
    expect(controller.getSelectedElement()).toMatchObject({ verticalAlign: 'bottom' })
    expect(vertical.map(action => action.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })

  it('toggles scale to fit, restores it on undo, and clears it for text without the option', async () => {
    const { controller, binding } = await bindPicker()
    const scale = document.querySelector<HTMLButtonElement>('button[data-element-toggle="fitToWidth"]')
    expect(scale).not.toBeNull()
    expect(scale!.getAttribute('aria-pressed')).toBe('false')
    scale!.click()
    expect(controller.getSelectedElement()).toMatchObject({ fitToWidth: true, minFontSizeMm: 2 })
    controller.undo()
    binding.sync()
    expect(scale!.getAttribute('aria-pressed')).toBe('false')
    controller.redo()
    binding.sync()
    expect(scale!.getAttribute('aria-pressed')).toBe('true')
    const minimum = document.querySelector<HTMLInputElement>('[data-element-prop="minFontSizeMm"]')!
    expect(minimum.value).toBe('2')
    minimum.value = '1.5'
    minimum.dispatchEvent(new Event('change', { bubbles: true }))
    expect(controller.getSelectedElement()).toMatchObject({ minFontSizeMm: 1.5 })
    scale!.click()
    scale!.click()
    expect(controller.getSelectedElement()).toMatchObject({ fitToWidth: true, minFontSizeMm: 1.5 })
    controller.addElement('text')
    binding.sync()
    expect(scale!.getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps word wrapping and scaling independent and restores both on undo', async () => {
    const { controller, binding } = await bindPicker()
    const wrap = document.querySelector<HTMLButtonElement>('button[data-element-toggle="wrap"]')
    expect(wrap).not.toBeNull()
    expect(wrap?.getAttribute('aria-pressed')).toBe('true')
    wrap!.click()
    expect(controller.getSelectedElement()).toMatchObject({ wrap: false })
    controller.updateSelected({ fitToWidth: true })
    binding.sync()
    wrap!.click()
    expect(controller.getSelectedElement()).toMatchObject({ wrap: true, fitToWidth: true })
    controller.undo()
    binding.sync()
    expect(wrap?.getAttribute('aria-pressed')).toBe('false')
    expect(controller.getSelectedElement()).toMatchObject({ wrap: false, fitToWidth: true })
  })
})
