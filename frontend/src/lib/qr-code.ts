/* eslint-disable @typescript-eslint/no-explicit-any */

const QR_SCRIPT_SELECTOR = 'script[data-filaman-qrcode]'

let qrCodeLoadPromise: Promise<void> | null = null
let qrBrandLogo: HTMLImageElement | null = null
let qrBrandLogoPromise: Promise<HTMLImageElement | null> | null = null

export function getQrCodeConstructor() {
  return (window as any).QRCode
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

export function canvasToQrImage(canvas: HTMLCanvasElement, preferCrisp = false) {
  const img = document.createElement('img')
  img.src = canvas.toDataURL('image/png')
  img.style.width = '100%'
  img.style.height = '100%'
  img.style.display = 'block'
  img.style.imageRendering = preferCrisp ? 'pixelated' : 'auto'
  return img
}

async function loadQrBrandLogo(): Promise<HTMLImageElement | null> {
  if (qrBrandLogo) return qrBrandLogo
  if (qrBrandLogoPromise) return qrBrandLogoPromise
  qrBrandLogoPromise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      qrBrandLogo = img
      resolve(img)
    }
    img.onerror = () => resolve(null)
    img.src = window.location.origin + '/logo-qr.png'
  }).finally(() => {
    qrBrandLogoPromise = null
  })
  return qrBrandLogoPromise
}

export async function decorateQrCenter(canvas: HTMLCanvasElement, qrPx: number, colorLogo: boolean) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  if (document.fonts?.ready) await document.fonts.ready

  const cx = qrPx / 2
  const cy = qrPx / 2
  const clearPad = Math.max(colorLogo ? 3 : 6, Math.round(qrPx * (colorLogo ? 0.014 : 0.03)))
  const maxMarkW = Math.round(qrPx * (colorLogo ? 0.32 : 0.34))
  const maxMarkH = Math.round(qrPx * 0.24)
  const fillClearRect = (markW: number, markH: number, padX = clearPad, padY = clearPad) => {
    const clearW = Math.round(markW + padX * 2)
    const clearH = Math.round(markH + padY * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(cx - clearW / 2, cy - clearH / 2, clearW, clearH)
  }

  if (colorLogo) {
    const logoImg = await loadQrBrandLogo()
    if (logoImg) {
      const ar = logoImg.naturalWidth > 0 && logoImg.naturalHeight > 0
        ? logoImg.naturalWidth / logoImg.naturalHeight
        : 1
      let drawW = maxMarkW
      let drawH = Math.round(drawW / ar)
      if (drawH > maxMarkH) {
        drawH = maxMarkH
        drawW = Math.round(drawH * ar)
      }
      fillClearRect(drawW, drawH)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(logoImg, cx - drawW / 2, cy - drawH / 2, drawW, drawH)
      return
    }
  }

  const fontSize = Math.max(18, Math.round(qrPx * 0.11))
  ctx.font = `700 ${fontSize}px "Space Grotesk", sans-serif`
  ;(ctx as CanvasRenderingContext2D & { textRendering?: string }).textRendering = 'geometricPrecision'
  const measured = ctx.measureText('FilaMan')
  const textW = Math.min(maxMarkW, Math.ceil(measured.width))
  const textH = Math.min(maxMarkH, Math.ceil(fontSize * 0.9))
  const textPad = clearPad + Math.max(3, Math.round(qrPx * 0.015))
  fillClearRect(textW, textH, textPad, textPad)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#000000'
  ctx.fillText('FilaMan', cx, cy)
}
