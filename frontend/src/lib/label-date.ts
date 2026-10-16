/** Use the stored calendar day, never the browser/container locale or timezone. */
export function formatLabelDate(value: unknown, format = '%Y/%m/%d'): string {
  const raw = String(value)
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/)
  if (!match) return raw
  const [, year, month, day] = match
  const y = Number(year), m = Number(month), d = Number(day)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return raw
  const parts: Record<string, string> = { '%Y': year, '%y': year.slice(-2), '%m': month, '%d': day, '%%': '%' }
  return (format || '%Y/%m/%d').replace(/%[Yymd%]/g, token => parts[token])
}
