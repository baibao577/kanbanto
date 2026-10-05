import { LABEL_COLOR_CYCLE, type ColorName } from './colors'
import { tidyCustom } from './fields'
import { comparePositions, positionsBetween } from './position'
import type { ViewPrefs } from './prefs'
import { DEFAULT_DISPLAY } from './prefs'
import {
  DEFAULT_COLUMNS,
  type Board,
  type BoardData,
  type Category,
  type LabelDef,
  type Member,
  type Meta,
  type Priority,
  type StatusColumn,
  type StatusMode,
  type Task,
  type TaskMap,
} from './types'

/**
 * Older save and export formats, loosely typed:
 * v1 (prototype): `{ tasks, columns?, mode? }` · v2: one blob with board data and view settings mixed,
 * numeric positions, assignees as names, labels as names or ids.
 */
export interface LegacyTask {
  id: string
  title: string
  parentId?: string | null
  status?: string
  order?: number | string
  rank?: number | string
  assignee?: string
  assigneeId?: string
  labels?: string[]
  blockedBy?: string[]
  start?: string
  due?: string
  description?: string
  priority?: Priority
  color?: ColorName
}
interface LegacyColumn {
  id: string
  name: string
  category: Category
  color?: ColorName
}
interface LegacyLabel {
  id: string
  name: string
  color: ColorName
}

export interface Upgrade {
  now: string
  newId: () => string
}

const meta = (now: string): Meta => ({ createdAt: now, updatedAt: now, version: 1 })

/** Lists: keep ids and order, add positions and bookkeeping. */
export function upgradeColumns(raw: LegacyColumn[] | undefined, now: string): StatusColumn[] {
  const cols = raw?.length ? raw : DEFAULT_COLUMNS
  const keys = positionsBetween(null, null, cols.length)
  return cols.map((c, i) => ({ id: c.id, name: c.name, category: c.category, color: c.color, position: keys[i], ...meta(now) }))
}

/**
 * Tasks in any older shape → current records. People named on tasks become members, label names become
 * labels (reusing `existing` ones by name), and numeric positions become position keys in the same order.
 */
export function upgradeTasks(
  raw: LegacyTask[],
  columns: StatusColumn[],
  existing: { members?: Member[]; labels?: (LegacyLabel & Partial<Meta>)[] },
  u: Upgrade,
): Pick<BoardData, 'tasks' | 'members' | 'labels'> {
  const members = [...(existing.members ?? [])]
  const labels: LabelDef[] = (existing.labels ?? []).map((l) => ({ ...meta(u.now), ...l }))
  const memberByName = new Map(members.map((m) => [m.name.toLowerCase(), m]))
  const labelById = new Map(labels.map((l) => [l.id, l]))
  const labelByName = new Map(labels.filter((l) => l.name).map((l) => [l.name.toLowerCase(), l]))
  const firstTodo = columns.find((c) => c.category === 'todo')?.id ?? columns[0].id

  const memberFor = (name: string) => {
    const key = name.trim().toLowerCase()
    let m = memberByName.get(key)
    if (!m) {
      m = { id: u.newId(), name: name.trim(), ...meta(u.now) }
      members.push(m)
      memberByName.set(key, m)
    }
    return m.id
  }
  const labelFor = (ref: string) => {
    if (labelById.has(ref)) return ref
    const key = ref.toLowerCase()
    let l = labelByName.get(key)
    if (!l) {
      l = { id: u.newId(), name: ref, color: LABEL_COLOR_CYCLE[labels.length % LABEL_COLOR_CYCLE.length], ...meta(u.now) }
      labels.push(l)
      labelByName.set(key, l)
      labelById.set(l.id, l)
    }
    return l.id
  }

  const tasks: TaskMap = {}
  for (const t of raw) {
    const task: Task = {
      id: t.id,
      title: t.title,
      parentId: t.parentId ?? null,
      status: t.status ?? firstTodo,
      order: '', // filled in below
      labels: [...new Set((t.labels ?? []).map(labelFor))],
      blockedBy: t.blockedBy ?? [],
      ...meta(u.now),
    }
    const assigneeId = t.assigneeId ?? (t.assignee ? memberFor(t.assignee) : undefined)
    if (assigneeId) task.assigneeId = assigneeId
    for (const key of ['start', 'due', 'description', 'priority', 'color'] as const)
      if (t[key]) (task as unknown as Record<string, unknown>)[key] = t[key]
    tasks[t.id] = task
  }

  // Positions: keep each parent's children (and the board's hand-placed cards) in their old order.
  const byId = new Map(raw.map((t) => [t.id, t]))
  const cmp = (key: 'order' | 'rank') => (a: string, b: string) => {
    const va = byId.get(a)![key] ?? 0
    const vb = byId.get(b)![key] ?? 0
    return typeof va === 'number' && typeof vb === 'number' ? va - vb : comparePositions(String(va), String(vb))
  }
  const groups = new Map<string | null, string[]>()
  for (const t of Object.values(tasks)) {
    const g = groups.get(t.parentId)
    if (g) g.push(t.id)
    else groups.set(t.parentId, [t.id])
  }
  for (const ids of groups.values()) {
    ids.sort(cmp('order'))
    positionsBetween(null, null, ids.length).forEach((k, i) => (tasks[ids[i]].order = k))
  }
  const ranked = raw.filter((t) => t.rank !== undefined).map((t) => t.id)
  ranked.sort(cmp('rank'))
  positionsBetween(null, null, ranked.length).forEach((k, i) => (tasks[ranked[i]].rank = k))

  return { tasks: repairTasks(tasks, columns, members, labels), members, labels }
}

