import wheel from '../styles/color-wheel.css?raw'

export const prerender = true

export function GET() {
  return new Response(wheel + `
.fm-plugin-color-harmonies {
  --bg-soft: var(--fm-harmony-surface, #172922);
  --border: var(--fm-harmony-border, #566860);
  --text: var(--fm-harmony-text, #e8f1ed);
  --text-muted: var(--fm-harmony-muted, #adbbb4);
  display: grid;
  gap: 4px;
  justify-items: center;
}
.fm-plugin-color-harmonies [hidden] { display: none !important; }
.fm-plugin-color-harmonies select {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  max-width: 100%;
  padding: 4px 8px;
}
.fm-plugin-color-harmonies .fm-header-color-wheel {
  --color-saturation-inner: 0%;
  box-sizing: border-box;
  touch-action: auto;
}
.fm-plugin-color-harmonies [data-color-harmony-tone='analogous'] { --color-harmony-outline: #b8c47e; }
.fm-plugin-color-harmonies [data-color-harmony-tone='split-complementary'] { --color-harmony-outline: #ca9fe0; }
.fm-plugin-color-harmonies circle.is-reference {
  filter: drop-shadow(0 0 1px #000);
  stroke: #fff;
  stroke-opacity: 1;
  stroke-width: 1.5;
}
.fm-plugin-color-harmonies circle.is-reference-ring {
  fill: none;
  r: 4;
}
`, { headers: { 'Content-Type': 'text/css; charset=utf-8' } })
}
