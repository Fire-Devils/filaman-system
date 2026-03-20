export function formatPrice(value: number | null | undefined, currency: string): string {
  if (value == null) return '–';
  const lang = localStorage.getItem('lang') || 'en';
  const locale = lang === 'de' ? 'de-DE' : 'en-US';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}

export function getCurrency(): string {
  return localStorage.getItem('currency') || 'EUR';
}

export async function initCurrency(): Promise<string> {
  try {
    const res = await fetch('/api/v1/app-settings/public-info');
    const data = await res.json();
    if (data.currency) localStorage.setItem('currency', data.currency);
    return data.currency || 'EUR';
  } catch {
    return getCurrency();
  }
}
