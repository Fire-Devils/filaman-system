// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { findHelpSlot, placeHandbookButton } from './handbook-button'
import { findOpenHandbookKey } from './handbook'
import { setLang } from './i18n'

const proto = '<a id="fm-handbook-proto" href="https://docu.filaman.app" hidden class="fm-btn fm-btn-outline"></a>'

function page(main: string, path = '/spools') {
  history.replaceState({}, '', path)
  document.body.innerHTML = `${proto}<main>${main}</main>`
}

describe('placeHandbookButton', () => {
  beforeEach(() => { document.body.innerHTML = ''; setLang('de') })

  it('appends to the explicit data-help-slot as last child', () => {
    page('<div class="fm-list-toolbar"><h1>Spools</h1><div class="fm-list-controls" data-help-slot><button id="a"></button></div></div>')
    const link = placeHandbookButton()!
    const slot = document.querySelector('[data-help-slot]')!
    expect(slot.lastElementChild).toBe(link)
    expect(link.hidden).toBe(false)
    expect(link.id).toBe('')
    expect(link.getAttribute('href')).toContain('/Docs/')
  })

  it('uses the toolbar itself without controls, and the h1 row as fallback', () => {
    page('<div class="fm-list-toolbar"><h1>Log</h1></div>')
    expect(findHelpSlot(document.querySelector('main')!)?.parent.className).toBe('fm-list-toolbar')
    page('<div><h1>Plain</h1></div>')
    const slot = findHelpSlot(document.querySelector('main')!)!
    expect(slot.row).toBe(true)
    expect(slot.parent.tagName).toBe('DIV')
    page('<p>no heading</p>')
    expect(placeHandbookButton()).toBeNull()
  })

  it('does not duplicate and refreshes the href on click with an open dialog', () => {
    page('<div class="detail-page-toolbar"><a>back</a></div><dialog open data-handbook="spoolRfid"></dialog>', '/spools/9')
    placeHandbookButton()
    const link = placeHandbookButton()!
    expect(document.querySelectorAll('.fm-help-btn').length).toBe(1)
    link.dispatchEvent(new Event('pointerdown'))
    expect(link.href).toBe('https://docu.filaman.app/Docs/De/07-Spulen#rfid-tags-einer-spule')
  })

  it('finds the innermost open data-handbook element', () => {
    document.body.innerHTML = `
      <section data-handbook="spoolBulk" id="outer"><div><div data-handbook="spoolRfid" id="inner"></div></div></section>
      <div data-handbook="spoolFromEmpty" id="closed"></div>`
    expect(findOpenHandbookKey(document, el => el.id !== 'closed')).toBe('spoolRfid')
    expect(findOpenHandbookKey(document, el => el.id === 'outer')).toBe('spoolBulk')
    expect(findOpenHandbookKey(document, () => false)).toBeNull()
  })
})
