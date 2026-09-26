// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transpileModule } from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(resolve('src/pages/admin/backup.astro'), 'utf8')

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('backup page formats', () => {
  it('accepts legacy JSON and streaming JSONL backups', () => {
    for (const id of ['backup-file-input', 'inventory-file-input']) {
      const input = source.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`, 's'))?.[0]
      expect(input).toContain('accept=".json,.jsonl,application/json,application/x-ndjson"')
    }
  })

  it.each([
    ['btn-export-backup', 'export'],
    ['btn-export-inventory', 'export-inventory'],
  ])('requests the compatible streaming format from %s', async (buttonId, endpoint) => {
    document.body.innerHTML = source.slice(source.indexOf('<Layout'), source.indexOf('<script>'))
    const script = source.match(/<script>([\s\S]*?)<\/script>/)![1].replace(/^\s*import .*$/gm, '')
    const fetch = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'))
    vi.stubGlobal('fetch', fetch)
    new Function('initI18n', 't', 'getAbortSignal', 'isAbortError', transpileModule(script, {}).outputText)(
      () => {}, () => '', () => undefined, () => true,
    )

    document.getElementById(buttonId)!.click()
    await Promise.resolve()

    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/admin/system/backup/${endpoint}?format=auto`,
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
