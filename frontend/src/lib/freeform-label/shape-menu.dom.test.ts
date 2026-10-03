// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import DesignerWorkspace from '../../components/freeform-label/DesignerWorkspace.astro'

let destroy: (() => void) | undefined

async function renderMenu() {
  const container = await AstroContainer.create()
  document.body.innerHTML = await container.renderToString(DesignerWorkspace)
  const trigger = document.querySelector<HTMLButtonElement>('[data-shape-menu-trigger]')
  expect(trigger, 'Shape opens a choice menu instead of inserting immediately').not.toBeNull()
  const menu = document.querySelector<HTMLElement>('[data-shape-menu]')!
  const { bindShapeMenu } = await import('./shape-menu')
  destroy = bindShapeMenu(document).destroy
  return { trigger: trigger!, menu, choices: [...menu.querySelectorAll<HTMLButtonElement>('[data-designer-shape]')] }
}

afterEach(() => { destroy?.(); destroy = undefined; document.body.innerHTML = '' })

describe('designer shape menu', () => {
  it('opens named shape choices and closes when a shape is chosen', async () => {
    const { trigger, menu, choices } = await renderMenu()
    expect(menu.hidden).toBe(true)
    trigger.click()
    expect(menu.hidden).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(choices.map(choice => choice.dataset.designerShape)).toEqual(['circle', 'square', 'rectangle', 'line'])
    expect(choices.every(choice => choice.textContent?.trim() && choice.querySelector('svg'))).toBe(true)
    choices[0].click()
    expect(menu.hidden).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('supports keyboard navigation and Escape returns focus to Shape', async () => {
    const { trigger, menu, choices } = await renderMenu()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(choices[0])
    choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(choices[3])
    choices[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(document.activeElement).toBe(choices[0])
    choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menu.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses on outside clicks without stealing focus and removes handlers when destroyed', async () => {
    const { trigger, menu } = await renderMenu()
    const outside = document.createElement('button')
    document.body.append(outside)
    trigger.click()
    outside.focus()
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(menu.hidden).toBe(true)
    expect(document.activeElement).toBe(outside)
    destroy?.()
    trigger.click()
    expect(menu.hidden).toBe(true)
  })
})
