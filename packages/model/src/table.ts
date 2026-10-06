import {
  dateMatches,
  dateTestFromText,
  dateTestText,
  dateTestToText,
  hasTime,
  isPast,
  sortTime,
  tidyDateTest,
  todayDay,
  toDay,
  type DateTest,
} from './dates'
import { idleDays, lastActivity } from './age'
import {
  fieldIdOf,
  fieldMatches,
  filterText,
  isFieldKey,
  ME,
  type FieldDef,
  type FieldFilter,
  type FieldKey,
  linksOf,
  type MatchContext,
  peopleOf,
  type TitleOf,
} from './fields'
import type { TaskIndex } from './indexer'
import { subtreeSums } from './totals'
import { PRIORITIES, PRIORITY_LABEL, type LabelDef, type Member, type Priority, type StatusColumn } from './types'

/** What every card has that the Outline can sort by. */
export const BUILT_IN_SORT_KEYS = ['title', 'status', 'progress', 'assignee', 'priority', 'start', 'due', 'labels'] as const
export type BuiltInSortKey = (typeof BUILT_IN_SORT_KEYS)[number]
/** Columns the Outline table can sort by: those, and each of the board's own fields ("f:" and its id). */
export type SortKey = BuiltInSortKey | FieldKey
export interface Sort {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** Outline filters: AND across properties, OR within one (e.g. status is To Do or Doing). */
export interface TableFilter {
  /** Status list ids. */
  statuses?: string[]
  /** Member ids; '' means "no one assigned", and "me" whoever is looking (so a saved filter can be everyone's "Mine"). */
  assignees?: string[]
  /** Label ids (any of them). */
  labels?: string[]
  /** '' means "no priority". */
  priorities?: (Priority | '')[]
  /** Overdue, due in the next 7 days, or no due date. Any other test of the due date is `dueIs`; only one of the two is set. */
  due?: 'overdue' | 'week' | 'none'
  dueIs?: DateTest
  /** A test of the start date. */
  startIs?: DateTest
  /** Only cards with activity in the last this many days (see age.ts); done ones too. */
  changed?: number
  /** Only cards not done with no activity for at least this many days (see age.ts). */
  idle?: number
  /** By the board's own fields, by field id: what each value has to be (see FieldFilter). Unset when there are none. */
  fields?: Record<string, FieldFilter>
}

/** The Outline's own settings (filters are shared by every tab; see State.filter). */
/** The Outline's property columns (Task is always there). */
export const OUTLINE_COLUMNS = ['status', 'progress', 'assignee', 'priority', 'start', 'due', 'labels'] as const
export type OutlineColumn = (typeof OUTLINE_COLUMNS)[number]

export interface OutlineConfig {
  sort?: Sort
  /** Property columns switched off (Display → Columns): built-in ones, and the board's fields by their key (kept sorted). */
  hidden?: (OutlineColumn | FieldKey)[]
  /** None of the board's own fields as columns. */
  hideFields?: boolean
  /** Row height: compact (the default) or comfortable. */
  density?: 'comfortable' | 'compact'
  /** Leave finished tasks out (the Outline and the Timeline both follow this). */
  hideDone?: boolean
  /**
   * The columns after Task as last arranged, hidden ones included (they keep their place). Unset while they are in
   * the order they come in: the built-in ones, then the board's fields. See `arrangeColumns`.
   */
  order?: ColumnKey[]
}

/** A column of the Outline other than Task: a built-in one, or one of the board's fields by its key. */
export type ColumnKey = OutlineColumn | FieldKey

/**
 * The columns in the order to show them: `all` is every column there is now, in the order they come in; `order` is
 * how someone arranged them. Columns the arrangement doesn't name (a field added since) go after it, and names it
 * has that are gone are skipped.
 */
export function arrangeColumns<K extends string>(all: K[], order?: readonly string[]): K[] {
  if (!order?.length) return all
  const there = new Set<string>(all)
  const named = [...new Set(order)].filter((k) => there.has(k)) as K[]
  const placed = new Set<string>(named)
  return [...named, ...all.filter((k) => !placed.has(k))]
}

/**
 * The arrangement after moving the column `key` to just before `before` (null: to the end). Undefined when that
 * puts everything back in the order it comes in, so nothing is stored for it.
 */
export function moveColumn<K extends string>(all: K[], order: readonly string[] | undefined, key: K, before: K | null): K[] | undefined {
  const now = arrangeColumns(all, order)
  const rest = now.filter((k) => k !== key)
  const at = before === null ? -1 : rest.indexOf(before)
  // (Before itself: it stays where it is.)
  const next = before === key ? now : at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)]
  return next.every((k, i) => k === all[i]) ? undefined : next
}

