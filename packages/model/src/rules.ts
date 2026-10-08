import { ME, numberText, type CarryOn, type FieldDef, type FieldFilter, type FieldMap } from './fields'
import { isLeaf, type TaskIndex } from './indexer'
import { DEFAULT_DISPLAY, remapPreset } from './prefs'
import { filterChips, matchesFilter, type TableFilter } from './table'
import { numberOf, sumOf, totalUnder } from './totals'
import type { BoardData, LabelDef, StatusMode } from './types'

// A board's rules: things the board says about its cards, the same to everyone on it.
//
// The first kind is a limit: "at most 3 cards in Doing", "at most 40 hours of Estimate in This week", "at most 2
// cards for each person in Review". A limit is worked out from the board as it is (nothing is stored but the rule),
// by every screen and by the server in the same way, and nothing is refused: it is shown.
//
// What a rule is about is a card set (which cards, said the way the Filter menu says it, and which of them count
// where cards nest), read through one function, `cardsOf`. That is the piece other kinds of rule are meant to
// reuse: a check on each card of a set, or "when a card starts matching these cards, tell these people" (asked of
// the board before and after a change). What a rule does is a list (`then`), with one entry today.

/** Where cards nest, the ones a rule counts: the cards without subtasks, the top-level cards, or every card. */
export const RULE_COUNTS = ['leaves', 'topLevel', 'all'] as const
export type RuleCounts = (typeof RULE_COUNTS)[number]

/** How many rules a board can have. */
export const MAX_RULES = 20

/**
 * The conditions a rule can put on its cards: the Filter menu's, less the ones that would say something different
 * to different people or on different days ("me", dates, days without activity). A rule says the same to everyone.
 */
export type RuleFilter = Pick<TableFilter, 'statuses' | 'assignees' | 'labels' | 'priorities' | 'fields'>

/** A group of cards a rule is about. */
export interface CardSet {
  cards: RuleFilter
  counts: RuleCounts
}

/** What a rule does when it is passed. Only shown on the board, for now (later: tell people). */
export type RuleThen = { do: 'show' }

/** A limit: at most (or at least) this much of these cards. */
export interface LimitRule extends CardSet {
  id: string
  kind: 'limit'
  /** What its owner calls it ("Roofing crew", "No deposit, no start"): said with its numbers where it shows. */
  name?: string
  /** What is added up: the cards themselves, or a number field of the board (a card without a value adds nothing). */
  measure: { by: 'cards' } | { by: 'field'; field: string }
  /** Each person is held to the limit by themselves (by who a card is assigned to). Unset: the whole group. */
  per?: 'person'
  max?: number
  min?: number
  then: RuleThen[]
}

/** A rule of a board. (One kind today; a kind this version doesn't know is dropped when a board is read.) */
export type BoardRule = LimitRule

/** Which cards count on a board before anyone says otherwise: what its lists show (see `defaultDisplay`). */
export const countsFor = (mode: StatusMode): RuleCounts => (mode === 'manual' ? 'topLevel' : 'leaves')

/** A limit on one list, as the list's menu starts it. */
export const limitOn = (id: string, listId: string, mode: StatusMode, max: number): LimitRule => ({
  id,
  kind: 'limit',
  cards: { statuses: [listId] },
  counts: countsFor(mode),
  measure: { by: 'cards' },
  max,
  then: [{ do: 'show' }],
})

/** Does a rule ask more of its cards than which lists they're in? */
export const hasConditions = (rule: CardSet) => Object.entries(rule.cards).some(([key, v]) => key !== 'statuses' && v !== undefined)

/**
 * A plain count: so many cards of a list (or for each person), nothing added up and no other condition. Short enough
 * to sit beside a list's name ("4 / 3"); every other limit needs words with its numbers (see `shortName`).
 */
export const isPlainCount = (rule: BoardRule) => rule.measure.by === 'cards' && !hasConditions(rule) && !rule.name

/** The one list a rule is about, when it is about exactly one (it then shows on that list). */
export const listOf = (rule: CardSet): string | null => (rule.cards.statuses?.length === 1 ? rule.cards.statuses[0] : null)

