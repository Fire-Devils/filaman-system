import type { SvgAsset } from './types'

const cache = new Map<string, { pending: Promise<SvgAsset>; bytes: number }>()
let cachedBytes = 0

function remove(key: string) {
  cachedBytes -= cache.get(key)?.bytes ?? 0
  cache.delete(key)
}

function trim() {
  while (cache.size > 16 || cachedBytes > 16 * 1024 * 1024) remove(cache.keys().next().value!)
}

export function clearPreparedImages() {
  cache.clear()
  cachedBytes = 0
}

export async function loadPreparedImage(source: string): Promise<SvgAsset> {
  const url = new URL(source, location.href)
  if (url.protocol === 'data:') {
    if (!/^data:image\/(png|jpeg);base64,/i.test(source) || source.length > 7 * 1024 * 1024) throw new Error('Unsupported label image')
    source = source.replace(/^data:image\/(png|jpeg);base64,/i, header => header.toLowerCase())
  } else if (url.origin !== location.origin || !['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error('Label image must be same-origin')
  const stable = ['data:', 'blob:'].includes(url.protocol) || url.pathname === '/logo-qr.png'
    || /^\/api\/v1\/me\/label-assets\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/content$/i.test(url.pathname)
  if (!stable) return prepareImage(source, url)
  const key = url.href
  const cached = cache.get(key)
  if (cached) return cached.pending
  const entry = { pending: prepareImage(source, url), bytes: key.length * 2 }
  cache.set(key, entry)
  cachedBytes += entry.bytes
  trim()
  try {
    const image = await entry.pending
    if (cache.get(key) === entry) {
      const bytes = image.dataUrl.length * 2
      entry.bytes += bytes
      cachedBytes += bytes
      trim()
    }
    return image
  } catch (error) {
    if (cache.get(key) === entry) remove(key)
    throw error
  }
}

async function prepareImage(source: string, url: URL): Promise<SvgAsset> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('Label image could not load')
  const blob = await response.blob()
  if (!['image/png', 'image/jpeg'].includes(blob.type) || blob.size > 5 * 1024 * 1024) throw new Error('Unsupported label image')
  const bitmap = await createImageBitmap(blob)
  try {
    if (bitmap.width * bitmap.height > 12000000) throw new Error('Label image exceeds pixel budget')
    const dataUrl = url.protocol === 'data:' ? source : await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('Label image could not load'))
      reader.readAsDataURL(blob)
    })
    return { dataUrl, width: bitmap.width, height: bitmap.height }
  } finally { bitmap.close() }
}
