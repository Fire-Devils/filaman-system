import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule, type FunctionDeclaration, type Node } from 'typescript'

export function astroPageFunction(page: string, name: string): string {
  const source = readFileSync(`src/pages/${page}.astro`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile('page.ts', source, ScriptTarget.Latest, true)
  const find = (node: Node): FunctionDeclaration | undefined =>
    isFunctionDeclaration(node) && node.name?.text === name ? node : node.forEachChild(find)
  const declaration = find(parsed)
  if (!declaration) throw new Error(`Missing ${name} in ${page}`)
  return transpileModule(declaration.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
}
