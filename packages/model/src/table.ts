import { isPast, sortTime, todayDay, toDay } from './dates'
import { idleDays, lastActivity } from './age'
import {
  compareValues,
  fieldIdOf,
  fieldMatches,
  filterText,
  isFieldKey,
  optionsOf,
  type FieldDef,
  type FieldFilter,
  type FieldKey,
  linksOf,
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
  /** Member ids; '' means "no one assigned". */
  assignees?: string[]
  /** Label ids (any of them). */
  labels?: string[]
  /** '' means "no priority". */
  priorities?: (Priority | '')[]
  due?: 'overdue' | 'week' | 'none'
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
}

/** How many separate filters are on. */
export const filterCount = (f: TableFilter) =>
  (f.statuses?.length ? 1 : 0) +
  (f.assignees?.length ? 1 : 0) +
  (f.labels?.length ? 1 : 0) +
  (f.priorities?.length ? 1 : 0) +
  (f.due ? 1 : 0) +
  (f.changed ? 1 : 0) +
  (f.idle ? 1 : 0) +
  Object.keys(f.fields ?? {}).length

/** Does one task pass the filter (ignoring its parents and subtasks)? `lastComment`: per task, for card age. */
export function matchesFilter(idx: TaskIndex, id: string, f: TableFilter, lastComment?: Record<string, string>): boolean {
  const t = idx.tasks[id]
  if (f.statuses?.length && !f.statuses.includes(idx.status.get(id)!)) return false
  if (f.assignees?.length && !f.assignees.includes(t.assigneeId ?? '')) return false
  if (f.labels?.length && !t.labels.some((l) => f.labels!.includes(l))) return false
  if (f.priorities?.length && !f.priorities.includes(t.priority ?? '')) return false
  if (f.due) {
    const done = idx.category.get(id) === 'done'
    if (f.due === 'none' && t.due) return false
    if (f.due === 'overdue' && (!t.due || done || !isPast(t.due))) return false
    if (f.due === 'week') {
      const d = t.due ? toDay(t.due) - todayDay() : NaN
      if (!(d >= 0 && d <= 7)) return false
    }
  }
  if (f.changed && idleDays(lastActivity(idx, id, lastComment)) >= f.changed) return false
  if (f.idle && (idx.category.get(id) === 'done' || idleDays(lastActivity(idx, id, lastComment)) < f.idle)) return false
  if (f.fields)
    for (const [fieldId, wanted] of Object.entries(f.fields)) {
      // (A filter for a field the board no longer uses says nothing: `cleanPrefs` takes it away.)
      const def = idx.fields.get(fieldId)
      if (def && !fieldMatches(def, t.custom?.[fieldId], wanted, todayDay(), (u) => idx.members.has(u))) return false
    }
  return true
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
    if (def.type === 'link' || def.type === 'person') {
      const title = (id: string) => {
        const held = idx.tasks[id].custom?.[def.id]
        if (def.type === 'person') return peopleOf(held).flatMap((u) => idx.members.get(u)?.name.toLowerCase() ?? [])[0]
        const [first] = linksOf(held)
        return first === undefined ? undefined : titleOf?.(first)?.toLowerCase()
      }
      return (a: string, b: string) => {
        const [ta, tb] = [title(a), title(b)]
        if (ta === undefined || tb === undefined) return ta === tb ? 0 : ta === undefined ? 1 : -1
        return sign * ta.localeCompare(tb)
      }
    }
    // A checkbox has two real values: ticked ones first, or last.
    if (def.type === 'checkbox') {
      const ticked = (id: string) => (idx.tasks[id].custom?.[def.id] === true ? 0 : 1)
      return (a: string, b: string) => sign * (ticked(a) - ticked(b))
    }
    // A number that adds up sorts by what the row is worth: its own number plus its subtasks'.
    const totals = def.type === 'number' && def.sum ? subtreeSums(idx, def) : null
    const shown = (id: string) => {
      if (totals) return totals.get(id)
      const v = idx.tasks[id].custom?.[def.id]
      // (An option that's gone is like no option: last, whichever way.)
      return def.type === 'choice' && !optionsOf(def, v).length ? undefined : v
    }
    return (a: string, b: string) => {
      const va = shown(a)
      const vb = shown(b)
      if (va === undefined || vb === undefined) return va === vb ? 0 : va === undefined ? 1 : -1
      return sign * compareValues(def, va, vb)
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
  return (a: string, b: string) => {
    const va = value(a)
    const vb = value(b)
    if (va === undefined || vb === undefined) return va === vb ? 0 : va === undefined ? 1 : -1
    if (va < vb) return -sign
    if (va > vb) return sign
    return 0
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
    chips.push({ key: 'assignees', label: 'Assignee:', value: names(f.assignees, (id) => (id ? members.find((m) => m.id === id)?.name : 'No one')) })
  if (f.labels?.length)
    chips.push({ key: 'labels', label: 'Labels:', value: names(f.labels, (id) => labels.find((l) => l.id === id)?.name || 'Unnamed') })
  if (f.priorities?.length)
    chips.push({ key: 'priorities', label: 'Priority:', value: names(f.priorities, (p) => (p ? PRIORITY_LABEL[p as Priority] : 'None')) })
  if (f.due) chips.push({ key: 'due', label: 'Due:', value: { overdue: 'overdue', week: 'this week', none: 'no date' }[f.due] })
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
