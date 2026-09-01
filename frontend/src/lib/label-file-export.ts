import { downloadDataUrl } from './label-export'

export interface LabelDownloadFile {
  name: string
  contents: string | Blob
  mimeType: string
  directUrl?: string
  zipBase64?: boolean
}

export interface LabelDownloadOptions {
  forceArchive?: boolean
}

function scheduleObjectUrlCleanup(url: string) {
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

function uniqueArchiveName(
  requestedName: string,
  usedNames: Set<string>,
) {
  if (!usedNames.has(requestedName)) {
    usedNames.add(requestedName)
    return requestedName
  }

  const extensionIndex = requestedName.lastIndexOf('.')
  const hasExtension = extensionIndex > 0
  const base = hasExtension
    ? requestedName.slice(0, extensionIndex)
    : requestedName
  const extension = hasExtension
    ? requestedName.slice(extensionIndex)
    : ''
  let suffix = 1
  let candidate = ''
  do {
    candidate = `${base}-${String(suffix).padStart(2, '0')}${extension}`
    suffix += 1
  } while (usedNames.has(candidate))
  usedNames.add(candidate)
  return candidate
}

export async function downloadLabelFiles(
  files: LabelDownloadFile[],
  archiveName: string,
  options: LabelDownloadOptions = {},
) {
  if (files.length === 0) return

  if (files.length === 1 && !options.forceArchive) {
    const [file] = files
    if (file.directUrl) {
      downloadDataUrl(file.directUrl, file.name)
      return
    }
    const contents = file.contents instanceof Blob
      ? file.contents
      : new Blob([file.contents], { type: file.mimeType })
    const url = URL.createObjectURL(contents)
    downloadDataUrl(url, file.name)
    scheduleObjectUrlCleanup(url)
    return
  }

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  const usedNames = new Set<string>()
  files.forEach(file => {
    zip.file(
      uniqueArchiveName(file.name, usedNames),
      file.contents,
      file.zipBase64 ? { base64: true } : undefined,
    )
  })
  const url = URL.createObjectURL(
    await zip.generateAsync({ type: 'blob' }),
  )
  downloadDataUrl(url, archiveName)
  scheduleObjectUrlCleanup(url)
}