const FIELD_PARTS_WITH_PEOPLE = ['in', 'notIn'] as const satisfies readonly (keyof FieldFilter)[]

/**
 * Why a rule can't be worked out on this board, in words, or null when it can: it names a list, a label, a person
 * or a field the board doesn't have (any more), or asks for something a rule can't. Such a rule is never worked out
 * with what's left of it: a condition that is dropped makes a limit wider, without a word.
 */
export function ruleProblem(idx: TaskIndex, rule: BoardRule, labels: readonly LabelDef[]): string | null {
  const c = rule.cards
  for (const key of Object.keys(c))
    if (!['statuses', 'assignees', 'labels', 'priorities', 'fields'].includes(key)) return 'It asks for something a rule can’t.'
  if (c.statuses?.some((id) => !idx.colById.has(id))) return c.statuses.length === 1 ? 'Its list is gone.' : 'One of its lists is gone.'
  if (c.assignees?.includes(ME)) return 'A rule can’t be about “me”.'
  if (c.assignees?.some((id) => id && !idx.members.has(id))) return 'Someone it names is no longer on the board.'
  if (c.labels?.some((id) => !labels.some((l) => l.id === id))) return 'A label it names is gone.'
  for (const [fieldId, wanted] of Object.entries(c.fields ?? {})) {
    const def = idx.fields.get(fieldId)
    if (!def) return 'A field it names is no longer on the board.'
    if (def.type === 'date') return 'A rule can’t be about a date.'
    if (FIELD_PARTS_WITH_PEOPLE.some((part) => wanted[part]?.includes(ME))) return 'A rule can’t be about “me”.'
  }
  if (rule.measure.by === 'field') {
    const def = idx.fields.get(rule.measure.field)
    if (!def) return 'The field it adds up is no longer on the board.'
    if (def.type !== 'number') return 'The field it adds up isn’t a number.'
  }
  if (rule.max === undefined && rule.min === undefined) return 'It has no number.'
  return null
}

/**
 * The cards of a set, as the board is: the ones that count (see RuleCounts), then the conditions. Nothing about
 * who is looking goes in, so the answer is everyone's. (Archived cards are never among a board's cards.)
 */
export function cardsOf(idx: TaskIndex, set: CardSet): string[] {
  const base = set.counts === 'all' ? idx.preorder : set.counts === 'topLevel' ? idx.roots : idx.preorder.filter((id) => isLeaf(idx, id))
  return base.filter((id) => matchesFilter(idx, id, set.cards))
}

/** Where a limit stands: with room, at its number (for a field: within a tenth of it), past it, or short of its least. */
export type LimitStanding = 'ok' | 'near' | 'over' | 'under'

export interface LimitGroup {
  /** Whose it is, when the limit is for each person. '' for the whole group. */
  person: string
  value: number
  standing: LimitStanding
}

export interface RuleState {
  rule: BoardRule
  /** Why it isn't worked out (see `ruleProblem`). Then there are no groups. */
  problem?: string
  /** One for the whole group, or one for each person who has any of the cards (most first). */
  groups: LimitGroup[]
  /** The worst of its groups. */
  standing: LimitStanding
}

const WORST: LimitStanding[] = ['ok', 'under', 'near', 'over']

function standingOf(rule: LimitRule, value: number): LimitStanding {
  if (rule.max !== undefined) {
    if (value > rule.max) return 'over'
    // (A count is "near" at the number itself: full. A sum, which rarely lands on it, from nine tenths.)
    if (rule.measure.by === 'cards' ? value === rule.max : value >= rule.max * 0.9) return 'near'
  }
  if (rule.min !== undefined && value < rule.min) return 'under'
  return 'ok'
}

