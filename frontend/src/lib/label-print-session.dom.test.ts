// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'

import {
  consumeScopedLabelFields,
  writeScopedLabelFields,
} from './label-print-session'

const STORAGE_KEY = 'label-fields'

beforeEach(() => sessionStorage.clear())

describe('scoped label print session fields', () => {
  it('consumes fields only for the requested entity', () => {
    writeScopedLabelFields(STORAGE_KEY, 42, [{ key: 'finish' }])

    expect(consumeScopedLabelFields<{ key: string }>(STORAGE_KEY, '42'))
      .toEqual([{ key: 'finish' }])
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('discards a payload belonging to another entity', () => {
    writeScopedLabelFields(STORAGE_KEY, 41, [{ key: 'finish' }])

    expect(consumeScopedLabelFields(STORAGE_KEY, 42)).toEqual([])
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('discards legacy unscoped arrays', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([{ key: 'finish' }]))

    expect(consumeScopedLabelFields(STORAGE_KEY, 42)).toEqual([])
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('returns an empty list for malformed storage', () => {
    sessionStorage.setItem(STORAGE_KEY, '{')

    expect(consumeScopedLabelFields(STORAGE_KEY, 42)).toEqual([])
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
