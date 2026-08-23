import { describe, expect, it } from 'vitest'

import { isValidPluginSlug, navHrefFor, PLUGIN_PAGE_PREFIX } from './plugin-nav'

describe('navHrefFor', () => {
  it('routes backend plugin pages through /plugin-view', () => {
    expect(navHrefFor('/plugin-page/spoolman-api')).toBe('/plugin-view?p=spoolman-api')
  })

  it('encodes multi-segment slugs', () => {
    expect(navHrefFor('/plugin-page/foo/bar')).toBe('/plugin-view?p=foo%2Fbar')
  })

  it('leaves page_urls that are not backend pages untouched', () => {
    expect(navHrefFor('/admin/system')).toBe('/admin/system')
  })

  it('exposes the shared prefix', () => {
    expect(PLUGIN_PAGE_PREFIX).toBe('/plugin-page/')
  })
})

describe('isValidPluginSlug', () => {
  it.each([
    ['spoolman-api', true],
    ['my_plugin', true],
    ['foo/bar', true],
    ['a', true],
    ['', false],
    ['../etc/passwd', false],
    ['foo/../bar', false],
    ['foo//bar', false],
    ['foo/', false],
    ['/foo', false],
    ['foo bar', false],
    ['foo?x=1', false],
    ['FOO', false],
    ['a'.repeat(488), false],
  ])('%s -> %s', (slug, expected) => {
    expect(isValidPluginSlug(slug)).toBe(expected)
  })
})
