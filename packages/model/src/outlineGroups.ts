import type { TaskFields } from './commands'
import { fieldIdOf, fieldKey, isFieldKey, optionsOf, peopleOf, type BoardField, type FieldKey } from './fields'
import type { TaskIndex } from './indexer'
import { keepMatching } from './tree'
import { PRIORITIES, PRIORITY_LABEL, type LabelDef, type Priority } from './types'

// Grouping the Outline's rows by a column: the rows gathered under a heading for each value of it (each list,
// person, priority, label, or value of one of the board's own fields).
//
// The Outline is a tree, and a subtask's value can differ from its parent's. So a card goes under the heading of
// its own value, and the cards above it come along greyed, for context, the way they do when a search or a filter
// finds a subtask: under "Ton", his step is shown inside Ann's project. A parent can then show under several
// headings, as itself under its own and as context elsewhere. A card with several values (two labels) is under each.

/** The built-in columns the Outline can be grouped by, in the order they're offered. */
export const GROUP_COLUMNS = ['status', 'assignee', 'priority', 'labels'] as const
export type GroupColumn = (typeof GROUP_COLUMNS)[number]
/** What the Outline is grouped by: one of those, or one of the board's fields by its key. */
export type GroupKey = GroupColumn | FieldKey

/** The kinds of field whose values are a short set, so each can be a heading. (A text or a number would give one per card.) */
const GROUPING: ReadonlySet<BoardField['type']> = new Set(['choice', 'person', 'checkbox'])
export const canGroupByField = (f: Pick<BoardField, 'type'>) => GROUPING.has(f.type)

/** Everything the Outline can be grouped by on this board. */
export const groupKeys = (fields: readonly BoardField[]): GroupKey[] => [
  ...GROUP_COLUMNS,
  ...fields.filter(canGroupByField).map((f) => fieldKey(f.id)),
]

/** The grouping as it can be used now: unset when it names a field the board no longer has, or one that can't group. */
export function groupKeyOf(group: string | undefined, fields: ReadonlyMap<string, BoardField>): GroupKey | undefined {
  if (!group) return undefined
  if ((GROUP_COLUMNS as readonly string[]).includes(group)) return group as GroupColumn
  if (!isFieldKey(group)) return undefined
  const f = fields.get(fieldIdOf(group))
  return f && canGroupByField(f) ? group : undefined
}

/** A tick field's two headings. */
export const TICKED = 'yes'
export const NOT_TICKED = 'no'

/**
 * The headings a card goes under: the ids of its values for the column ('' when it has none). Labels, options and
 * people that are gone don't count.
 */
function valuesOf(idx: TaskIndex, id: string, key: GroupKey, labels: ReadonlySet<string>): string[] {
  const t = idx.tasks[id]
  const some = (ids: string[]) => (ids.length ? ids : [''])
  switch (key) {
    case 'status':
      return [idx.status.get(id)!]
    case 'assignee':
      return [t.assigneeId && idx.members.has(t.assigneeId) ? t.assigneeId : '']
    case 'priority':
      return [t.priority ?? '']
    case 'labels':
      return some(t.labels.filter((l) => labels.has(l)))
    default: {
      const f = idx.fields.get(fieldIdOf(key))
      const value = t.custom?.[fieldIdOf(key)]
      if (!f) return ['']
      if (f.type === 'checkbox') return [value === true ? TICKED : NOT_TICKED]
      if (f.type === 'choice') return some(optionsOf(f, value).map((o) => o.id))
      return some(peopleOf(value).filter((u) => idx.members.has(u)))
    }
  }
}

/** One heading and the cards that are under it for their own sake, in the order they were given. */
export interface CardGroup {
  /** The value's id: a list, a person, a priority, a label, an option, "yes" / "no". '' is "none". */
  value: string
  cards: string[]
}

/**
 * These cards under the headings of a column, the headings in the order that means something: lists as the board
 * has them (every one, empty too, since a list is a place); priorities from Urgent down; labels and options in
 * their own order; people by name; "ticked" before "not ticked". Of labels, options and people, only the ones in
 * use. Cards with no value come last.
 */
