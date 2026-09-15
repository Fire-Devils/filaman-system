export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall back for HTTP deployments and denied clipboard permissions.
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()

  try {
    const execCommand = (document as unknown as { execCommand?: (command: string) => boolean })
      .execCommand
    return execCommand?.call(document, 'copy') ?? false
  } finally {
    textarea.remove()
  }
}