/** Drops references to things that don't exist (a missing parent makes a task top-level, and so on). */
export function repairTasks(tasks: TaskMap, columns: StatusColumn[], members: Member[], labels: LabelDef[]): TaskMap {
  const colIds = new Set(columns.map((c) => c.id))
  const memberIds = new Set(members.map((m) => m.id))
  const labelIds = new Set(labels.map((l) => l.id))
  const fallback = columns.find((c) => c.category === 'todo')?.id ?? columns[0].id
  const out: TaskMap = {}
  for (const t of Object.values(tasks)) {
    out[t.id] = {
      ...t,
      parentId: t.parentId && tasks[t.parentId] && t.parentId !== t.id ? t.parentId : null,
      status: colIds.has(t.status) ? t.status : fallback,
      assigneeId: t.assigneeId && memberIds.has(t.assigneeId) ? t.assigneeId : undefined,
      labels: t.labels.filter((l) => labelIds.has(l)),
      blockedBy: t.blockedBy.filter((b) => b !== t.id && tasks[b]),
    }
    if (!out[t.id].assigneeId) delete out[t.id].assigneeId
  }
  return out
}

/** Board data from a loaded or imported source, with references repaired and lists in order. */
export function repairData(data: BoardData): BoardData {
  const columns = [...data.columns].sort((a, b) => comparePositions(a.position, b.position))
  // (A card only holds values for the board's fields, and only ones that fit them: for a person field, its people.)
  const people = new Set(data.members.map((m) => m.id))
  const values = (all: TaskMap): TaskMap =>
    Object.fromEntries(
      Object.values(all).map((t) => {
        const { custom: _held, ...rest } = t
        const custom = tidyCustom(t.custom, data.fields, (u) => people.has(u))
        return [t.id, custom ? { ...rest, custom } : rest]
      }),
    )
  const tasks = values(unloop(repairTasks(data.tasks, columns, data.members, data.labels)))
  return data.archived ? { ...data, columns, tasks, archived: values(unloop(data.archived, tasks)) } : { ...data, columns, tasks }
}