/** How many separate filters are on. */
export const filterCount = (f: TableFilter) =>
  (f.statuses?.length ? 1 : 0) +
  (f.assignees?.length ? 1 : 0) +
  (f.labels?.length ? 1 : 0) +
  (f.priorities?.length ? 1 : 0) +
  (f.due || f.dueIs ? 1 : 0) +
  (f.startIs ? 1 : 0) +
  (f.changed ? 1 : 0) +
  (f.idle ? 1 : 0) +
  Object.keys(f.fields ?? {}).length

/**
 * Does one task pass the filter (ignoring its parents and subtasks)? `lastComment`: per task, for card age. `ctx`:
 * who is looking and what day it is for them (see MatchContext); without it, nobody is "me" and the day is this
 * computer's.
 */
export function matchesFilter(idx: TaskIndex, id: string, f: TableFilter, lastComment?: Record<string, string>, ctx: MatchContext = {}): boolean {
  const t = idx.tasks[id]
  if (f.statuses?.length && !f.statuses.includes(idx.status.get(id)!)) return false
  if (f.assignees?.length && !(f.assignees.includes(t.assigneeId ?? '') || (!!t.assigneeId && t.assigneeId === ctx.me && f.assignees.includes(ME))))
    return false
  if (f.labels?.length && !t.labels.some((l) => f.labels!.includes(l))) return false
  if (f.priorities?.length && !f.priorities.includes(t.priority ?? '')) return false
  const today = ctx.today ?? todayDay()
  const dayOf = ctx.dayOf ?? toDay
  if (f.due) {
    const done = idx.category.get(id) === 'done'
    if (f.due === 'none' && t.due) return false
    // (A whole day is over once the day after has begun for the person looking; a moment once it has passed.)
    const past = !!t.due && (hasTime(t.due) ? isPast(t.due, ctx.now) : dayOf(t.due) < today)
    if (f.due === 'overdue' && (done || !past)) return false
    if (f.due === 'week') {
      const d = t.due ? dayOf(t.due) - today : NaN
      if (!(d >= 0 && d <= 7)) return false
    }
  } else if (f.dueIs && !dateMatches(t.due ? dayOf(t.due) : undefined, f.dueIs, today)) return false
  if (f.startIs && !dateMatches(t.start ? dayOf(t.start) : undefined, f.startIs, today)) return false
  if (f.changed && idleDays(lastActivity(idx, id, lastComment)) >= f.changed) return false
  if (f.idle && (idx.category.get(id) === 'done' || idleDays(lastActivity(idx, id, lastComment)) < f.idle)) return false
  if (f.fields) {
    const forFields: MatchContext = { ...ctx, today, isMember: ctx.isMember ?? ((u) => idx.members.has(u)) }
    for (const [fieldId, wanted] of Object.entries(f.fields)) {
      // (A filter for a field the board no longer uses says nothing: `cleanPrefs` takes it away.)
      const def = idx.fields.get(fieldId)
      if (def && !fieldMatches(def, t.custom?.[fieldId], wanted, forFields)) return false
    }
  }
  return true
}

/**
 * What the Due filter is set to, whichever of its two places holds it: "overdue", the next 7 days ("week"), no date,
 * or any other test of a day.
 */
export type DueChoice = 'overdue' | 'week' | 'none' | DateTest
export const dueChoiceOf = (f: Pick<TableFilter, 'due' | 'dueIs'>): DueChoice | undefined => f.due ?? f.dueIs
/**
 * A choice as the two parts of a filter: one set, the other cleared. Each meaning has one way to be written, so a
 * saved filter compares equal to itself: "no date" and "the next 7 days" stay where they've always been.
 */
