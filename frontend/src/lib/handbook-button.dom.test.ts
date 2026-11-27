// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { addDialogHelpButton, findHelpSlot, placeDialogHelpButtons, placeHandbookButton } from './handbook-button'
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

describe('dialog help buttons', () => {
  beforeEach(() => { document.body.innerHTML = ''; setLang('de') })

  const formDialog = (attrs = '') => `<dialog ${attrs}><header class="fm-section-header fm-form-dialog-header"><h2>T</h2><div class="fm-header-actions"><button class="save">Save</button><button data-dialog-close>Cancel</button></div></header><div class="fm-section-body"></div></dialog>`

  it('adds one button to the header actions, not twice, with the dialog key', () => {
    page(formDialog('data-handbook="spoolRfid"'), '/spools')
    placeDialogHelpButtons()
    placeDialogHelpButtons()
    const buttons = document.querySelectorAll('dialog .fm-help-btn--dialog')
    expect(buttons.length).toBe(1)
    const link = buttons[0] as HTMLAnchorElement
    expect(link.hidden).toBe(false)
    expect(link.parentElement!.className).toBe('fm-header-actions')
    expect(link.nextElementSibling!.hasAttribute('data-dialog-close')).toBe(true)
    expect(link.href).toBe('https://docu.filaman.app/Docs/De/07-Spulen#rfid-tags-einer-spule')
  })

  it('falls back to the route key and follows the language', () => {
    page(formDialog(), '/locations')
    placeDialogHelpButtons()
    const link = document.querySelector('dialog .fm-help-btn--dialog') as HTMLAnchorElement
    expect(link.href).toBe('https://docu.filaman.app/Docs/De/08-Lagerorte')
    setLang('en')
    link.dispatchEvent(new Event('pointerdown'))
    expect(link.href).toBe('https://docu.filaman.app/Docs/En/08-Locations')
  })

  it('inserts left of a lone close button and honours data-help-slot', () => {
    page('<div class="fm-modal-overlay" data-handbook="spoolBulk"><div class="fm-card"><div data-help-slot><h3>T</h3><button id="close-x">×</button></div></div></div>')
    placeDialogHelpButtons()
    const link = document.querySelector('.fm-help-btn--dialog')!
    expect(link.nextElementSibling!.id).toBe('close-x')
    expect(link.parentElement!.hasAttribute('data-help-slot')).toBe(true)
  })

  it('adds nothing to dialogs without a head, confirm dialogs and skipped dialogs', () => {
    page('<dialog id="bare"><h2>Title</h2><p>Text</p></dialog><dialog id="fm-confirm-overlay"><div class="fm-section-header"><h3>x</h3></div></dialog>'
      + '<dialog data-help-skip><div class="fm-section-header"><h3>x</h3></div></dialog>')
    placeDialogHelpButtons()
    expect(document.querySelectorAll('.fm-help-btn').length).toBe(0)
  })

  it('does nothing without the prototype (embedded mode)', () => {
    history.replaceState({}, '', '/spools')
    document.body.innerHTML = `<main>${formDialog()}</main>`
    placeDialogHelpButtons()
    expect(document.querySelectorAll('.fm-help-btn').length).toBe(0)
  })

  it('keeps dialog buttons when the page button is placed again', () => {
    page(`<div class="fm-list-toolbar"><h1>X</h1></div>${formDialog()}`)
    placeDialogHelpButtons()
    placeHandbookButton()
    placeHandbookButton()
    expect(document.querySelectorAll('.fm-help-btn--dialog').length).toBe(1)
    expect(document.querySelectorAll('.fm-help-btn').length).toBe(2)
  })

  it('can add a button directly', () => {
    page(formDialog())
    const proto = document.querySelector<HTMLAnchorElement>('#fm-handbook-proto')!
    const dialog = document.querySelector('dialog')!
    expect(addDialogHelpButton(dialog, proto)).not.toBeNull()
    expect(addDialogHelpButton(dialog, proto)).toBeNull()
  })
})