/**
 * Parent links that go round in a loop (a damaged or hand-made file) are cut: the task that closes the loop goes
 * to the top level. `others` are tasks the links may also lead to (the live ones, for archived tasks).
 */
function unloop(tasks: TaskMap, others: TaskMap = {}): TaskMap {
  let out = tasks
  const parentOf = (id: string) => (out[id] ?? others[id])?.parentId ?? null
  for (const t of Object.values(tasks)) {
    const seen = new Set([t.id])
    for (let at = out[t.id].parentId; at; at = parentOf(at)) {
      if (!seen.has(at)) {
        seen.add(at)
        continue
      }
      if (out === tasks) out = { ...tasks }
      out[t.id] = { ...out[t.id], parentId: null }
      break
    }
  }
  return out
}

/**
 * A save from before board data and view settings were split (v1 or v2) → board data + view settings.
 * Returns null if it doesn't look like a board.
 */
export function upgradeSave(raw: unknown, u: Upgrade): { data: BoardData; prefs: Partial<ViewPrefs> } | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown> & {
    tasks?: Record<string, LegacyTask> | LegacyTask[]
    columns?: LegacyColumn[]
    labels?: LegacyLabel[]
    mode?: StatusMode
    boardName?: string
    background?: ColorName
  }
  if (!s.tasks || typeof s.tasks !== 'object') return null
  const list = Array.isArray(s.tasks) ? s.tasks : Object.values(s.tasks)
  if (!list.every((t) => t && typeof t.id === 'string' && typeof t.title === 'string')) return null

  const columns = upgradeColumns(s.columns, u.now)
  const { tasks, members, labels } = upgradeTasks(list, columns, { labels: s.labels }, u)
  const board: Board = {
    id: u.newId(),
    name: s.boardName || 'My board',
    mode: s.mode === 'manual' ? 'manual' : 'derived',
    ...(s.background ? { background: s.background } : {}),
    ...meta(u.now),
  }
  const data: BoardData = { board, members, columns, labels, fields: [], tasks }
  return { data, prefs: upgradePrefs(s, members) }
}

/** View settings from a v2 save. People were stored by name; they're member ids now. */
function upgradePrefs(s: Record<string, unknown>, members: Member[]): Partial<ViewPrefs> {
  const byName = new Map(members.map((m) => [m.name.toLowerCase(), m.id]))
  const person = (name: string) => (name ? (byName.get(name.toLowerCase()) ?? name) : name)
  const prefs: Partial<ViewPrefs> = {}
  const layout = s.layout as string | undefined
  if (layout === 'board' || layout === 'timeline' || layout === 'outline') prefs.layout = layout
  if (layout === 'list') prefs.layout = 'outline'
  const display = s.display as ViewPrefs['display'] | undefined
  const board = (display?.board ?? (s.config as ViewPrefs['display']['board'] | undefined)) as Record<string, unknown> | undefined
  if (board) {
    const pd = board.parentDisplay
    prefs.display = {
      board: {
        ...DEFAULT_DISPLAY.board,
        ...(board as object),
        columns: 'status',
        parentDisplay: Array.isArray(pd) ? pd : typeof pd === 'string' && pd !== 'hidden' ? [pd as never] : [],
      },
    }
  }
  const outline = s.outline as { sort?: ViewPrefs['outline']['sort']; filter?: ViewPrefs['filter'] } | undefined
  if (outline?.sort) prefs.outline = { sort: outline.sort }
  const filter = (s.filter ?? outline?.filter) as ViewPrefs['filter'] | undefined
  if (filter) prefs.filter = { ...filter, assignees: filter.assignees?.map(person) }
  if (typeof s.focusId === 'string') prefs.focusId = s.focusId
  if (Array.isArray(s.collapsedRows)) prefs.collapsedRows = (s.collapsedRows as string[]).map(person)
  if (typeof s.showPerf === 'boolean') prefs.showPerf = s.showPerf
  return prefs
}
