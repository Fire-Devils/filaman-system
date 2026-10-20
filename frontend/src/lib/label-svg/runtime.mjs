import { initWasm, loadFonts } from './core.mjs';

let pending;
export function createSvgRuntime(readAsset) {
  return pending ??= (async () => {
    await initWasm(await readAsset('@resvg/resvg-wasm/index_bg.wasm'));
    return { fonts: await loadFonts(readAsset) };
  })().catch(error => { pending = undefined; throw error; });
}