export function groupCards(idx: TaskIndex, labels: readonly LabelDef[], key: GroupKey, ids: Iterable<string>): CardGroup[] {
  const known = new Set(labels.map((l) => l.id))
  const by = new Map<string, string[]>()
  for (const id of ids)
    for (const v of valuesOf(idx, id, key, known)) {
      const list = by.get(v)
      if (list) list.push(id)
      else by.set(v, [id])
    }
  const byName = (a: string, b: string) => (idx.members.get(a)?.name ?? '').localeCompare(idx.members.get(b)?.name ?? '') || a.localeCompare(b)
  const used = (order: readonly string[]) => order.filter((v) => by.has(v))
  let order: string[]
  if (key === 'status') order = idx.columns.map((c) => c.id)
  else if (key === 'priority') order = used(PRIORITIES)
  else if (key === 'labels') order = used(labels.map((l) => l.id))
  else if (key === 'assignee') order = [...by.keys()].filter(Boolean).sort(byName)
  else {
    const f = idx.fields.get(fieldIdOf(key))
    if (f?.type === 'checkbox') order = used([TICKED, NOT_TICKED])
    else if (f?.type === 'choice') order = used((f.options ?? []).map((o) => o.id))
    else order = [...by.keys()].filter(Boolean).sort(byName)
  }
  if (by.has('') && !order.includes('')) order.push('')
  return order.map((value) => ({ value, cards: by.get(value) ?? [] }))
}

/**
 * The rows under one heading: its own cards and, for context, the cards above them, as a set to lay the tree out
 * with (see `flattenTree`'s `keep`).
 */
export const groupKeep = (idx: TaskIndex, cards: readonly string[]): Set<string> => {
  const own = new Set(cards)
  return keepMatching(idx, (id) => own.has(id)).keep
}

/** What a heading is called, where it isn't drawn as the thing itself (a chip, a person): "No assignee", "Ticked". */
export function groupName(idx: TaskIndex, labels: readonly LabelDef[], key: GroupKey, value: string): string {
  switch (key) {
    case 'status':
      return idx.colById.get(value)?.name ?? 'A list that is gone'
    case 'assignee':
      return value ? (idx.members.get(value)?.name ?? 'Someone') : 'No assignee'
    case 'priority':
      return value ? PRIORITY_LABEL[value as Priority] : 'No priority'
    case 'labels':
      return value ? labels.find((l) => l.id === value)?.name || 'Unnamed label' : 'No label'
    default: {
      const f = idx.fields.get(fieldIdOf(key))
      if (!f) return ''
      if (f.type === 'checkbox') return value === TICKED ? `${f.name}: ticked` : `${f.name}: not ticked`
      if (!value) return `No ${f.name.toLowerCase()}`
      return f.type === 'choice' ? (f.options?.find((o) => o.id === value)?.name ?? '') : (idx.members.get(value)?.name ?? 'Someone')
    }
  }
}

/** What the grouping itself is called: "List", "Assignee", a field's name. */
export function groupLabel(key: GroupKey, fields: ReadonlyMap<string, BoardField>): string {
  if (isFieldKey(key)) return fields.get(fieldIdOf(key))?.name ?? 'A field'
  return { status: 'List', assignee: 'Assignee', priority: 'Priority', labels: 'Label' }[key]
}

/** What a card added under a heading starts with: that heading's value. (Nothing, under "none".) */
export function groupFields(idx: TaskIndex, key: GroupKey, value: string): TaskFields {
  if (!value) return {}
  switch (key) {
    case 'status':
      return { status: value }
    case 'assignee':
      return { assigneeId: value }
    case 'priority':
      return { priority: value as Priority }
    case 'labels':
      return { labels: [value] }
    default: {
      const f = idx.fields.get(fieldIdOf(key))
      if (!f) return {}
      if (f.type === 'checkbox') return value === TICKED ? { custom: { [f.id]: true } } : {}
      return { custom: { [f.id]: [value] } }
    }
  }
}
