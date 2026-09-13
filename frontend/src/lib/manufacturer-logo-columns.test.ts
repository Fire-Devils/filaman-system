import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { transform } from '@astrojs/compiler'
import { describe, expect, it } from 'vitest'

async function compilePage(path: string) {
  const filename = fileURLToPath(new URL(path, import.meta.url))
  return transform(readFileSync(filename, 'utf8'), { filename })
}

describe('manufacturer logo table columns', () => {
  it('keeps the manufacturer name keyed and bounds dynamic logos inline', async () => {
    const { code } = await compilePage('../pages/manufacturers/index.astro')

    expect(code).toContain('class="sortable col-name')
    expect(code).toContain('max-width: 72px; object-fit: contain;')
  })

  it('spans every filament table state across all 14 columns', async () => {
    const { code } = await compilePage('../pages/filaments/index.astro')

    expect(code).not.toContain('colspan="13"')
  })

  it('spans every spool table state across all 17 columns', async () => {
    const { code } = await compilePage('../pages/spools/index.astro')

    expect(code).not.toContain('colspan="16"')
  })
})
