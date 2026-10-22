// Loopback-only test server; not an authenticated production API.
import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-wasm';
import { fixtures, data } from './fixtures.mjs';

const frontend = fileURLToPath(new URL('../../', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const server = await createServer({ configFile: false, root: frontend,
  plugins: [{ name: 'svg-probe', configureServer: vite => { vite.middlewares.use(handle); } }],
  server: { host: '127.0.0.1', port: 4407, strictPort: true, fs: { allow: [root] } } });
const core = await server.ssrLoadModule('/tests/label-rendering/render.mjs');
const wasm = await readFile(`${frontend}/node_modules/@resvg/resvg-wasm/index_bg.wasm`);
await core.initWasm(wasm);
const fontBytes = await Promise.all(core.fontFiles.map(({ file }) => readFile(`${frontend}/node_modules/${file}`)));
const fonts = await core.loadFonts((_file, index) => fontBytes[index]);
function asset(svg, width, height) {
  const renderer = new Resvg(svg), result = renderer.render();
  try { return { width, height, dataUrl: `data:image/png;base64,${Buffer.from(result.asPng()).toString('base64')}` }; }
  finally { result.free(); renderer.free(); }
}
const qrLogo = await readFile(`${frontend}/public/logo-qr.png`);
const assets = {
  qrLogo: { dataUrl: `data:image/png;base64,${qrLogo.toString('base64')}`, width: qrLogo.readUInt32BE(16), height: qrLogo.readUInt32BE(20) },
  logo: asset('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="32" stroke="black" stroke-width="7" fill="none"/><path d="M29 22H53V30H38V37H50V45H38V59H29Z" fill="black"/></svg>', 80, 80),
  photo: asset('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#138c81"/><circle cx="60" cy="40" r="30" fill="#e6ba66"/><circle cx="60" cy="40" r="14" fill="#173832"/><path d="M0 0L120 80M0 80L120 0" stroke="#ffffff" stroke-width="2"/></svg>', 120, 80),
};
async function handle(req, res, next) {
  try {
    if (req.url === '/probe/wasm') { res.setHeader('Content-Type', 'application/wasm'); return res.end(wasm); }
    const fontIndex = /^\/probe\/font\/(\d+)$/.exec(req.url)?.[1];
    if (fontIndex !== undefined && fontBytes[Number(fontIndex)]) return res.end(fontBytes[Number(fontIndex)]);
    if (req.url === '/probe/fixtures') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ fixtures, data, assets })); }
    if (req.url !== '/probe/render' || req.method !== 'POST') return next();
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100000) throw new Error('Test request too large');
    }
    const { preset, data: values, dpi, threshold, thermal = true, entityPath = 'spools', noLogo = false } = JSON.parse(body);
    const selectedAssets = { ...assets, ...(noLogo ? { logo: undefined } : {}) };
    const start = performance.now();
    let result, raster, error;
    try { result = core.renderLabel(preset, values, selectedAssets, fonts, dpi, 'https://fila.test', { thermal, entityPath }); raster = core.rasterize(result.svg, threshold); }
    catch (caught) { error = caught.message; }
    const milliseconds = performance.now() - start;
    res.setHeader('Content-Type', 'application/json');
    if (error) res.statusCode = 422;
    res.end(JSON.stringify({ ...result, error, milliseconds,
      png: raster && Buffer.from(raster.png).toString('base64'), mono: raster && Buffer.from(raster.mono).toString('base64'),
      pixels: raster && Buffer.from(raster.pixels).toString('base64') }));
  } catch (error) { res.statusCode = 422; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error.message })); }
}
await server.listen();
console.log('Label rendering checks: http://127.0.0.1:4407/tests/label-rendering/');