export function withDue(choice: DueChoice | undefined): { due: TableFilter['due']; dueIs: DateTest | undefined } {
  if (choice === undefined || typeof choice === 'string') return { due: choice, dueIs: undefined }
  const t = tidyDateTest(choice)
  if (t?.on === 'none') return { due: 'none', dueIs: undefined }
  if (t?.on === 'next' && t.days === 7) return { due: 'week', dueIs: undefined }
  return { due: undefined, dueIs: t }
}
/** A Due choice as "overdue" or one test of a day (what a control for it shows): the other two words are tests too. */
export const dueAsTest = (choice: DueChoice): 'overdue' | DateTest =>
  choice === 'week' ? { on: 'next', days: 7 } : choice === 'none' ? { on: 'none' } : choice
/** A Due choice in words, to follow "Due:". */
export const dueText = (choice: DueChoice): string =>
  typeof choice === 'string' ? { overdue: 'overdue', week: 'in the next 7 days', none: 'no date' }[choice] : dateTestText(choice)
/** A Due choice as text for an address ("overdue", "week", "none", or a test of a day: see `dateTestToText`), and back. */
export const dueToText = (choice: DueChoice): string => (typeof choice === 'string' ? choice : dateTestToText(choice))
export function dueFromText(text: string): DueChoice | undefined {
  const t = text.trim()
  if (t === 'overdue' || t === 'week' || t === 'none') return t
  const test = dateTestFromText(t)
  return test && dueChoiceOf(withDue(test))
}

/**
 * A comparator for sorting siblings by a column. Empty values always go last, whichever the direction. A card link
 * goes by its first card's title (`titleOf`), and one whose title isn't known counts as empty; a person field by
 * the name of the first person who is still on the board.
 */
export function sortComparator(idx: TaskIndex, sort: Sort, labelById: Map<string, LabelDef>, titleOf?: TitleOf) {
  const sign = sort.dir === 'asc' ? 1 : -1
  if (isFieldKey(sort.key)) {
    const def = idx.fields.get(fieldIdOf(sort.key))
    // (Sorted by a field the board no longer uses: everything stays where it is.)
    if (!def) return () => 0
    const held = (id: string) => idx.tasks[id].custom?.[def.id]
    switch (def.type) {
      // By the first person's name, or the first linked card's title; one that isn't known is like none at all.
      case 'person':
        return byKey(
          once((id) => peopleOf(held(id)).flatMap((u) => idx.members.get(u)?.name.toLowerCase() ?? [])[0]),
          sign,
          WORDS,
        )
      case 'link':
        return byKey(
          once((id) => {
            const [first] = linksOf(held(id))
            return first === undefined ? undefined : titleOf?.(first)?.toLowerCase()
          }),
          sign,
          WORDS,
        )
      // A checkbox has two real values: ticked ones first, or last.
      case 'checkbox':
        return byKey((id) => (held(id) === true ? 0 : 1), sign)
      case 'number': {
        // A number that adds up sorts by what the row is worth: its own number plus its subtasks'.
        const totals = def.sum ? subtreeSums(idx, def) : null
        return byKey((id) => (totals ? totals.get(id) : (held(id) as number | undefined)), sign)
      }
      case 'date':
        return byKey(
          once((id) => {
            const v = held(id)
            return typeof v === 'string' ? sortTime(v) : undefined
          }),
          sign,
        )
      case 'choice': {
        // By the options' order, going by the first of them a card has. (An option that's gone is like no option:
        // last, whichever way.)
        const place = new Map((def.options ?? []).map((o, i) => [o.id, i]))
        return byKey(
          once((id) => {
            const v = held(id)
            if (!Array.isArray(v)) return undefined
            let first: number | undefined
            for (const o of v) {
              const at = place.get(o)
              if (at !== undefined && (first === undefined || at < first)) first = at
            }
            return first
          }),
          sign,
        )
      }
      case 'text':
        return byKey(
          (id) => {
            const v = held(id)
            return v === undefined ? undefined : String(v)
          },
          sign,
          WORDS,
        )
      default:
        return () => 0
    }
  }
  const colIndex = new Map(idx.columns.map((c, i) => [c.id, i]))
  const value = (id: string): string | number | undefined => {
    const t = idx.tasks[id]
    switch (sort.key) {
      case 'title':
        return t.title.toLowerCase()
      case 'status':
        return colIndex.get(idx.status.get(id)!)
      case 'progress': {
        const total = idx.subTotal.get(id)!
        return total ? idx.subDone.get(id)! / total : undefined
      }
      case 'assignee':
        return t.assigneeId ? idx.members.get(t.assigneeId)?.name.toLowerCase() : undefined
      case 'priority':
        // Ascending: most important first.
        return t.priority ? PRIORITIES.indexOf(t.priority) : undefined
      case 'start':
        return t.start ? sortTime(t.start) : undefined
      case 'due':
        return t.due ? sortTime(t.due) : undefined
      case 'labels': {
        const first = t.labels
          .map((l) => labelById.get(l)?.name.toLowerCase())
          .filter((n) => n !== undefined)
          .sort()[0]
        return first
      }
    }
  }
  return byKey(once(value), sign)
}

