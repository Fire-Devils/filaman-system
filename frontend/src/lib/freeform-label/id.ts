/** getRandomValues also works on plain HTTP installations. */
export function createLabelElementId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}
