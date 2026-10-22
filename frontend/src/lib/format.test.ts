import { describe, expect, it } from 'vitest'
import { suggestSpoolPurchasePrice } from './format'

describe('suggestSpoolPurchasePrice', () => {
  it.each([
    [19.99, 'eur', 'EUR', '19.99'],
    [19.99, 'EUR', 'eur', '19.99'],
    [19.99, null, 'EUR', '19.99'],
    [19.99, undefined, 'EUR', '19.99'],
    [19.99, '', 'EUR', '19.99'],
    [19.99, 'USD', 'EUR', ''],
    [null, 'EUR', 'EUR', ''],
    [undefined, 'EUR', 'EUR', ''],
    [0, 'EUR', 'EUR', '0'],
  ])('suggests %s %s in %s as %s', (price, sourceCurrency, appCurrency, expected) => {
    expect(suggestSpoolPurchasePrice(price, sourceCurrency, appCurrency)).toBe(expected)
  })
})
