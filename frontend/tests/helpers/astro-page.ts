import { readFileSync } from 'node:fs'
import { createSourceFile, isImportDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import FormDialog from '../../src/components/FormDialog.astro'
import FormSection from '../../src/components/FormSection.astro'
import ColorEditorFields from '../../src/components/ColorEditorFields.astro'
import InventoryLoadMore from '../../src/components/InventoryLoadMore.astro'
import AdminHeader from '../../src/components/AdminHeader.astro'

const components = { FormDialog, FormSection, ColorEditorFields, AdminHeader, InventoryLoadMore }
const shellPattern = /<(FormDialog|FormSection|ColorEditorFields|AdminHeader|InventoryLoadMore)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...source: string[]) => (...values: unknown[]) => Promise<unknown>

/** Render actual shared shells, then run the page script after DOM setup, without Layout's startup side effects. */
export async function bootAstroPage(path: string, dependencies: Record<string, unknown>): Promise<void> {
  const page = readFileSync(`src/pages/${path}.astro`, 'utf8')
  const container = await AstroContainer.create()
  async function renderShells(markup: string): Promise<string> {
    for (const match of [...markup.matchAll(shellPattern)]) {
      const props: Record<string, string | boolean> = {}
      for (const attr of match[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{(true|false)\}))?/g)) {
        const value = attr[2] ?? attr[3]
        if (value === undefined) props[attr[1]] = attr[4] === undefined || attr[4] === 'true'
        else {
          const text = document.createElement('textarea')
          text.innerHTML = value
          props[attr[1]] = text.value
        }
      }
      const slots: Record<string, string> = {}
      slots.default = (await renderShells(match[3] || '')).replace(/<Fragment\s+slot=["']([^"']+)["']>([\s\S]*?)<\/Fragment>/g, (_fragment: string, name: string, content: string) => { slots[name] = content; return '' })
      markup = markup.replace(match[0], await container.renderToString(components[match[1] as keyof typeof components], { props, slots }))
    }
    return markup
  }
  document.body.innerHTML = await renderShells(page.match(/<Layout[^>]*>([\s\S]*?)<script>/)![1])
  const script = createSourceFile(`${path}.ts`, page.match(/<script>([\s\S]*?)<\/script>/)![1], ScriptTarget.Latest, true)
  const source = script.statements.filter(node => !isImportDeclaration(node)).map(node => node.getText(script)).join('\n')
  await new AsyncFunction(...Object.keys(dependencies), transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText)(...Object.values(dependencies))
}
