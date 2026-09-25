import type { DesignerIconName } from './icons'

export type TemplateTextModifier =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'caps'
  | 'inverse'
  | 'colorInverse'
  | 'date'

export interface TemplateTextModifierMetadata {
  modifier: TemplateTextModifier
  label: string
  i18n: string
  glyph?: 'bold' | 'italic' | 'underline'
  icon?: DesignerIconName
}

export const TEMPLATE_TEXT_MODIFIERS: readonly TemplateTextModifierMetadata[] = [
  { modifier: 'bold', label: 'Bold', i18n: 'labelDesigner.modifierBold', glyph: 'bold' },
  { modifier: 'italic', label: 'Italic', i18n: 'labelDesigner.modifierItalic', glyph: 'italic' },
  { modifier: 'underline', label: 'Underline', i18n: 'labelDesigner.modifierUnderline', glyph: 'underline' },
  { modifier: 'caps', label: 'Uppercase', i18n: 'labelDesigner.modifierUppercase', icon: 'uppercase' },
  { modifier: 'inverse', label: 'Inverse', i18n: 'labelDesigner.modifierInverse', icon: 'inverse' },
  { modifier: 'colorInverse', label: 'Filament color inverse', i18n: 'labelDesigner.modifierColorInverse', icon: 'colorInverse' },
  { modifier: 'date', label: 'Date only', i18n: 'labelDesigner.modifierDateOnly', icon: 'date' },
]

export const TEMPLATE_TEXT_MODIFIER_DELIMITERS: Readonly<Record<Exclude<TemplateTextModifier, 'date'>, string>> = {
  bold: '**',
  italic: '*',
  underline: '__',
  caps: '^^',
  inverse: '==',
  colorInverse: '@@',
}

export function wrapTemplateToken(token: string, modifier?: TemplateTextModifier | null): string {
  if (!modifier) return token
  if (modifier === 'date') return token.replace(/}$/, '|date}')
  if (modifier === 'bold') return `[b]${token}[/b]`
  if (modifier === 'italic') return `[i]${token}[/i]`
  const delimiter = TEMPLATE_TEXT_MODIFIER_DELIMITERS[modifier]
  return `${delimiter}${token}${delimiter}`
}
