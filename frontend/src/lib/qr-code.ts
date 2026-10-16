/* eslint-disable @typescript-eslint/no-explicit-any */

const QR_SCRIPT_SELECTOR = 'script[data-filaman-qrcode]'

let qrCodeLoadPromise: Promise<void> | null = null

export function getQrCodeConstructor() {
  return (window as any).QRCode
}

export function buildQrUrl(
  linkMode: 'spool' | 'url',
  templateBase: string,
  entityId: string | number,
  entityPath: 'spools' | 'filaments',
) {
  if (linkMode === 'url' && templateBase.trim()) {
    try {
      const url = new URL(templateBase.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol')
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}/${entityPath}/${encodeURIComponent(String(entityId))}`
    } catch {
      // Use the current FilaMan origin below.
    }
  }
  return `${window.location.origin}/${entityPath}/${encodeURIComponent(String(entityId))}`
}

export async function ensureQrCodeLoaded() {
  if (getQrCodeConstructor()) return
  if (qrCodeLoadPromise) return qrCodeLoadPromise

  qrCodeLoadPromise = new Promise<void>((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(QR_SCRIPT_SELECTOR)

    if (script && script.dataset.filamanQrcodeState !== 'loading') {
      script.remove()
      script = null
    }

    if (!script) {
      script = document.createElement('script')
      script.src = '/vendor/qrcode.min.js'
      script.dataset.filamanQrcode = 'true'
      script.dataset.filamanQrcodeState = 'loading'
      document.head.appendChild(script)
    }

    const cleanup = () => {
      script?.removeEventListener('load', onLoad)
      script?.removeEventListener('error', onError)
    }
    const onLoad = () => {
      cleanup()
      if (!script) return
      script.dataset.filamanQrcodeState = 'ready'
      if (getQrCodeConstructor()) {
        resolve()
      } else {
        script.remove()
        reject(new Error('QRCode script loaded without exposing QRCode'))
      }
    }
    const onError = () => {
      cleanup()
      script?.remove()
      reject(new Error('Failed to load QRCode'))
    }

    script.addEventListener('load', onLoad, { once: true })
    script.addEventListener('error', onError, { once: true })
  }).finally(() => {
    qrCodeLoadPromise = null
  })

  return qrCodeLoadPromise
}

export function canvasToQrImage(canvas: HTMLCanvasElement) {
  const img = document.createElement('img')
  img.src = canvas.toDataURL('image/png')
  img.style.width = '100%'
  img.style.height = '100%'
  img.style.display = 'block'
  img.style.imageRendering = 'auto'
  return img
}
