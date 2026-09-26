import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import de from '../i18n/de.json'
import en from '../i18n/en.json'
// French (fr) locale — contributed by Nanostra (Frédéric Dubus)
import fr from '../i18n/fr.json'

function resolveCatalogValue(catalog: object, key: string): unknown {
  return key.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[segment]
  }, catalog)
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${prefix}:non-string`]
  return Object.entries(value).flatMap(([key, child]) => (
    leafPaths(child, prefix ? `${prefix}.${key}` : key)
  ))
}

describe('live page translation consumers', () => {
  it.each([
    ['en', en],
    ['de', de],
    // French (fr) locale — contributed by Nanostra (Frédéric Dubus)
    ['fr', fr],
  ] as const)('provides every static plugin-page key in %s', (_locale, catalog) => {
    const source = readFileSync(
      fileURLToPath(new URL('../pages/plugin-view.astro', import.meta.url)),
      'utf8',
    )
    const keys = Array.from(
      source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g),
      match => match[1],
    )

    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(resolveCatalogValue(catalog, key), `missing live key ${key}`)
        .toEqual(expect.any(String))
    }
  })

  it('keeps every label designer translation leaf in English/German parity', () => {
    expect(leafPaths(en.labelDesigner).sort()).toEqual(leafPaths(de.labelDesigner).sort())
    expect(leafPaths(en.labelDesigner)).not.toContain(expect.stringContaining(':non-string'))
    expect(leafPaths(en.labelDesigner).length).toBeGreaterThan(60)

    for (const key of ['load', 'apply', 'revert']) {
      expect(resolveCatalogValue(en, `common.${key}`)).toEqual(expect.any(String))
      expect(resolveCatalogValue(de, `common.${key}`)).toEqual(expect.any(String))
    }
    for (const key of [
      'labelSheets', 'sheetSource', 'designedLabel', 'editDesignedLabel',
      'workspaceTabs', 'designedLabelPreset', 'paperLayout', 'paperGeometryGuide',
    ]) {
      expect(resolveCatalogValue(en, `labelPrint.${key}`)).toEqual(expect.any(String))
      expect(resolveCatalogValue(de, `labelPrint.${key}`)).toEqual(expect.any(String))
    }
  })

  it.each([
    ['en', en],
    ['de', de],
    ['fr', fr],
  ] as const)('resolves every static freeform and sheet translation consumer in %s', (_locale, catalog) => {
    const sources = [
      '../components/freeform-label/DesignerWorkspace.astro',
      '../components/freeform-label/ElementInspector.astro',
      '../components/freeform-label/FieldDock.astro',
      '../components/freeform-label/DesignerSidebar.astro',
      '../components/PrintSidebar.astro',
      '../components/LabelSheetOutputSettings.astro',
    ].map(path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
    const keys = sources.flatMap(source => Array.from(
      source.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/g),
      match => match[1],
    ))

    expect(keys.length).toBeGreaterThan(50)
    for (const key of keys) {
      expect(resolveCatalogValue(catalog, key), `missing static key ${key}`)
        .toEqual(expect.any(String))
    }
  })
})

function flattenCatalog(catalog: object, prefix = ''): Map<string, unknown> {
  const entries = new Map<string, unknown>()
  for (const [segment, value] of Object.entries(catalog)) {
    const key = prefix ? `${prefix}.${segment}` : segment
    if (value && typeof value === 'object') {
      for (const [nestedKey, nestedValue] of flattenCatalog(value, key)) {
        entries.set(nestedKey, nestedValue)
      }
    } else {
      entries.set(key, value)
    }
  }
  return entries
}

function placeholders(text: string): string[] {
  return [...new Set(text.match(/\{[A-Za-z0-9_]+\}/g) ?? [])].sort()
}

describe('catalog parity with en', () => {
  // When a key is missing in a locale, there is no error: t() shows the
  // English text. This test is the check that finds it.
  const reference = flattenCatalog(en)
  const locales = [
    ['de', de],
    ['fr', fr],
  ] as const

  it.each(locales)('%s has exactly the keys of en', (_locale, catalog) => {
    const keys = flattenCatalog(catalog)
    expect([...reference.keys()].filter(key => !keys.has(key)), 'keys missing from the locale')
      .toEqual([])
    expect([...keys.keys()].filter(key => !reference.has(key)), 'keys that en does not have')
      .toEqual([])
  })

  it.each(locales)('%s keeps the placeholders of en and has no empty text', (_locale, catalog) => {
    for (const [key, value] of flattenCatalog(catalog)) {
      const source = reference.get(key)
      if (typeof source !== 'string') continue
      expect(value, `empty or non-text value for ${key}`).toEqual(expect.stringMatching(/\S/))
      expect(placeholders(value as string), `placeholders of ${key}`).toEqual(placeholders(source))
    }
  })
})
