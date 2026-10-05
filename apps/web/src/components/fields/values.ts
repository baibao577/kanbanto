import type { FieldDef } from '@kanbanto/model/fields'

/**
 * Where a text value leads when it's shown as a link, an email or a phone number: something safe to open, or null
 * when the text isn't one (it's then just text).
 */
export function linkOf(field: Pick<FieldDef, 'format'>, value: string): string | null {
  const v = value.trim()
  if (field.format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? `mailto:${v}` : null
  if (field.format === 'phone') return /^[+(]?\d[\d\s().-]{2,}$/.test(v) ? `tel:${v.replace(/[^\d+]/g, '')}` : null
  if (field.format !== 'link') return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`)
    // (Only web addresses: never something that would run or open an app.)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.') ? url.href : null
  } catch {
    return null
  }
}
