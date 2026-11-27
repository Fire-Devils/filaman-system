import { expect, it } from 'vitest'
import { applyWidgetOrder, assignMasonryColumns, dropTarget, masonryColumnCount } from './dashboard-layout'
import { hasChartData, niceScale, renderChartSvg } from './dashboard-charts'

it('puts saved widgets first, drops unknown ids and appends new widgets in markup order', () => {
  expect(applyWidgetOrder(['a', 'b', 'c', 'd'], ['c', 'x', 'a', 'c'])).toEqual(['c', 'a', 'b', 'd'])
  expect(applyWidgetOrder(['a', 'b'], [])).toEqual(['a', 'b'])
})

it('picks masonry column counts by width', () => {
  expect([500, 620, 959, 960, 1400].map(masonryColumnCount)).toEqual([1, 2, 2, 3, 3])
})

it('assigns each item to the shortest column, ties go left, hidden items take no space', () => {
  expect(assignMasonryColumns([100, 300, 100, 100, 100], 2)).toEqual([0, 1, 0, 0, 0])
  expect(assignMasonryColumns([50, 50, 50], 3)).toEqual([0, 1, 2])
  expect(assignMasonryColumns([0, 0, 10], 2)).toEqual([0, 0, 0])
  expect(assignMasonryColumns([100, 100, 100], 2, 20)).toEqual([0, 1, 0])
  expect(assignMasonryColumns([10, 20], 0)).toEqual([0, 0])
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