/**
 * Each card's value to sort by, worked out the first time the card is compared and kept for the rest of the sort: a
 * sort compares every card a dozen times over, and reading a date or finding a choice's place each time is what made
 * sorting a big Outline slow. (A comparator is made for one version of the board, so what it keeps is never stale.)
 */
function once<K>(of: (id: string) => K): (id: string) => K {
  const kept = new Map<string, K>()
  return (id) => {
    if (!kept.has(id)) kept.set(id, of(id))
    return kept.get(id) as K
  }
}

/** Words in the order people expect (what `localeCompare` gives, without making a collator for every pair). */
const WORDS = new Intl.Collator()

/** Compares what `key` gives for two cards: smaller first, flipped for descending, and nothing always last. */
function byKey<K extends string | number>(key: (id: string) => K | undefined, sign: number, words?: Intl.Collator) {
  return (a: string, b: string) => {
    const va = key(a)
    const vb = key(b)
    if (va === undefined || vb === undefined) return va === vb ? 0 : va === undefined ? 1 : -1
    if (words) return sign * words.compare(va as string, vb as string)
    return va < vb ? -sign : va > vb ? sign : 0
  }
}

/**
 * The active filters in words, for chips: "Status: To Do, Doing". A filter by one of the board's fields is a chip
 * of its own (`field`: its id), so each can be taken away by itself.
 */
export function filterChips(
  f: TableFilter,
  columns: StatusColumn[],
  labels: LabelDef[],
  members: Member[],
  fields: FieldDef[] = [],
  titleOf?: TitleOf,
) {
  const chips: { key: keyof TableFilter; field?: string; label: string; value: string }[] = []
  const names = (ids: string[], name: (id: string) => string | undefined) => ids.map(name).filter(Boolean).join(', ')
  if (f.statuses?.length) chips.push({ key: 'statuses', label: 'Status:', value: names(f.statuses, (id) => columns.find((c) => c.id === id)?.name) })
  if (f.assignees?.length)
    chips.push({
      key: 'assignees',
      label: 'Assignee:',
      value: names(f.assignees, (id) => (id === ME ? 'Me' : id ? members.find((m) => m.id === id)?.name : 'No one')),
    })
  if (f.labels?.length)
    chips.push({ key: 'labels', label: 'Labels:', value: names(f.labels, (id) => labels.find((l) => l.id === id)?.name || 'Unnamed') })
  if (f.priorities?.length)
    chips.push({ key: 'priorities', label: 'Priority:', value: names(f.priorities, (p) => (p ? PRIORITY_LABEL[p as Priority] : 'None')) })
  const due = dueChoiceOf(f)
  // (One chip for Due, wherever it's held: taking it away clears both.)
  if (due) chips.push({ key: 'due', label: 'Due:', value: dueText(due) })
  if (f.startIs) chips.push({ key: 'startIs', label: 'Start:', value: dateTestText(f.startIs) })
  if (f.changed) chips.push({ key: 'changed', label: 'Changed in the last', value: f.changed === 1 ? 'day' : `${f.changed} days` })
  if (f.idle) chips.push({ key: 'idle', label: 'No activity for', value: `${f.idle}+ ${f.idle === 1 ? 'day' : 'days'}` })
  for (const [fieldId, wanted] of Object.entries(f.fields ?? {})) {
    const def = fields.find((x) => x.id === fieldId)
    if (!def) continue
    const named = def.type === 'person' ? (id: string) => members.find((m) => m.id === id)?.name : titleOf
    chips.push({ key: 'fields', field: fieldId, label: `${def.name}:`, value: filterText(def, wanted, named) })
  }
  return chips
}
