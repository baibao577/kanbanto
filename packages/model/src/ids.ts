/**
 * New ids are UUIDv7: 128 bits (no realistic chance of two tasks sharing an id), and they start with the
 * creation time, so they sort by age and index well in a database.
 * Older boards keep their shorter ids; ids are opaque strings everywhere.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // 48-bit big-endian millisecond timestamp
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const newId = () => uuidv7()
