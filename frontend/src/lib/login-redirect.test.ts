import { describe, expect, it } from 'vitest'
import { loginUrlWithNext, postLoginTarget, safeNextPath } from './login-redirect'

describe('safeNextPath', () => {
  it('accepts same-origin paths', () => {
    expect(safeNextPath('/spools/57')).toBe('/spools/57')
    expect(safeNextPath('/spools?status=active')).toBe('/spools?status=active')
  })

  it('rejects open redirects and the login page', () => {
    for (const raw of ['https://evil.example', '//evil.example', '/\\evil.example', 'spools/1', '/login', '/login?next=/x', '/\nx', '', null]) {
      expect(safeNextPath(raw)).toBeNull()
    }
  })
})

describe('loginUrlWithNext', () => {
  it('carries the current page', () => {
    expect(loginUrlWithNext({ pathname: '/spools/57', search: '' })).toBe('/login?next=%2Fspools%2F57')
  })

  it('omits next for the dashboard and the login page', () => {
    expect(loginUrlWithNext({ pathname: '/', search: '' })).toBe('/login')
    expect(loginUrlWithNext({ pathname: '/login', search: '?next=%2Fx' })).toBe('/login')
  })
})

describe('postLoginTarget', () => {
  it('round-trips a deep link and falls back to /', () => {
    expect(postLoginTarget('?next=%2Fspools%2F57')).toBe('/spools/57')
    expect(postLoginTarget('?next=%2F%2Fevil.example')).toBe('/')
    expect(postLoginTarget('')).toBe('/')
  })
})