/** Works a rule out on the board as it is. */
export function evaluateRule(idx: TaskIndex, rule: BoardRule, labels: readonly LabelDef[]): RuleState {
  const problem = ruleProblem(idx, rule, labels)
  if (problem) return { rule, problem, groups: [], standing: 'ok' }
  const ids = cardsOf(idx, rule)
  const def = rule.measure.by === 'field' ? idx.fields.get(rule.measure.field)! : null
  // A number counts once: on the card that holds it, or, where only the top-level cards count, with its subtasks'
  // (the way a list's totals are added up).
  const amount = (id: string) => (!def ? 1 : ((rule.counts === 'topLevel' ? totalUnder(idx, def, id) : numberOf(idx, id, def.id)) ?? 0))
  const total = (of: string[]) => (def ? sumOf(def, of.map(amount)) : of.length)
  let groups: LimitGroup[]
  if (rule.per === 'person') {
    const by = new Map<string, string[]>()
    for (const id of ids) {
      const who = idx.tasks[id].assigneeId
      // (A card nobody has isn't anybody's load; nor is one of someone who left the board.)
      if (!who || !idx.members.has(who)) continue
      by.set(who, [...(by.get(who) ?? []), id])
    }
    groups = [...by].map(([person, of]) => ({ person, value: total(of) })).map((g) => ({ ...g, standing: standingOf(rule, g.value) }))
    groups.sort((a, b) => b.value - a.value || (idx.members.get(a.person)!.name < idx.members.get(b.person)!.name ? -1 : 1))
  } else {
    const value = total(ids)
    groups = [{ person: '', value, standing: standingOf(rule, value) }]
  }
  const standing = groups.reduce<LimitStanding>((worst, g) => (WORST.indexOf(g.standing) > WORST.indexOf(worst) ? g.standing : worst), 'ok')
  return { rule, groups, standing }
}

const NONE: RuleState[] = []
const worked = new WeakMap<TaskIndex, { rules: readonly BoardRule[]; labels: readonly LabelDef[]; states: RuleState[] }>()

/**
 * Every rule of a board worked out, once for each version of the board (its index is made anew when it changes, and
 * so are the lists of its rules and labels when they do). `idx` is the board's own index (`indexFor(data)`).
 */
export function evaluateRules(idx: TaskIndex, data: Pick<BoardData, 'rules' | 'labels'>): RuleState[] {
  const { rules, labels } = data
  if (!rules?.length) return NONE
  const hit = worked.get(idx)
  if (hit && hit.rules === rules && hit.labels === labels) return hit.states
  const states = rules.map((r) => evaluateRule(idx, r, labels))
  worked.set(idx, { rules, labels, states })
  return states
}

/** A value as a limit shows it: a count as it is, a field's number the way the field writes it ("38 h"). */
export function amountText(def: Pick<FieldDef, 'unit' | 'decimals'> | null | undefined, n: number): string {
  return def ? numberText(def, n) : String(n)
}

/**
 * A rule in words: "At most 3 cards in Doing", "At most 40 h of Estimate in This week", "At most 2 cards for each
 * person in Review or Your review where Priority is Urgent". Names that are gone are left out: ask `ruleProblem`
 * first when that matters.
 */
export function describeRule(rule: BoardRule, data: Pick<BoardData, 'columns' | 'labels' | 'members' | 'fields'>): string {
  const def = rule.measure.by === 'field' ? data.fields.find((f) => f.id === (rule.measure as { field: string }).field) : null
  const amount = (n: number) =>
    rule.measure.by === 'cards' ? `${n} ${n === 1 ? 'card' : 'cards'}` : `${amountText(def, n)} of ${def?.name ?? 'a field'}`
  const number =
    rule.max !== undefined && rule.min !== undefined
      ? `Between ${amountText(def, rule.min)} and ${amount(rule.max)}`
      : rule.max !== undefined
        ? `At most ${amount(rule.max)}`
        : `At least ${amount(rule.min ?? 0)}`
  const lists = (rule.cards.statuses ?? []).map((id) => data.columns.find((c) => c.id === id)?.name).filter(Boolean)
  const where = lists.length ? `in ${lists.length > 1 ? `${lists.slice(0, -1).join(', ')} or ${lists.at(-1)}` : lists[0]}` : 'on the board'
  const { statuses: _lists, labels, ...rest } = rule.cards
  // (A label that's gone has no name to say; the others' missing names are left out by `filterChips` itself.)
  const named = labels?.filter((id) => data.labels.some((l) => l.id === id))
  const conditions = filterChips({ ...rest, ...(named?.length && { labels: named }) }, data.columns, data.labels, data.members, data.fields)
    .filter((c) => c.value)
    .map((c) => `${c.label.replace(/:$/, '')} is ${c.value}`)
  return [number, rule.per === 'person' ? 'for each person' : '', where, conditions.length ? `where ${conditions.join(' and ')}` : '']
    .filter(Boolean)
    .join(' ')
}

