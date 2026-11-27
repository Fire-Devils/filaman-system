import { describe, expect, it } from 'vitest'

import { blockerLinks, renderPreviewBody, type ContribPreview } from './filamentdb-contrib'

const blocker = { code: 'printer_model_missing', message: 'x', profile_id: 4, filament_id: 7, printer_id: 3 }

function preview(blockers: ContribPreview['blockers']): ContribPreview {
  return { type: 'print_profile', local_id: 4, mode: 'create', payload: {}, matches: [], blockers, dependencies: [] }
}

describe('printer_model_missing blocker links', () => {
  it('links to the profile section and to the linked printer', () => {
    expect(blockerLinks(blocker).map(l => l.href)).toEqual(['/filaments/7#print-profiles', '/printers?edit=3'])
  })

  it('links only to the printer for a printer-model contribution', () => {
    expect(blockerLinks({ code: 'printer_model_missing', message: 'x', printer_id: 3 }).map(l => l.href)).toEqual(['/printers?edit=3'])
  })

  it('has no links for other blockers or without ids', () => {
    expect(blockerLinks({ code: 'nozzle_required', message: 'x', profile_id: 4, filament_id: 7 })).toEqual([])
    expect(blockerLinks({ code: 'printer_model_missing', message: 'x' })).toEqual([])
  })

  it('renders the links next to the blocker text', () => {
    const html = renderPreviewBody(preview([blocker]))
    expect(html).toContain('href="/filaments/7#print-profiles"')
    expect(html).toContain('href="/printers?edit=3"')
  })
})
