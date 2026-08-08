/**
 * Казахстанские мобильные — это +77XXXXXXXXX. Приводим к формату,
 * который понимает wa.me: только цифры, без плюса.
 */

export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 10 && digits.startsWith("7")) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;

  return /^77\d{9}$/.test(digits) ? digits : null;
}

/** 77012345678 → +7 701 234 56 78 */
export function formatPhone(digits: string): string {
  const m = digits.match(/^7(7\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : `+${digits}`;
}

/** Вытаскивает номера из свободного текста. Маскированные («87****095») отсеиваются. */
export function extractPhones(...parts: Array<string | null | undefined>): string[] {
  const text = parts.filter(Boolean).join("\n");
  const found = new Set<string>();

  const re = /(?:\+?7|8)[\s\-()]*7\d{2}[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}/g;
  for (const match of text.match(re) ?? []) {
    const phone = normalizePhone(match);
    if (phone) found.add(phone);
  }
  return [...found];
}

export function waLink(phone: string, message: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}
