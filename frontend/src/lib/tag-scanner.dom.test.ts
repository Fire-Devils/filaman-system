// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getBoundReaderId,
  isAutoOpenEnabled,
  isJumpRoute,
  rememberJump,
  takeRememberedJump,
  lastScanUrl,
  mayNavigate,
  setAutoOpenEnabled,
  setBoundReaderId,
} from './tag-scanner'

// happy-dom does not provide localStorage here, and a browser may refuse it
// outright, so the tests bring their own and one case takes it away again.
function installStorage(): Storage {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } as Storage
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'localStorage' ? storage : makeStore(),
    })
  }
  return storage
}

function makeStore(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } as Storage
}

beforeEach(() => {
  installStorage()
  document.body.innerHTML = ''
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
  Reflect.deleteProperty(globalThis, 'sessionStorage')
})

describe('the preference', () => {
  it('is off until somebody turns it on', () => {
    expect(isAutoOpenEnabled()).toBe(false)
    setAutoOpenEnabled(true)
    expect(isAutoOpenEnabled()).toBe(true)
    setAutoOpenEnabled(false)
    expect(isAutoOpenEnabled()).toBe(false)
  })

  it('follows every reader until one is picked', () => {
    expect(getBoundReaderId()).toBeNull()
    setBoundReaderId('device-12')
    expect(getBoundReaderId()).toBe('device-12')
    setBoundReaderId(null)
    expect(getBoundReaderId()).toBeNull()
  })

  it('binds to a reader id, not to a device row', () => {
    // An app on an API key is a reader too and has no device to be numbered.
    setBoundReaderId('iphone-nikolai')
    expect(getBoundReaderId()).toBe('iphone-nikolai')
  })

  it('survives a browser that refuses local storage', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked')
      },
    })
    expect(() => setAutoOpenEnabled(true)).not.toThrow()
    expect(isAutoOpenEnabled()).toBe(false)
    expect(getBoundReaderId()).toBeNull()
  })

  it('survives a browser without local storage at all', () => {
    Reflect.deleteProperty(globalThis, 'localStorage')
    expect(() => setAutoOpenEnabled(true)).not.toThrow()
    expect(isAutoOpenEnabled()).toBe(false)
  })
})

describe('saying why the page changed', () => {
  it('hands the reason to the page it jumps to, once', () => {
    rememberJump({ uid: '04EF14', spoolId: 56, at: 1000 })

    const first = takeRememberedJump(1200)
    expect(first?.uid).toBe('04EF14')
    expect(first?.spoolId).toBe(56)
    // Taken, not read: a reload must not repeat the explanation.
    expect(takeRememberedJump(1200)).toBeNull()
  })

  it('drops a reason that is too old to be about this arrival', () => {
    rememberJump({ uid: '04EF14', spoolId: 56, at: 1000 })
    expect(takeRememberedJump(1000 + 60_000)).toBeNull()
  })

  it('says nothing when there was no jump', () => {
    expect(takeRememberedJump()).toBeNull()
  })

  it('survives a browser without session storage', () => {
    Reflect.deleteProperty(globalThis, 'sessionStorage')
    expect(() => rememberJump({ uid: 'x', spoolId: 1, at: 1 })).not.toThrow()
    expect(takeRememberedJump()).toBeNull()
  })
})

describe('which reader to poll', () => {
  it('asks about all of them, or exactly one', () => {
    expect(lastScanUrl(null)).toBe('/api/v1/tag/last-scan')
    expect(lastScanUrl('device-12')).toBe('/api/v1/tag/last-scan?reader_id=device-12')
    expect(lastScanUrl('a b')).toBe('/api/v1/tag/last-scan?reader_id=a%20b')
  })
})

describe('when a scan may move the page', () => {
  it('jumps where a scan continues what you were doing', () => {
    expect(isJumpRoute('/')).toBe(true)
    expect(isJumpRoute('/spools')).toBe(true)
    expect(isJumpRoute('/spools/')).toBe(true)
    expect(isJumpRoute('/spools/56')).toBe(true)
    expect(isJumpRoute('/filaments')).toBe(true)
    expect(isJumpRoute('/filaments/12')).toBe(true)
  })

  it('only offers everywhere else, plugin pages included', () => {
    // Plugins register their pages at runtime, so no list here can know them.
    // An allowlist means the worst an unknown page gets is an offer.
    expect(isJumpRoute('/plugin-page/bambulab')).toBe(false)
    expect(isJumpRoute('/plugin-view/')).toBe(false)
    expect(isJumpRoute('/display')).toBe(false)
    expect(isJumpRoute('/locations')).toBe(false)
    expect(isJumpRoute('/printers/1')).toBe(false)
    expect(isJumpRoute('/settings')).toBe(false)
    expect(isJumpRoute('/admin/devices')).toBe(false)
  })

  it('leaves editors and forms alone although they sit under /spools', () => {
    expect(isJumpRoute('/spools/4/edit')).toBe(false)
    expect(isJumpRoute('/spools/new')).toBe(false)
    expect(isJumpRoute('/spools/4/print')).toBe(false)
  })

  it('waits while somebody is typing', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(mayNavigate(document, '/spools')).toBe(false)
    input.blur()
    expect(mayNavigate(document, '/spools')).toBe(true)
  })

  it('waits while a dialog is open', () => {
    document.body.innerHTML = '<dialog open></dialog>'
    expect(mayNavigate(document, '/spools')).toBe(false)
  })
})
