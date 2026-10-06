import { format, parseISO } from 'date-fns'
import { localDayOf, localTimeOf } from '@kanbanto/model/dates'

/** "Mai Chan" → "MC", "Ton" → "TO". */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase()
}

/**
 * A task date for people: day first, with the month's name, and a 24-hour time when it has one (in your time zone).
 * Short: "3 Oct", "3 Oct · 14:30". Full: "Sat 3 Oct", "Sat 3 Oct · 14:30", with the year when it isn't this year
 * ("Tue 5 Jan 2027").
 */
export function formatDay(iso: string, full = false) {
  const d = parseISO(localDayOf(iso))
  const day = format(d, full ? (d.getFullYear() === new Date().getFullYear() ? 'EEE d MMM' : 'EEE d MMM yyyy') : 'd MMM')
  const time = localTimeOf(iso)
  return time ? `${day} · ${time}` : day
}

/** The day something happened: "3 Oct", with the year when it isn't this one ("3 Oct 2025"). */
export function formatShortDay(iso: string) {
  const d = parseISO(iso)
  return format(d, d.getFullYear() === new Date().getFullYear() ? 'd MMM' : 'd MMM yyyy')
}

/** A moment something happened: "Sat 3 Oct 2026, 14:30". */
export const formatMoment = (iso: string) => format(parseISO(iso), 'EEE d MMM yyyy, HH:mm')

/** How long ago, briefly: "just now", "5m ago", "3h ago", "2d ago", then the day ("3 Oct"). */
export function formatAgo(iso: string, now = Date.now()) {
  const min = Math.floor((now - Date.parse(iso)) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ago`
  if (min < 7 * 24 * 60) return `${Math.floor(min / 1440)}d ago`
  return formatDay(iso.slice(0, 10), false)
}

/** A file size in words: 812 B, 34 KB, 2.4 MB. */
export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
