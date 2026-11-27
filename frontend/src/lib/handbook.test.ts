import { describe, expect, it } from 'vitest'
import {
  HANDBOOK_BASE,
  getHandbookUrl,
  handbookLang,
  handbookTargets,
  pickHandbookKey,
  routeToKey,
} from './handbook'

const base = HANDBOOK_BASE

describe('handbookLang', () => {
  it('maps de to German and everything else to English', () => {
    expect(handbookLang('de')).toBe('de')
    expect(handbookLang('de-AT')).toBe('de')
    expect(handbookLang('en')).toBe('en')
    expect(handbookLang('fr')).toBe('en')
    expect(handbookLang(null)).toBe('en')
  })
})

describe('getHandbookUrl routes', () => {
  it.each([
    ['/spools', 'de', `${base}/Docs/De/07-Spulen`],
    ['/spools', 'en', `${base}/Docs/En/07-Spools`],
    ['/spools/new', 'de', `${base}/Docs/De/07-Spulen#spule-hinzufugen`],
    ['/spools/new', 'fr', `${base}/Docs/En/07-Spools#add-a-spool`],
    ['/spools/42', 'de', `${base}/Docs/De/07-Spulen#spule-bearbeiten`],
    ['/spools/42/print', 'en', `${base}/Docs/En/25-Label-Designer#251-opening-label-printing`],
    ['/filaments/7', 'en', `${base}/Docs/En/06-Filaments#features`],
    ['/filaments/colors', 'de', `${base}/Docs/De/12-Farbverwaltung`],
    ['/admin/roles', 'de', `${base}/Docs/De/11-Admin#112-rollen-berechtigungen-roles-permissions`],
    ['/admin/system/spoolman-import', 'en', `${base}/Docs/En/11-Admin#1110-spoolman-import`],
    ['/settings/', 'en', `${base}/Docs/En/10-Settings`],
    ['/print-jobs/3', 'de', `${base}/Docs/De/22-Druckjobs#detailseite-eines-drucks`],
    ['/analytics', 'en', `${base}/Docs/En/23-Analytics`],
    ['/printers/5', 'en', `${base}/Docs/En/09-Printers#printer-settings-and-slicer-profiles`],
    ['/display', 'de', `${base}/Docs/De/26-Ams-Ansicht`],
    ['/', 'en', `${base}/Docs/En/04-Dashboard`],
  ])('%s (%s)', (pathname, lang, url) => {
    expect(getHandbookUrl({ pathname, lang })).toBe(url)
  })

  it('falls back to the table of contents for unknown routes', () => {
    expect(getHandbookUrl({ pathname: '/gibt-es-nicht', lang: 'de' })).toBe(`${base}/Docs/De/00-Inhalt`)
    expect(getHandbookUrl({ pathname: '/plugin-view/x/y', lang: 'en' })).toBe(`${base}/Docs/En/00-Contents`)
  })

  it('every route target exists for both languages', () => {
    for (const target of Object.values(handbookTargets)) {
      expect(target.de).toMatch(/^\d\d-[\w-]+(#[\w-]+)?$/)
      expect(target.en).toMatch(/^\d\d-[\w-]+(#[\w-]+)?$/)
    }
    expect(routeToKey('/spools/new')).toBe('spoolAdd')
  })
})

describe('dialog precedence', () => {
  it('prefers a known dialog key over the route', () => {
    expect(getHandbookUrl({ pathname: '/spools', lang: 'de', dialogKey: 'spoolRfid' }))
      .toBe(`${base}/Docs/De/07-Spulen#rfid-tags-einer-spule`)
  })

  it('ignores unknown dialog keys', () => {
    expect(getHandbookUrl({ pathname: '/spools', lang: 'en', dialogKey: 'nope' })).toBe(`${base}/Docs/En/07-Spools`)
    expect(getHandbookUrl({ pathname: '/spools', lang: 'en', dialogKey: null })).toBe(`${base}/Docs/En/07-Spools`)
  })

  it('picks the innermost open candidate and skips closed ones', () => {
    expect(pickHandbookKey([
      { key: 'spoolBulk', depth: 3, open: true },
      { key: 'spoolRfid', depth: 5, open: true },
      { key: 'spoolFromEmpty', depth: 7, open: false },
    ])).toBe('spoolRfid')
    expect(pickHandbookKey([{ key: 'spoolRfid', depth: 2, open: false }])).toBeNull()
    expect(pickHandbookKey([{ key: 'bogus', depth: 2, open: true }])).toBeNull()
  })
})
