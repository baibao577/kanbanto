import type { RuleCounts, RuleFilter } from '@kanbanto/model/rules'

// What the editors of a board's rules share (a limit's, and a rule's that tells people).

export const COUNTS: Record<RuleCounts, [string, string]> = {
  leaves: ['Cards without subtasks', 'A card that has subtasks isn’t counted: its subtasks are.'],
  topLevel: ['Top-level cards', 'A card’s subtasks aren’t counted by themselves. A number field adds theirs to it.'],
  all: ['Every card', 'A card and each of its subtasks are counted.'],
}

/** A filter with nothing left unsaid in it: no part that is empty or not there. */
export const tidy = (cards: RuleFilter): RuleFilter =>
  Object.fromEntries(
    Object.entries(cards).filter(([, v]) => v !== undefined && (!Array.isArray(v) || v.length) && (typeof v !== 'object' || Object.keys(v).length)),
  )
