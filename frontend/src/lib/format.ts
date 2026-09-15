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
    if (typeof data.rfid_display_colons === 'boolean') {
      localStorage.setItem('rfid_display_colons', String(data.rfid_display_colons));
    }
    return data.currency || 'EUR';
  } catch {
    return getCurrency();
  }
}

export function formatRfidUid(value: string | null | undefined): string {
  if (!value) return '';
  const compact = value.trim().replace(/[\s:-]/g, '');
  if (!compact || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact)) {
    return value;
  }
  const upper = compact.toUpperCase();
  const showColons = localStorage.getItem('rfid_display_colons') === 'true';
  return showColons ? upper.match(/.{2}/g)!.join(':') : upper;
}

export async function initRfidDisplayFormat(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/app-settings/public-info');
    const data = await res.json();
    const showColons = data.rfid_display_colons === true;
    localStorage.setItem('rfid_display_colons', String(showColons));
    return showColons;
  } catch {
    return localStorage.getItem('rfid_display_colons') === 'true';
  }
}
