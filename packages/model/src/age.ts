import type { TaskIndex } from './indexer'

const DAY = 86_400_000

/**
 * Card age: when a card last saw real work, in ms. That's its own moves and edits, its subtasks' (the index rolls
 * them up) and its latest comment. Reordering, and a parent's list changing because its subtasks moved, don't count.
 */
export function lastActivity(idx: TaskIndex, id: string, lastComment?: Record<string, string>): number {
  const own = idx.lastActive.get(id) ?? 0
  const c = lastComment?.[id]
  return c ? Math.max(own, Date.parse(c) || 0) : own
}

/** Whole days since then. */
export const idleDays = (at: number, now = Date.now()) => Math.max(0, Math.floor((now - at) / DAY))

/** The age chip: only once a card has sat for a few days; amber from a week, red from two. */
export const AGE_SHOWN = 3
export const ageTone = (days: number): 'quiet' | 'warn' | 'alert' => (days >= 14 ? 'alert' : days >= 7 ? 'warn' : 'quiet')
