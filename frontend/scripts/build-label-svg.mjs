import { build } from 'vite';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildLabelSvg(directory = resolve(root, 'dist/label-svg')) {
  await build({ configFile: false, root, logLevel: 'warn',
    ssr: { noExternal: true },
    build: { target: 'node20', ssr: resolve(root, 'src/lib/label-svg/node-entry.mjs'), outDir: directory,
      emptyOutDir: false, minify: false, rollupOptions: { output: { entryFileNames: 'render.mjs' } } },
  });
  const copy = async (source, relative) => {
    const target = resolve(directory, 'resources', relative);
    await mkdir(resolve(target, '..'), { recursive: true });
    await cp(source, target);
  };
  await copy(resolve(root, 'node_modules/@resvg/resvg-wasm/index_bg.wasm'), '@resvg/resvg-wasm/index_bg.wasm');
  await copy(resolve(root, 'public/logo-qr.png'), 'logo-qr.png');
  for (const family of await readdir(resolve(root, 'node_modules/@fontsource'))) {
    const packageRoot = resolve(root, 'node_modules/@fontsource', family);
    for (const file of await readdir(resolve(packageRoot, 'files'))) {
      if (/-latin-(400|500|600|700)-normal\.woff2$/.test(file)) await copy(resolve(packageRoot, 'files', file), `@fontsource/${family}/files/${file}`);
    }
    await copy(resolve(packageRoot, 'LICENSE'), `@fontsource/${family}/LICENSE`);
  }
  for (const name of ['fontkit', 'qrcode', '@resvg/resvg-wasm']) {
    const packageRoot = resolve(root, 'node_modules', name);
    for (const file of await readdir(packageRoot)) if (/^licen[cs]e/i.test(file)) await copy(resolve(packageRoot, file), `${name}/${file}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildLabelSvg();
