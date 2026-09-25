export function formatDesignerNumber(value: number, decimals = 2): string {
  return String(Number(value.toFixed(decimals)))
}