/**
 * A few words for a rule, to say with its numbers where there's little room: the name its owner gave it, else the
 * field it adds up and what its conditions pick ("Crew hours", "Roofing", "Deposit paid: No"). Empty for a plain count.
 */
export function shortName(rule: BoardRule, data: Pick<BoardData, 'columns' | 'labels' | 'members' | 'fields'>): string {
  if (rule.name) return rule.name
  const added = rule.measure.by === 'field' ? data.fields.find((f) => f.id === (rule.measure as { field: string }).field)?.name : undefined
  const { statuses: _lists, labels, ...rest } = rule.cards
  const named = labels?.filter((id) => data.labels.some((l) => l.id === id))
  const picked = filterChips({ ...rest, ...(named?.length && { labels: named }) }, data.columns, data.labels, data.members, data.fields)
    .filter((c) => c.value)
    // (What a choice, a label or a person picks says enough by itself; a tick or a number needs its field's name.)
    .map((c) => {
      const kind = c.field ? data.fields.find((f) => f.id === c.field)?.type : null
      return kind === null || kind === 'choice' || kind === 'person' ? c.value : `${c.label} ${c.value}`
    })
  return [added, ...picked].filter(Boolean).join(', ')
}

/**
 * A rule carried over to other fields by `map` (two fields merged into one; a board moving to another library of
 * fields; a board read from a file), the way a saved filter is (`remapPreset`): the field it adds up, the fields its
 * conditions name, and what those conditions pick (a choice's options, linked cards, people). `others`: the fields
 * the map doesn't name stay as they are, or have no place where the rule is going.
 *
 * Null when it can't be carried whole: a field of it has no place there, or a condition would lose what it picks.
 * A saved filter is carried without such a part; a rule isn't, because a limit with a condition missing is a wider
 * limit, and nobody would be told.
 */
export function remapRule(rule: BoardRule, map: FieldMap, others: 'keep' | 'drop', on?: CarryOn): BoardRule | null {
  let measure = rule.measure
  if (measure.by === 'field') {
    const to = map.get(measure.field)?.id ?? (others === 'keep' ? measure.field : null)
    if (!to) return null
    measure = { by: 'field', field: to }
  }
  const asked = rule.cards.fields
  if (!asked) return measure === rule.measure ? rule : { ...rule, measure }
  const carried = remapPreset({ filter: { fields: asked }, display: DEFAULT_DISPLAY, outline: {} }, map, others, on).filter.fields ?? {}
  const whole =
    Object.keys(carried).length === Object.keys(asked).length &&
    Object.values(carried).every((f) => Object.keys(f).length) &&
    // (Every list of picks is still as long: none of what it named was left behind.)
    [...Object.values(asked)]
      .map((f) => [f.in?.length ?? 0, f.notIn?.length ?? 0].join())
      .sort()
      .join('|') ===
      [...Object.values(carried)]
        .map((f) => [f.in?.length ?? 0, f.notIn?.length ?? 0].join())
        .sort()
        .join('|')
  return whole ? { ...rule, measure, cards: { ...rule.cards, fields: carried } } : null
}

/** Does a rule name people (who aren't carried along when a board is copied into a file and read elsewhere)? */
export const namesPeople = (rule: BoardRule, isPersonField: (fieldId: string) => boolean) =>
  !!rule.cards.assignees?.some(Boolean) || Object.keys(rule.cards.fields ?? {}).some(isPersonField)
