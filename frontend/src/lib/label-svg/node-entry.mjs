import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fontFiles, initWasm, loadFont, renderLabel, rasterizePng } from './core.mjs';
import { prepareSvgApiInput } from './prepare-api.ts';

let kind = 'layout';
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 96 * 1024 * 1024) throw new Error('Label input exceeds renderer budget');
    chunks.push(chunk);
  }
  const { payload, origin, assets } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const input = prepareSvgApiInput(payload, origin, assets);
  kind = 'internal';
  await initWasm(await readFile(new URL('./resources/@resvg/resvg-wasm/index_bg.wasm', import.meta.url)));
  const fonts = {};
  for (const { key, file } of fontFiles) {
    let font;
    Object.defineProperty(fonts, key, { get() {
      // The shared layout selects faces, including inline styles and QR decoration.
      try { return font ??= loadFont(readFileSync(new URL(`./resources/${file}`, import.meta.url))); }
      catch (error) { kind = 'internal'; throw error; }
    } });
  }
  const logo = await readFile(new URL('./resources/logo-qr.png', import.meta.url));
  input.assets.qrLogo = { dataUrl: `data:image/png;base64,${logo.toString('base64')}`, width: logo.readUInt32BE(16), height: logo.readUInt32BE(20) };
  kind = 'layout';
  const { svg } = renderLabel(input.preset, input.data, input.assets, fonts, undefined, input.origin, input);
  process.stdout.write(JSON.stringify({ png: Buffer.from(rasterizePng(svg)).toString('base64') }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { kind, message: kind === 'layout' ? String(error.message).slice(0, 300) : 'Shared label runtime unavailable' } }));
}
