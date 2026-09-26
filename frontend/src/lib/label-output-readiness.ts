import { LABEL_FONT_FAMILIES } from './freeform-label/types'
import { initializeCroppedImage } from './freeform-label/cropped-image'

export class LabelOutputAssetError extends Error {}

function assertNoMissingAssets(root: HTMLElement) {
  const missing = root.matches('[data-label-output-error]')
    ? root
    : root.querySelector<HTMLElement>('[data-label-output-error]')
  if (missing) throw new LabelOutputAssetError(missing.dataset.labelOutputError || 'Label image unavailable')
}

async function waitForImage(image: HTMLImageElement) {
  // Standard labels retain an empty hidden logo node when logos are disabled.
  if (image.classList.contains('label-logo') && !image.getAttribute('src')?.trim()
    && (image.style.display === 'none' || getComputedStyle(image).display === 'none')) return
  if (typeof image.decode !== 'function') {
    initializeCroppedImage(image)
    return
  }
  try {
    await image.decode()
    initializeCroppedImage(image)
  } catch (error) {
    // complete is also true for failed downloads. Only decoded pixels prove success.
    if (image.complete && image.naturalWidth > 0) {
      initializeCroppedImage(image)
      return
    }
    const asset = image.closest<HTMLElement>('[data-label-element-id]')?.dataset.labelElementId
    throw new LabelOutputAssetError(`Label image${asset ? ` (${asset})` : ''} could not load. ${error instanceof Error ? error.message : ''}`)
  }
}

export async function waitForLabelFonts(roots: HTMLElement[]) {
  const fonts = document.fonts
  if (!fonts) return
  await fonts.ready
  if (typeof fonts.load !== 'function') return
  const required = new Map<string, string>()
  for (const root of roots) {
    for (const node of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      if (!Array.from(node.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) continue
      const style = getComputedStyle(node)
      const family = LABEL_FONT_FAMILIES.find(name => style.fontFamily.split(',')
        .some(value => value.trim().replace(/^["']|["']$/g, '') === name))
      if (!family) continue
      required.set(`${style.fontStyle || 'normal'} ${style.fontWeight || '400'} 16px "${family}"`, family)
    }
  }
  for (const [font, family] of required) {
    try {
      if ((await fonts.load(font)).length === 0) throw new Error('Font unavailable')
    } catch {
      throw new LabelOutputAssetError(`Label font "${family}" could not load. Reload the page before printing or exporting.`)
    }
  }
}

export async function waitForLabelOutputAssets(roots: HTMLElement[]) {
  roots.forEach(assertNoMissingAssets)
  const images = roots.flatMap(root => [
    ...(root instanceof HTMLImageElement ? [root] : []),
    ...root.querySelectorAll<HTMLImageElement>('img'),
  ])
  await Promise.all([waitForLabelFonts(roots), ...images.map(waitForImage)])
  roots.forEach(assertNoMissingAssets)
}
