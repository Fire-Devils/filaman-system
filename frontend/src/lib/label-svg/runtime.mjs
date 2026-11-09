import { initWasm, loadFonts } from './core.mjs';

let layoutPending, rasterPending;
export function createSvgRuntime(readAsset, raster = true) {
  const layout = layoutPending ??= loadFonts(readAsset)
    .then(fonts => ({ fonts }))
    .catch(error => { layoutPending = undefined; throw error; });
  if (!raster) return layout;
  rasterPending ??= Promise.resolve().then(() => readAsset('@resvg/resvg-wasm/index_bg.wasm'))
    .then(initWasm)
    .catch(error => { rasterPending = undefined; throw error; });
  return Promise.all([layout, rasterPending]).then(([runtime]) => runtime);
}
