// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { progressBarHtml, updateProgressBar } from './progress-bar'

describe('updateProgressBar', () => {
  it('updates the existing bar in place so the width can animate', () => {
    const box = document.createElement('div')
    box.innerHTML = progressBarHtml(1, 4, '1 von 4')
    const fill = box.querySelector<HTMLElement>('.fm-progress-fill')!
    expect(updateProgressBar(box, 3, 4, '3 von 4')).toBe(true)
    expect(box.querySelector('.fm-progress-fill')).toBe(fill)
    expect(fill.style.width).toBe('75%')
    expect(box.querySelector('[role="status"]')!.textContent).toBe('3 von 4')
    expect(box.querySelector('.fm-progress-pct')!.textContent).toBe('75 %')
    expect(box.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('3')
  })
  it('asks for a fresh render when there is no bar or the kind changes', () => {
    const box = document.createElement('div')
    expect(updateProgressBar(box, 1, 4, 'x')).toBe(false)
    box.innerHTML = progressBarHtml(0, 0, 'läuft')
    expect(updateProgressBar(box, 1, 4, 'x')).toBe(false)
    expect(updateProgressBar(box, 0, 0, 'läuft noch')).toBe(true)
  })
})
