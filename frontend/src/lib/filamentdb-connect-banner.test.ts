// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: { id: 7, is_superadmin: false, permissions: ['filamentdb:contribute'] } as { id: number; is_superadmin: boolean; permissions: string[] },
  status: { plugin_active: true, token_saved: false },
}))

vi.mock('./auth', async () => {
  const actual = await vi.importActual<typeof import('./auth')>('./auth')
  return { ...actual, getMe: vi.fn(async () => state.user) }
})
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, api: { get: vi.fn(async () => state.status) } }
})

import {
  BANNER_HIDE_DAYS, bannerStorageKey, connectBannerVariant, dismissBanner, isBannerDismissed, mountConnectBanner,
} from './filamentdb-connect-banner'
import { loadContribContext, resetContribContext } from './filamentdb-contrib'

beforeEach(() => {
  localStorage.clear()
  resetContribContext()
  state.user = { id: 7, is_superadmin: false, permissions: ['filamentdb:contribute'] }
  state.status = { plugin_active: true, token_saved: false }
  document.body.innerHTML = '<div id="host"></div>'
})

describe('connectBannerVariant', () => {
  it.each([
    ['no permission', { hasPermission: false, pluginActive: false, tokenSaved: false }, null],
    ['plugin off', { hasPermission: true, pluginActive: false, tokenSaved: true }, 'noPlugin'],
    ['no token', { hasPermission: true, pluginActive: true, tokenSaved: false }, 'noToken'],
    ['everything there', { hasPermission: true, pluginActive: true, tokenSaved: true }, null],
  ] as const)('%s', (_name, context, expected) => {
    expect(connectBannerVariant(context)).toBe(expected)
  })
})

describe('loadContribContext hasPermission', () => {
  it('distinguishes a missing permission from a missing plugin or token', async () => {
    state.user = { id: 3, is_superadmin: false, permissions: [] }
    expect(await loadContribContext()).toMatchObject({ hasPermission: false, canContribute: false, userId: 3 })
    resetContribContext()
    state.user = { id: 3, is_superadmin: false, permissions: ['filamentdb:contribute'] }
    expect(await loadContribContext()).toMatchObject({ hasPermission: true, needsToken: true, userId: 3 })
  })
})

describe('mountConnectBanner', () => {
  const host = () => document.getElementById('host') as HTMLElement

  it('renders the token variant with a link to /filamentdb', async () => {
    await mountConnectBanner(host())
    const banner = host().querySelector('[data-fdb-connect-banner]')
    expect(banner?.getAttribute('data-fdb-connect-banner')).toBe('noToken')
    expect(host().querySelector('a[data-fdb-banner-cta]')?.getAttribute('href')).toBe('/filamentdb')
  })

  it('renders the plugin variant when the plugin is off', async () => {
    state.status = { plugin_active: false, token_saved: false }
    await mountConnectBanner(host())
    expect(host().querySelector('[data-fdb-connect-banner]')?.getAttribute('data-fdb-connect-banner')).toBe('noPlugin')
  })

  it('shows nothing without permission or when everything is set up', async () => {
    state.user = { id: 7, is_superadmin: false, permissions: [] }
    await mountConnectBanner(host())
    expect(host().innerHTML).toBe('')
    resetContribContext()
    state.user = { id: 7, is_superadmin: false, permissions: ['filamentdb:contribute'] }
    state.status = { plugin_active: true, token_saved: true }
    await mountConnectBanner(host())
    expect(host().innerHTML).toBe('')
  })

  it('hides for 14 days per user after the close button and stays hidden', async () => {
    await mountConnectBanner(host())
    ;(host().querySelector('[data-fdb-banner-close]') as HTMLElement).click()
    expect(host().innerHTML).toBe('')
    expect(isBannerDismissed(7)).toBe(true)
    expect(isBannerDismissed(8)).toBe(false)
    await mountConnectBanner(host())
    expect(host().innerHTML).toBe('')
    const until = Number(localStorage.getItem(bannerStorageKey(7)))
    expect(until - Date.now()).toBeGreaterThan((BANNER_HIDE_DAYS - 1) * 86400000)
  })

  it('shows the banner again after the 14 days are over', () => {
    const now = Date.now()
    dismissBanner(7, now - (BANNER_HIDE_DAYS + 1) * 86400000)
    expect(isBannerDismissed(7, now)).toBe(false)
  })
})
