import { useMemo, useSyncExternalStore } from 'react'

// Sections of a description folded away, while it is read and while it is written: everything under a heading, down
// to the next heading of its size. Nothing is saved in the text for it. Which sections are folded is this person's
// own, kept in this browser for each card, by what the heading says (so a fold stays on its section when the text
// around it changes, and the same section is folded in the card, on its full page, and in the editor: see
// foldEditing.ts).

const PREFIX = 'kankan:folds:'
const EMPTY: ReadonlySet<string> = new Set()
const kept = new Map<string, ReadonlySet<string>>()
const watchers = new Set<() => void>()

const read = (key: string): ReadonlySet<string> => {
  let set = kept.get(key)
  if (set) return set
  set = EMPTY
  try {
    const raw = localStorage.getItem(PREFIX + key)
    const list: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(list)) set = new Set(list.filter((s): s is string => typeof s === 'string'))
  } catch {
    // (No storage, or something else's: nothing is folded.)
  }
  kept.set(key, set)
  return set
}
const write = (key: string, set: ReadonlySet<string>) => {
  kept.set(key, set)
  try {
    if (set.size) localStorage.setItem(PREFIX + key, JSON.stringify([...set]))
    else localStorage.removeItem(PREFIX + key)
  } catch {
    // (Kept for as long as the page is open, then.)
  }
  for (const w of watchers) w()
}
const watch = (w: () => void) => {
  watchers.add(w)
  return () => void watchers.delete(w)
}

/** What is folded for a card: what each folded heading says, as a slug (see `headingsOf`). */
export const foldsOf = (key: string) => read(key)
/** Folds or unfolds the section whose heading says this. */
export function toggleFold(key: string, slug: string) {
  const next = new Set(read(key))
  if (!next.delete(slug)) next.add(slug)
  write(key, next)
}
/** Unfolds these sections. */
export function openFolds(key: string, slugs: string[]) {
  const now = read(key)
  if (slugs.some((s) => now.has(s))) write(key, new Set([...now].filter((s) => !slugs.includes(s))))
}
/** A folded heading says something else now (it was retyped): its section stays folded. */
export function renameFold(key: string, from: string, to: string) {
  const now = read(key)
  if (from !== to && now.has(from)) write(key, new Set([...now].map((s) => (s === from ? to : s))))
}
/** Told whenever what is folded changes, for any card. */
export const watchFolds = watch

export interface Folds {
  /** Which headings are folded, by their number among the text's headings. */
  folded: ReadonlySet<number>
  toggle: (heading: number) => void
  /** Unfolds these headings (to show something that is under them). */
  open: (headings: number[]) => void
}

/** The folds of a card's description (`key`: the card), for a text with these headings. Without a key: none. */
export function useFolds(key: string | undefined, headings: { slug: string }[]): Folds {
  const slugs = useSyncExternalStore(watch, () => (key ? read(key) : EMPTY))
  return useMemo(() => {
    const change = (list: number[], fold: (slug: string, next: Set<string>) => void) => {
      if (!key) return
      const next = new Set(read(key))
      for (const i of list) if (headings[i]) fold(headings[i].slug, next)
      write(key, next)
    }
    return {
      folded: new Set(headings.flatMap((h, i) => (slugs.has(h.slug) ? [i] : []))),
      toggle: (i) => change([i], (slug, next) => void (next.has(slug) ? next.delete(slug) : next.add(slug))),
      open: (list) => list.length && change(list, (slug, next) => void next.delete(slug)),
    }
  }, [key, slugs, headings])
}

/** The folded headings that something on the page is put away under (none: it is in view). */
export const foldsOver = (el: Element | null | undefined): number[] =>
  (el?.closest('[data-folds]')?.getAttribute('data-folds') ?? '').split(' ').filter(Boolean).map(Number)
