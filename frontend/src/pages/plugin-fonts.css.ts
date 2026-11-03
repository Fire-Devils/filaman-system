import regular from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2?url'
import medium from '@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2?url'
import semibold from '@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff2?url'
import bold from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2?url'

export const prerender = true

// Plugins cannot inherit font faces from the application's surrounding iframe shell.
export function GET() {
  const css = Object.entries({ 400: regular, 500: medium, 600: semibold, 700: bold })
    .map(([weight, url]) => `@font-face{font-family:"Space Grotesk";font-style:normal;font-weight:${weight};font-display:swap;src:url("${url}") format("woff2")}`)
    .join('\n')
  return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8' } })
}
