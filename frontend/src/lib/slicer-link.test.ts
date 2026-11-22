import { describe, expect, it } from 'vitest'
import { buildCommand, normalizeMap } from './slicer-link'

describe('slicer link command', () => {
  it('uses placeholders for python, script and key', () => {
    expect(buildCommand({ url: 'https://filaman.local/', printerId: 3 })).toBe(
      'PYTHON_PATH SCRIPT_PATH --url https://filaman.local --key "<API-KEY>" --printer 3',
    )
  })

  it('quotes paths with spaces and appends a valid map', () => {
    const command = buildCommand({
      url: 'http://nas:8000', printerId: 1, key: 'uak.1.x', map: '0=1, 1=2',
      pythonPath: 'C:\\Program Files\\Python\\python.exe', scriptPath: '/home/me/filaman_slicer_link.py',
    })
    expect(command).toBe(
      '"C:\\Program Files\\Python\\python.exe" /home/me/filaman_slicer_link.py --url http://nas:8000 --key uak.1.x --printer 1 --map 0=1,1=2',
    )
  })

  it('drops an invalid map', () => {
    expect(normalizeMap('0=1,a=2')).toBeNull()
    expect(buildCommand({ url: 'http://x', printerId: null, map: 'oops' })).not.toContain('--map')
  })
})
