// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  applyCardSizes, applyWidgetOrder, dropTarget, effectiveSpan, gridColumnCount, heightFromPixels, masonryColumnCount,
  normalizeWidgetSizes, rowSpan, spanFromWidth, widthFromSpan,
} from './dashboard-layout'
import { hasChartData, niceScale, renderChartSvg } from './dashboard-charts'

it('puts saved widgets first, drops unknown ids and appends new widgets in markup order', () => {
  expect(applyWidgetOrder(['a', 'b', 'c', 'd'], ['c', 'x', 'a', 'c'])).toEqual(['c', 'a', 'b', 'd'])
  expect(applyWidgetOrder(['a', 'b'], [])).toEqual(['a', 'b'])
})

it('picks masonry column counts by width', () => {
  expect([500, 620, 959, 960, 1400].map(masonryColumnCount)).toEqual([1, 2, 2, 3, 3])
})

it('normalizes saved sizes and drops malformed entries', () => {
  expect(normalizeWidgetSizes({
    a: { w: 2, h: 'm' }, b: { w: 'full', h: 'auto' }, c: { w: 4, h: 'auto' }, d: { w: 1, h: 'xl' }, e: 'full', f: null, g: { w: 1 },
  })).toEqual({ a: { w: 2, h: 'm' }, b: { w: 'full', h: 'auto' } })
  expect(normalizeWidgetSizes(null)).toEqual({})
  expect(normalizeWidgetSizes([1, 2])).toEqual({})
  expect(normalizeWidgetSizes('x')).toEqual({})
})

it('caps widths at the available columns and ignores them in a single column', () => {
  expect(effectiveSpan(2, 4)).toBe(2)
  expect(effectiveSpan(3, 2)).toBe(2)
  expect(effectiveSpan('full', 4)).toBe(4)
  expect(effectiveSpan('full', 2)).toBe(2)
  expect(effectiveSpan(3, 1)).toBe(1)
  expect(effectiveSpan('full', 1)).toBe(1)
  expect(effectiveSpan(undefined, 4, 2)).toBe(2)
  expect(effectiveSpan(undefined, 2, 2)).toBe(2)
  expect(effectiveSpan(undefined, 4)).toBe(1)
})

it('turns drag distances into widths and height steps', () => {
  // 3 columns of 300px with a 12px gap in a 924px container.
  expect([100, 320, 500, 640, 900].map(w => spanFromWidth(w, 924, 3, 12))).toEqual([1, 1, 2, 2, 3])
  expect(spanFromWidth(5000, 924, 3, 12)).toBe(3)
  expect(spanFromWidth(0, 0, 3, 12)).toBe(1)
  expect([1, 2, 3, 4].map(span => widthFromSpan(span, 4))).toEqual([1, 2, 3, 'full'])
  expect([1, 2, 3].map(span => widthFromSpan(span, 3))).toEqual([1, 2, 'full'])
  expect(widthFromSpan(2, 2)).toBe('full')
  expect([100, 179, 180, 299, 300, 439, 440, 900].map(heightFromPixels)).toEqual(['auto', 'auto', 's', 's', 'm', 'm', 'l', 'l'])
})

it('computes masonry row spans from height and margin', () => {
  expect(rowSpan(100, 16)).toBe(29)
  expect(rowSpan(101, 15)).toBe(29)
  expect(rowSpan(0, 0)).toBe(1)
  expect(rowSpan(40, 0, 8)).toBe(5)
})

it('reads the grid column count from the styles and from the width in masonry', () => {
  const container = document.createElement('div')
  container.style.setProperty('--dash-grid-cols', '2')
  document.body.append(container)
  expect(gridColumnCount(container, 'grid')).toBe(2)
  container.style.removeProperty('--dash-grid-cols')
  expect(gridColumnCount(container, 'grid')).toBe(1)
  container.remove()
})

