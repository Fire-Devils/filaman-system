import { describe, expect, it } from 'vitest'

import changelog from '../changelog.json'

describe('current release changelog', () => {
  it('documents the streaming JSONL backup change in English and German', () => {
    const current = changelog.versions.find(version => version.version === '1.3.7')!

    expect(current.changes.en.some(change => /JSONL/i.test(change.text))).toBe(true)
    expect(current.changes.de.some(change => /JSONL/i.test(change.text))).toBe(true)
  })
})
