export function initializeCroppedImage(image: HTMLImageElement): boolean {
  const viewport = image.closest<HTMLElement>('[data-label-image-crop-viewport]')
  const aspectFactor = Number(image.dataset.labelImageCropAspectFactor)
  if (
    !viewport
    || !Number.isFinite(aspectFactor)
    || aspectFactor <= 0
    || image.naturalWidth <= 0
    || image.naturalHeight <= 0
  ) return false

  const cropAspect = (image.naturalWidth / image.naturalHeight) * aspectFactor
  viewport.style.setProperty('--label-image-crop-aspect', String(cropAspect))
  viewport.style.aspectRatio = String(cropAspect)
  viewport.style.visibility = 'visible'
  return true
}

function handleCroppedImageLoad(event: Event) {
  if (event.currentTarget instanceof HTMLImageElement) {
    initializeCroppedImage(event.currentTarget)
  }
}

export function prepareCroppedImage(image: HTMLImageElement): void {
  if (initializeCroppedImage(image)) return
  image.addEventListener('load', handleCroppedImageLoad, { once: true })
}

export function prepareCroppedImages(root: Element): void {
  const images = root instanceof HTMLImageElement
    ? [root]
    : Array.from(root.querySelectorAll<HTMLImageElement>(
      'img[data-label-image-crop-aspect-factor]',
    ))
  images.forEach(prepareCroppedImage)
}
