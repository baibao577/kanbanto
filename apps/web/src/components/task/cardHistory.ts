import type { CardHistoryEntry } from '@kanbanto/model/api'

/** Changes by one person, through one app, within this long of each other read as one thing they did. */
const TOGETHER_MS = 10 * 60_000

/** A run of changes to a card that belong together: one person, one app, minutes apart. */
export interface Stretch {
  key: string
  actor: CardHistoryEntry['actor']
  via: string | null
  /** When the last of it happened, and the first (what the next, older change is measured against). */
  at: string
  oldest: string
  /** What they did, in the order they did it. */
  lines: CardHistoryEntry['lines']
}

/**
 * A card's history (newest first) as stretches (newest first): someone tidying a card changes five things in a
 * minute, and that reads as one visit, not five lines with the same name and time.
 */
export function stretches(entries: CardHistoryEntry[]): Stretch[] {
  const out: Stretch[] = []
  for (const e of entries) {
    const last = out.at(-1)
    if (last && last.actor?.id === e.actor?.id && last.via === e.via && Date.parse(last.oldest) - Date.parse(e.at) <= TOGETHER_MS) {
      last.lines = [...e.lines, ...last.lines]
      last.oldest = e.at
    } else out.push({ key: e.at, actor: e.actor, via: e.via, at: e.at, oldest: e.at, lines: e.lines })
  }
  return out
}
