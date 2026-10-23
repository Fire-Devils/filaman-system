// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renderFilamentSpoolImage } from './filament-detail'

describe('filament packaging photo', () => {
  it('uses the authenticated catalog proxy and keeps the caption inside the photo figure', () => {
    document.body.innerHTML = renderFilamentSpoolImage('735.png', 'FilaManDB image')
    const figure = document.querySelector('figure')!
    expect(figure.querySelector('img')?.getAttribute('src')).toBe('/api/v1/filamentdb/spool-profile-image?image_file=735.png')
    expect(figure.querySelector('code')?.textContent).toBe('FilaManDB image')
    expect(figure.querySelector('a')?.getAttribute('rel')).toContain('noopener')
  })

  it.each([null, undefined, '', '../735.png', 'a/b.png', 'a\\b.png', '" onerror="x'])('omits unavailable or unsafe filenames: %s', filename => {
    expect(renderFilamentSpoolImage(filename, 'FilaManDB image')).toBe('')
  })
})
