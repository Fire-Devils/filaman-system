import { beforeEach, describe, expect, it } from 'vitest'
import { canSaveLocally, canSendOffer, isValidShopUrl, offerHistoryText, renderOffer, type FdbOffer } from './filamentdb-offers'

beforeEach(() => {
  const store: Record<string, string> = { lang: 'de' }
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => store[k] ?? null, setItem() {} }, configurable: true })
})

const offer: FdbOffer = {
  id: 4711, url: 'https://shop.example/pla', shop_name: 'Beispiel Shop', currency: 'EUR', status: 'active',
  current_price: 19.9, last_reported_at: '2026-11-20T10:00:00Z', report_count: 0,
  prices: [{ price: 19.9, reported_at: '2026-11-20' }, { price: 21, reported_at: '2026-11-01' }],
}

describe('filamentdb-offers', () => {
  it('accepts only http(s) shop urls', () => {
    expect(isValidShopUrl('https://shop.example/x')).toBe(true)
    expect(isValidShopUrl('http://shop.example')).toBe(true)
    expect(isValidShopUrl('')).toBe(false)
    expect(isValidShopUrl('ftp://shop.example')).toBe(false)
    expect(isValidShopUrl('javascript:alert(1)')).toBe(false)
    expect(isValidShopUrl('shop.example')).toBe(false)
    expect(isValidShopUrl('https://a.example/' + 'x'.repeat(1000))).toBe(false)
  })

  it('enables sending only with a valid link, price and currency', () => {
    expect(canSendOffer({ url: 'https://s.example', price: '19,90', currency: 'eur' })).toBe(true)
    expect(canSendOffer({ url: '', price: '19.9', currency: 'EUR' })).toBe(false)
    expect(canSendOffer({ url: 'https://s.example', price: '0', currency: 'EUR' })).toBe(false)
    expect(canSendOffer({ url: 'https://s.example', price: '5', currency: 'EU' })).toBe(false)
  })

  it('allows local saving without a link but not with a broken one', () => {
    expect(canSaveLocally({ url: '', price: 5, currency: 'EUR' })).toBe(true)
    expect(canSaveLocally({ url: 'kaputt', price: 5, currency: 'EUR' })).toBe(false)
  })

  it('renders shop link safely, without raw ids in the text', () => {
    const html = renderOffer(offer, { canReport: true })
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('Beispiel Shop')
    const text = html.replace(/<[^>]+>/g, ' ')
    expect(text).not.toContain('4711')
    expect(html).toContain('data-offer-report="4711"')
    expect(offerHistoryText(offer)).toContain(' · ')
  })

  it('marks inactive offers and hides the report button', () => {
    const html = renderOffer({ ...offer, status: 'blocked' }, { canReport: true })
    expect(html).toContain('data-offer-inactive')
    expect(html).not.toContain('data-offer-report')
    expect(renderOffer(offer, { canReport: false })).not.toContain('data-offer-report')
  })

  it('does not link unsafe urls and escapes names', () => {
    const html = renderOffer({ ...offer, url: 'javascript:alert(1)', shop_name: '<b>x</b>' }, { canReport: false })
    expect(html).not.toContain('href="javascript')
    expect(html).not.toContain('<b>x</b>')
  })
})
