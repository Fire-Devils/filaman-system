import { afterEach, expect, it, vi } from 'vitest'

import { createDefaultLabelDesign } from './defaults'
import { createFreeformEditorController } from './editor-state'
import { migrateV1PresetData } from './migrate-v1'
import { normalizeLabelDesign } from './normalize'

afterEach(() => vi.unstubAllGlobals())

it('creates, migrates, repairs, and edits labels on HTTP without randomUUID', () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })

  const initial = createDefaultLabelDesign('spool')
  const migrated = migrateV1PresetData({ settings: { label: { width: 72 } } }, 'spool').design
  const repaired = normalizeLabelDesign({ ...initial, elements: [
    { ...initial.elements[0], id: '' },
    { ...initial.elements[0], id: '' },
  ] })
  const editor = createFreeformEditorController({ initialDesign: initial })
  const added = editor.addElement('text')
  const duplicated = editor.duplicateSelected()!

  const ids = [...initial.elements, ...migrated.elements, ...repaired.elements, added, duplicated]
    .map(element => element.id)
  expect(ids.every(id => id.length > 0 && id.length <= 120)).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
  expect(editor.getDesign().elements).toHaveLength(initial.elements.length + 2)
})
