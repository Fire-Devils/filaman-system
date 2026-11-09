# Shared color harmony wheel for plugins

Same-origin plugins can load `/color-harmonies.css` and import
`mountColorHarmonyWheel` from `/color-harmonies.js`. The module draws the FilaMan
wheel and catalog dots. The plugin supplies the data and renders any cards,
links, or actions. Matching runs in the browser.

```html
<link rel="stylesheet" href="/color-harmonies.css">
<div id="harmonies"></div>
<script type="module" src="/plugin/example/harmonies.js"></script>
```

```js
import { mountColorHarmonyWheel } from '/color-harmonies.js'

const wheel = mountColorHarmonyWheel(document.querySelector('#harmonies'), {
  referenceHex: '#EF324B',
  candidates: [
    { id: 42, hexes: ['#2DEBD0', '#18A9CD'] },
    { id: 43, hexes: ['#E73C51'] },
  ],
  modes: ['similar', 'complementary', 'analogous', 'triadic', 'split-complementary'],
  mode: 'similar',
  onChange({ mode, referenceHex, groups }) {
    renderMatches({ mode, referenceHex, groups })
  },
})

wheel.update({ referenceHex: '#1144CC' }) // e.g. a new stop on the current filament
// On unmount: wheel.destroy()
```

`referenceHex` and candidate `hexes` accept RGB and RGBA hex in short or long
form. Invalid candidate stops are ignored. Omit the current filament from
`candidates` if it should never appear in the results. The wheel still marks its
reference color. Pass a new `candidates` array when changing the catalog.

By default, the selector offers Complementary and Triadic and starts on the
first mode. `modes` selects and orders the options; `mode` selects one of those
options. `update(partialOptions)` keeps the user's current choice unless you
pass a new `mode` or remove the current choice. `locale` defaults to the document
language; English, German, and French are supported.

`onChange` runs synchronously on mount, update, and user selection. Results
contain the selected `mode`, the normalized `referenceHex` (or `null`), and
`groups`. Each group has an `offset`, a `targetHue`, and ordered
`matches: { id: string | number, hex: string, distance: number }[]`.

- Hue modes include the reference group at offset 0 and companion groups at
  180° (Complementary), 120°/240° (Triadic), 30°/330° (Analogous), or 150°/210°
  (Split complementary). Each range spans 35°. Each candidate appears at most
  once, in the range closest to any of its stops. Distance is measured in
  circular hue degrees. Hue modes return no groups for a neutral reference.
- Similar returns the five closest candidates by Euclidean RGB distance from the
  exact reference color, including neutral colors. Its one group has
  `offset: null` and `targetHue: null`. RGB ranking uses the stored RGB channels;
  the wheel also shows the stored alpha.
- Invalid references yield no groups.

Use feature detection if the plugin also supports older FilaMan versions: catch
a failed dynamic import and retain the plugin's own fallback. The optional CSS
properties `--fm-harmony-surface`, `--fm-harmony-border`, `--fm-harmony-text`,
and `--fm-harmony-muted` accept CSS colors for theme integration.
