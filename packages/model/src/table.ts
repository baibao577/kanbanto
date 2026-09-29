import { isPast, sortTime, todayDay, toDay } from './dates'
import { isBlocked, isLeaf, type TaskIndex } from './indexer'
import { PRIORITIES, PRIORITY_LABEL, type LabelDef, type Member, type Priority, type StatusColumn } from './types'

/** Columns the Outline table can sort by. */
export type SortKey = 'title' | 'status' | 'progress' | 'assignee' | 'priority' | 'start' | 'due' | 'labels'
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
  /** Only tasks that are ready to start ("up next"). */
  upNext?: boolean
}

/** The Outline's own settings (filters are shared by every tab; see State.filter). */
export interface OutlineConfig {
  sort?: Sort
}

/** How many separate filters are on. */
export const filterCount = (f: TableFilter) =>
  (f.statuses?.length ? 1 : 0) +
  (f.assignees?.length ? 1 : 0) +
  (f.labels?.length ? 1 : 0) +
  (f.priorities?.length ? 1 : 0) +
  (f.due ? 1 : 0) +
  (f.upNext ? 1 : 0)

/** Does one task pass the filter (ignoring its parents and subtasks)? */
export function matchesFilter(idx: TaskIndex, id: string, f: TableFilter): boolean {
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
  if (f.upNext && !(isLeaf(idx, id) && idx.category.get(id) === 'todo' && !isBlocked(idx, id))) return false
  return true
}

/** A comparator for sorting siblings by a column. Empty values always go last, whichever the direction. */
export function sortComparator(idx: TaskIndex, sort: Sort, labelById: Map<string, LabelDef>) {
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
  const sign = sort.dir === 'asc' ? 1 : -1
  return (a: string, b: string) => {
    const va = value(a)
    const vb = value(b)
    if (va === undefined || vb === undefined) return va === vb ? 0 : va === undefined ? 1 : -1
    if (va < vb) return -sign
    if (va > vb) return sign
    return 0
  }
}

/** The active filters in words, for chips: "Status: To Do, Doing". */
export function filterChips(f: TableFilter, columns: StatusColumn[], labels: LabelDef[], members: Member[]) {
  const chips: { key: keyof TableFilter; label: string; value: string }[] = []
  const names = (ids: string[], name: (id: string) => string | undefined) => ids.map(name).filter(Boolean).join(', ')
  if (f.upNext) chips.push({ key: 'upNext', label: 'Showing', value: 'ready to start' })
  if (f.statuses?.length) chips.push({ key: 'statuses', label: 'Status:', value: names(f.statuses, (id) => columns.find((c) => c.id === id)?.name) })
  if (f.assignees?.length)
    chips.push({ key: 'assignees', label: 'Assignee:', value: names(f.assignees, (id) => (id ? members.find((m) => m.id === id)?.name : 'No one')) })
  if (f.labels?.length)
    chips.push({ key: 'labels', label: 'Labels:', value: names(f.labels, (id) => labels.find((l) => l.id === id)?.name || 'Unnamed') })
  if (f.priorities?.length)
    chips.push({ key: 'priorities', label: 'Priority:', value: names(f.priorities, (p) => (p ? PRIORITY_LABEL[p as Priority] : 'None')) })
  if (f.due) chips.push({ key: 'due', label: 'Due:', value: { overdue: 'overdue', week: 'this week', none: 'no date' }[f.due] })
  return chips
}
