import { build } from 'vite'
import { resolve } from 'node:path'

export const prerender = true

// Stable, self-contained module for plugin pages; generated once during static builds.
export async function GET() {
  const result = await build({ configFile: false, logLevel: 'error', build: {
    write: false, minify: true,
    lib: { entry: resolve('src/lib/plugin-color-harmonies.ts'), formats: ['es'] },
  } })
  const bundle = Array.isArray(result) ? result[0] : result
  if (!('output' in bundle)) throw new Error('Color harmonies module build did not produce output')
  return new Response(bundle.output[0].type === 'chunk' ? bundle.output[0].code : '', {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  })
}
