import { describe, expect, it } from 'vitest'
import { progressBarHtml } from './progress-bar'

describe('progressBarHtml', () => {
  it('computes percent and aria values', () => {
    const h = progressBarHtml(1, 4, 'x <b>')
    expect(h).toContain('width:25%')
    expect(h).toContain('aria-valuenow="1"')
    expect(h).toContain('aria-valuemax="4"')
    expect(h).toContain('role="status">x &lt;b&gt;')
  })
  it('clamps to 0..100', () => {
    expect(progressBarHtml(9, 4, 'a')).toContain('width:100%')
    expect(progressBarHtml(-3, 4, 'a')).toContain('width:0%')
  })
  it('is indeterminate when total is 0', () => {
    const h = progressBarHtml(0, 0, 'a')
    expect(h).toContain('fm-progress-indeterminate')
    expect(h).not.toContain('width:')
  })
})
