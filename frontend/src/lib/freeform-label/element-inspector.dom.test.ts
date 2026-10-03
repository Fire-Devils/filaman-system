// @vitest-environment happy-dom

import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it } from 'vitest'

import CanvasTextToolbar from '../../components/freeform-label/CanvasTextToolbar.astro'
import ElementInspector from '../../components/freeform-label/ElementInspector.astro'

describe('element JSON editor', () => {
  it('labels the pencil trigger and manual editor distinctly', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(ElementInspector)
    const header = document.querySelector<HTMLElement>('.freeform-inspector-heading')!
    const heading = document.querySelector<HTMLElement>('#freeform-geometry-heading')!
    const trigger = document.querySelector<HTMLButtonElement>('#freeform-json-expand')!
    const title = document.querySelector<HTMLElement>('#freeform-json-title')!

    expect([...header.children]).toEqual([heading, trigger])
    expect(header.nextElementSibling).toBe(document.querySelector('.freeform-geometry-grid'))
    expect(trigger.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(trigger.textContent?.trim()).toBe('JSON')
    expect(trigger.getAttribute('aria-label')).toBe('Element JSON')
    expect(title.textContent?.trim()).toBe('ELEMENT JSON MANUAL EDITOR')
  })
})

describe('QR center logo picker', () => {
  it('pairs each keyboard-accessible choice with a labeled visual preview', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(CanvasTextToolbar)
    const picker = document.querySelector('[data-element-section="qr"]')!
    const choices = [...picker.querySelectorAll<HTMLInputElement>('input[type="radio"]')]

    expect(choices.map(choice => [choice.name, choice.value, choice.labels?.[0]?.querySelector('[data-i18n]')?.textContent?.trim()])).toEqual([
      ['freeform-qr-center', 'colorLogo', 'Color'],
      ['freeform-qr-center', 'logo', 'Text'],
      ['freeform-qr-center', 'simple', 'None'],
    ])
    for (const choice of choices) {
      expect(choice.disabled).toBe(false)
      expect(choice.tabIndex).toBe(0)
      expect(choice.dataset.elementProp).toBe('mode')
      expect(choice.labels?.[0]?.querySelector('[aria-hidden="true"]')).not.toBeNull()
    }
    expect(choices[0].labels?.[0]?.querySelector('img')?.getAttribute('src')).toBe('/logo-qr.png')
    expect(choices[1].labels?.[0]?.querySelector('svg text')?.textContent).toBe('FilaMan')
    expect(choices[2].labels?.[0]?.querySelector('svg')).not.toBeNull()
    expect(choices[2].labels?.[0]?.querySelector('svg text')).toBeNull()
  })
})

describe('text fit controls', () => {
  it('keeps minimum size in the font row without adding a row above the label', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(CanvasTextToolbar)
    const row = document.querySelector('.freeform-font-details')!
    const disclosure = document.querySelector<HTMLDetailsElement>('#freeform-fit-settings')!

    expect(disclosure.tagName).toBe('DETAILS')
    expect(disclosure.parentElement?.classList.contains('freeform-fit-pair')).toBe(true)
    expect(disclosure.parentElement?.parentElement).toBe(row)
    expect(disclosure.querySelector('summary')?.textContent?.trim()).toBe('Min')
    expect(disclosure.querySelector('[data-element-prop="minFontSizeMm"]')).not.toBeNull()
    expect(document.querySelector('#freeform-wrap-limit-hint')).toBeNull()
  })
})

describe('image library actions', () => {
  it('exposes upload as a keyboard-accessible button beside the hidden file picker', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(CanvasTextToolbar)
    const upload = document.querySelector<HTMLButtonElement>('#freeform-image-upload-trigger')
    const filePicker = document.querySelector<HTMLInputElement>('#freeform-image-upload')

    expect(upload).toBeInstanceOf(HTMLButtonElement)
    expect(upload?.type).toBe('button')
    expect(upload?.tabIndex).toBe(0)
    expect(upload?.textContent?.trim()).toBe('Upload image')
    expect(upload?.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(filePicker?.hidden).toBe(true)
    expect(filePicker?.accept).toBe('image/png,image/jpeg,image/webp')
  })

  it('associates the library deletion control with an explanation separate from element deletion', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(CanvasTextToolbar)
    const deletion = document.querySelector<HTMLButtonElement>('#freeform-image-delete')!
    const description = document.getElementById(deletion.getAttribute('aria-describedby') ?? '')

    expect(deletion.textContent?.trim()).toBe('Delete from library')
    expect(deletion.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(description?.textContent).toContain('saved presets')
    expect(description?.textContent).toContain('Delete in the top toolbar')
    expect(deletion.title).toBe(description?.textContent?.trim())
  })
})
