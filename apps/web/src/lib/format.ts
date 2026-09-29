import { format, parseISO } from 'date-fns'

/** "Mai Chan" → "MC", "Ton" → "TO". */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase()
}

/** "2026-10-03" → "Oct 3" (or "Oct 3, 2026"). */
export const formatDay = (iso: string, withYear = false) => format(parseISO(iso), withYear ? 'MMM d, yyyy' : 'MMM d')

/** A file size in words: 812 B, 34 KB, 2.4 MB. */
export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
