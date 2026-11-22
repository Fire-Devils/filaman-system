// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { astroPageFunction } from '../../tests/helpers/astro-script'

const production = astroPageFunction('filaments/colors', 'loadColors')

it.each(['success', 'failure'])('keeps newer color rows when an older load finishes with %s', async outcome => {
  document.body.innerHTML = '<table><tbody id="colors-table"></tbody></table>'
  let finish!: (value: { items: { name: string }[] }) => void
  let fail!: (error: Error) => void
  const old = new Promise<{ items: { name: string }[] }>((resolve, reject) => { finish = resolve; fail = reject })
  let reads = 0
  const load = new Function('fetchAllPages', 'document', 'console', `
    let colors = [], colorRequestId = 0;
    const panelSignal = { aborted: false }, colorHeaderFilters = null;
    const colorList = { pause() {} }, isAbortError = () => false, t = key => key;
    const renderColors = () => { document.getElementById('colors-table').textContent = colors[0].name; };
    ${production}; return loadColors;
  `)(() => ++reads === 1 ? old : Promise.resolve({ items: [{ name: 'Latest color' }] }), document, { error() {} })
  const first = load()
  await load()
  if (outcome === 'success') finish({ items: [{ name: 'Obsolete color' }] })
  else fail(new Error('Old request failed'))
  await first
  expect(document.getElementById('colors-table')!.textContent).toBe('Latest color')
})


it.each(['success', 'failure'])('leaves a replacement panel intact when a locations read ends with %s', async outcome => {
  document.body.innerHTML = '<table><tbody id="locations-table">Replacement panel</tbody></table>'
  const source = astroPageFunction('locations/index', 'loadLocations')
  const load = new Function('cachedFetchAllPages', 'document', 'console', `
    let locations = [];
    const panelSignal = { aborted: true }, CACHE_KEYS = {}, selectedIds = new Set();
    const isAbortError = () => false, t = key => key, visibleLocations = () => [];
    const renderTypeFilter = () => {}, renderLocations = () => { document.getElementById('locations-table').textContent = 'Old panel data'; };
    ${source}; return loadLocations;
  `)(async () => { if (outcome === 'failure') throw new Error('Old read failed'); return { items: [] } }, document, { error() {} })
  await load()
  expect(document.getElementById('locations-table')!.textContent).toBe('Replacement panel')
})
