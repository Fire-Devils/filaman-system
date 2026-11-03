# Shared spool illustration

Plugin pages may import `renderSpoolReel` from the same-origin `/spool-reel.js` ES module. It is generated from the core hero renderer, uses `/reel-flange.webp`, and adds no network data requests.

```js
const { renderSpoolReel, buildFilamentSwatchStyle } = await import('/spool-reel.js');
const html = renderSpoolReel(0.5, ['#FF8800', '#0088FF80'], 'gradient', { view: 'full' });
```

The fraction is 0–1; `null` draws a full illustration for an unknown amount. Known zero draws an empty reel. Colors accept RGB/RGBA hex; `striped` draws co-extruded strands, `gradient` follows winding length. Without options the existing quarter-hero view is retained.

The returned span/SVG is decorative (`aria-hidden`); show accessible remaining text separately. Give `.spool-reel-full` a square size and its `svg` 100% width/height. Pattern IDs are unique across calls. Render visible cards only; avoid regenerating unchanged reels on polling. Feature-detect the import and retain a fallback for older core releases. Native `include_metrics=true` supplies the core remaining projection; never treat missing metrics as zero.

Full gallery illustrations use 128 color/alpha stops and subpixel coordinate rounding to bound SVG nodes and size; quarter-hero rendering keeps its original precision. Cache unchanged reels by card identity, not only by color, so transparent-pattern IDs remain distinct between cards.

The same module exports `buildFilamentSwatchStyle(filament)`, the color-pill style used on core spool and filament pages. It accepts native filament colors (including ordering, single/multicolor mode and alpha) and returns a CSS declaration string with hard color bands, gradients and a transparency checkerboard. Apply it to a pill of the appropriate size; empty colors return an empty style. Feature-detect this optional export on older cores.

`/plugin-fonts.css` exposes the same locally hosted Space Grotesk font assets as the core UI, so iframe/standalone pages do not need an external font service. Older cores without the stylesheet retain the plugin’s system-font fallback.