it('sets column spans, heights and masonry row spans on the cards', () => {
  const container = document.createElement('div')
  const card = (id: string, height: number, wide = false) => {
    const el = document.createElement('section')
    el.dataset.widget = id
    if (wide) el.className = 'dashboard-wide'
    Object.defineProperty(el, 'offsetHeight', { value: height })
    return el
  }
  const [a, b, c] = [card('a', 100), card('b', 52, true), card('c', 10)]
  const placeholder = document.createElement('div')
  Object.defineProperty(placeholder, 'offsetHeight', { value: 20 })
  placeholder.style.gridColumn = 'span 2'
  const ctx = {
    layout: 'masonry' as const, columns: 3,
    sizeOf: (id: string) => (id === 'a' ? { w: 'full' as const, h: 'm' as const } : id === 'c' ? { w: 3 as const, h: 'auto' as const } : undefined),
    defaultSpan: (el: HTMLElement) => (el.classList.contains('dashboard-wide') ? 2 : 1),
  }
  applyCardSizes(container, [a, b, c, placeholder], ctx)
  expect(container.style.getPropertyValue('--dash-cols')).toBe('3')
  expect([a, b, c].map(el => el.style.gridColumn)).toEqual(['span 3', 'span 2', 'span 3'])
  expect([a, b, c].map(el => el.dataset.h)).toEqual(['m', 'auto', 'auto'])
  expect([a, b, c, placeholder].map(el => el.style.gridRow)).toEqual(['span 25', 'span 13', 'span 3', 'span 5'])
  expect(placeholder.style.gridColumn).toBe('span 2')

  // The plain grid has no row spans, and one column ignores every width.
  applyCardSizes(container, [a, b, c], { ...ctx, layout: 'grid', columns: 1 })
  expect([a, b, c].map(el => el.style.gridColumn)).toEqual(['span 1', 'span 1', 'span 1'])
  expect([a, b, c].map(el => el.style.gridRow)).toEqual(['', '', ''])
})

it('finds the drop target and the side to insert on', () => {
  const boxes = [{ left: 0, top: 0, width: 100, height: 90 }, { left: 110, top: 0, width: 100, height: 90 }]
  expect(dropTarget([], 5, 5)).toBeNull()
  expect(dropTarget(boxes, 50, 5)).toEqual({ index: 0, before: true })
  expect(dropTarget(boxes, 50, 85)).toEqual({ index: 0, before: false })
  expect(dropTarget(boxes, 180, 45)).toEqual({ index: 1, before: false })
  expect(dropTarget(boxes, 115, 45)).toEqual({ index: 1, before: true })
  // outside every box: nearest card
  expect(dropTarget(boxes, 400, 45)?.index).toBe(1)
})

it('builds nice axis scales', () => {
  expect(niceScale(0)).toEqual({ top: 1, ticks: [0, 0.5, 1] })
  expect(niceScale(250).ticks).toEqual([0, 100, 200, 300])
  expect(niceScale(2, true).ticks).toEqual([0, 1, 2])
  expect(niceScale(7, true).top).toBe(10)
})

it('draws escaped, labelled svg charts for both kinds and detects empty data', () => {
  const points = [
    { label: 'Jan', value: 0, tip: '<b>0</b>' },
    { label: 'Feb', value: 40, tip: '40' },
  ]
  expect(hasChartData(points)).toBe(true)
  expect(hasChartData([{ label: 'x', value: 0, tip: '' }])).toBe(false)
  const base = { width: 400, color: 'var(--accent)', formatAxis: String, ariaLabel: 'Spending' }
  const columns = renderChartSvg(points, { ...base, kind: 'columns' })
  expect(columns).toContain('role="img"')
  expect(columns).toContain('&lt;b&gt;0&lt;/b&gt;')
  expect(columns).not.toContain('<b>')
  expect(columns.match(/<title>/g)).toHaveLength(2)
  const area = renderChartSvg(points, { ...base, kind: 'area' })
  expect(area).toContain('<polyline')
  expect(area).toContain('<path')
})

it('leaves gaps for months without data instead of drawing points or joining the line', () => {
  const base = { width: 400, color: 'var(--accent)', formatAxis: String, ariaLabel: 'Stock' }
  const points = [
    { label: 'Jan', value: 10, tip: 'jan' },
    { label: 'Feb', value: 20, tip: 'feb' },
    { label: 'Mar', value: null, tip: '' },
    { label: 'Apr', value: 30, tip: 'apr' },
  ]
  const area = renderChartSvg(points, { ...base, kind: 'area' })
  // Two runs: Jan-Feb is a line, the lone April month is only a dot.
  expect(area.match(/<polyline/g)).toHaveLength(1)
  expect(area.match(/<circle[^>]*r="3"/g)).toHaveLength(3)
  expect(area.match(/<title>/g)).toHaveLength(3)
  expect(renderChartSvg(points, { ...base, kind: 'columns' }).match(/<title>/g)).toHaveLength(3)
  expect(hasChartData([{ label: 'a', value: null, tip: '' }, { label: 'b', value: null, tip: '' }])).toBe(false)
  expect(hasChartData(points)).toBe(true)
})
