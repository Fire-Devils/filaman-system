import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import de from '../i18n/de.json'
import en from '../i18n/en.json'

function resolveCatalogValue(catalog: object, key: string): unknown {
  return key.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[segment]
  }, catalog)
}

describe('live page translation consumers', () => {
  it.each([
    ['en', en],
    ['de', de],
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
})
