import { tidyDateTest } from './dates'
import { fieldIdOf, fieldKey, isFieldKey, ME, tidyFilter, type CarryOn, type FieldFilter, type FieldMap } from './fields'
import type { OutlineConfig, TableFilter } from './table'
import type { BoardData, Layout, StatusMode, ViewConfig } from './types'

/**
 * Per-person view settings: which tab is open and how each tab looks. These stay on this device
 * (they'd be per user with a server), separate from the board data everyone shares.
 */
export interface ViewPrefs {
  version: 3
  layout: Layout
  display: { board: ViewConfig }
  /** The Outline table's sort. */
  outline: OutlineConfig
  /** How the Timeline tab is drawn. Unset: bars, as it always was. */
  timeline?: TimelineConfig
  /** Filters, shared by every tab (like search). */
  filter: TableFilter
  /** Focused task (show only its subtasks), shared by all tabs. */
  focusId?: string
  /** Board rows that are collapsed (row keys: task ids, member ids, …). */
  collapsedRows: string[]
  /** Developer: show timing stats. */
  showPerf: boolean
  /** The board preset picked last (its name shows on the Presets button). */
  presetId?: string
  /** How the view was before picking a preset (turning presets off brings it back). */
  beforePreset?: PresetSettings
}

/** How much time the Timeline's calendar shows at once. */
export const CALENDAR_RANGES = ['day', 'week', '2w', 'month'] as const
export type CalendarRange = (typeof CALENDAR_RANGES)[number]

/**
 * The Timeline tab's own settings: drawn as a calendar of days instead of bars, how much of it at once (a month,
 * when not said), and whether subtasks that have a date of their own show beside the top-level cards.
 */
export interface TimelineConfig {
  as?: 'calendar'
  range?: CalendarRange
  subtasks?: boolean
}

/** What a board preset keeps: the filters, and how the Board and Outline look (not which tab is open). */
export type PresetSettings = Pick<ViewPrefs, 'filter' | 'display' | 'outline'>

export const presetOf = (p: ViewPrefs): PresetSettings => ({ filter: p.filter, display: p.display, outline: p.outline })

/**
 * A preset's settings with its fields carried over by `map` (a board made from a starter, two fields merged into
 * one): the filters by a field, a choice's options inside them, and the Outline's sort and hidden columns.
 * `others`: what happens to the fields the map doesn't name, kept as they are or dropped. Where two filters land on
 * one field, the one that was already there stays. `on`: for a board that moves to another space, what becomes of the
 * linked cards and the people its filters name (see CarryOn).
 */
export function remapPreset(s: PresetSettings, map: FieldMap, others: 'keep' | 'drop', on?: CarryOn): PresetSettings {
  const to = (id: string) => map.get(id) ?? (others === 'keep' ? { id, options: undefined } : undefined)
  const key = <K extends string>(k: K) => {
    if (!isFieldKey(k)) return k
    const t = to(fieldIdOf(k))
    return t && fieldKey(t.id)
  }
  const asked = Object.entries(s.filter.fields ?? {})
  const fields: Record<string, FieldFilter> = {}
  for (const [id, f] of [...asked.filter(([x]) => !map.has(x)), ...asked.filter(([x]) => map.has(x))]) {
    const t = to(id)
    if (!t || t.id in fields) continue
    let next = f
    // What a list names goes by the map, in "any of" and in "none of" alike: a choice's options, and (with `on`) a
    // card link's cards and a person field's people, as their values do. A list left empty goes.
    const carry = t.options
      ? (o: string) => t.options!.get(o) ?? []
      : t.link && on?.relink
        ? (ref: string) => on.relink!(ref) ?? []
        : t.people && on?.isMember
          ? (id: string) => (id === ME || on.isMember!(id) ? id : [])
          : null
    for (const part of ['in', 'notIn'] as const) {
      const picked = next[part]
      if (!picked || !carry) continue
      const { [part]: _picked, ...rest } = next
      const there = [...new Set(picked.flatMap((o) => (o === '' ? [''] : carry(o))))]
      next = there.length ? { ...rest, [part]: there } : rest
    }
    if (Object.keys(next).length) fields[t.id] = next
  }
  const { fields: _fields, ...filter } = s.filter
  const { sort, hidden, order, ...outline } = s.outline
  const sortKey = sort && key(sort.key)
  const shownOff = hidden && [...new Set(hidden.flatMap((k) => key(k) ?? []))]
  // (Two columns that land on one field keep the first one's place.)
  const arranged = order && [...new Set(order.flatMap((k) => key(k) ?? []))]
  return {
    display: s.display,
    filter: { ...filter, ...(Object.keys(fields).length && { fields }) },
    outline: {
      ...outline,
      ...(sort && sortKey && { sort: { ...sort, key: sortKey } }),
      ...(shownOff?.length && { hidden: shownOff }),
      ...(arranged?.length && { order: arranged }),
    },
  }
}

/** Whether the view still looks the way the preset left it (the Presets button shows a dot when not). */
export const matchesPreset = (p: ViewPrefs, s: PresetSettings) => stable(presetOf(p)) === stable(s)

/** JSON with sorted keys and no empty values, so equal settings compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined && !(Array.isArray(x) && !x.length))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
      .join(',')}}`
  return JSON.stringify(v)
}

export const DEFAULT_DISPLAY: ViewPrefs['display'] = {
  board: { columns: 'status', rows: 'none', filter: 'all', parentDisplay: ['label', 'progress'], groupByParent: true },
}

/**
 * How a board looks before anyone changes it. Where statuses are set by hand, one card per task: a card that has
 * subtasks stays a card (they're its steps), instead of becoming a heading over its subtasks' cards.
 */
export const defaultDisplay = (mode: StatusMode): ViewConfig =>
  mode === 'manual' ? { ...DEFAULT_DISPLAY.board, filter: 'main' } : DEFAULT_DISPLAY.board

export function defaultPrefs(): ViewPrefs {
  return {
    version: 3,
    layout: 'board',
    display: { board: { ...DEFAULT_DISPLAY.board, hiddenColumns: ['backlog'] } },
    outline: {},
    filter: {},
    collapsedRows: [],
    showPerf: false,
  }
}

export type PrefsAction =
  | { type: 'setLayout'; layout: Layout }
  | { type: 'setDisplay'; config: ViewConfig }
  | { type: 'setOutline'; config: OutlineConfig }
  | { type: 'setTimeline'; config: TimelineConfig }
  | { type: 'setFilter'; filter: TableFilter }
  | { type: 'setFocus'; id?: string }
  | { type: 'toggleRow'; key: string }
  | { type: 'setCollapsedRows'; keys: string[] }
  | { type: 'setShowPerf'; on: boolean }
  | { type: 'applyPreset'; id: string; settings: PresetSettings }
  /** No preset: back to `settings` (or the view as it is, without). */
  | { type: 'leavePreset'; settings?: PresetSettings }
  | { type: 'replace'; prefs: ViewPrefs }

export function prefsReducer(p: ViewPrefs, a: PrefsAction): ViewPrefs {
  switch (a.type) {
    case 'setLayout':
      return { ...p, layout: a.layout }
    case 'setDisplay':
      return { ...p, display: { ...p.display, board: a.config } }
    case 'setOutline':
      return { ...p, outline: a.config }
    case 'setTimeline': {
      // (Nothing set is no entry at all: bars, a month, no subtasks.)
      const { as, range, subtasks } = a.config
      const config = { ...(as && { as }), ...(range && range !== 'month' && { range }), ...(subtasks && { subtasks }) }
      return { ...p, timeline: Object.keys(config).length ? config : undefined }
    }
    case 'setFilter':
      return { ...p, filter: a.filter }
    case 'setFocus':
      return { ...p, focusId: a.id }
    case 'toggleRow':
      return {
        ...p,
        collapsedRows: p.collapsedRows.includes(a.key) ? p.collapsedRows.filter((k) => k !== a.key) : [...p.collapsedRows, a.key],
      }
    case 'setCollapsedRows':
      return { ...p, collapsedRows: a.keys }
    case 'setShowPerf':
      return { ...p, showPerf: a.on }
    case 'applyPreset':
      // Switching from one preset to another keeps the view from before the first.
      return { ...p, ...a.settings, presetId: a.id, beforePreset: p.presetId ? p.beforePreset : presetOf(p) }
    case 'leavePreset':
      return { ...p, ...a.settings, presetId: undefined, beforePreset: undefined }
    case 'replace':
      return a.prefs
  }
}

/**
 * Drops settings that point at things that are gone (a deleted list, label, person or focused task),
 * so a filter can't silently match nothing. Returns the same object when nothing changed.
 */
export function cleanPrefs(p: ViewPrefs, data: BoardData): ViewPrefs {
  const cols = new Set(data.columns.map((c) => c.id))
  const labels = new Set(data.labels.map((l) => l.id))
  const people = new Set(['', ...data.members.map((m) => m.id)])
  const keepIn = (list: string[] | undefined, ok: Set<string>) => {
    if (!list) return list
    const next = list.filter((x) => ok.has(x))
    return next.length === list.length ? list : next.length ? next : undefined
  }
  const f = p.filter
  // Tests of the due and start dates that say something; "overdue" and its like win over another test of the due date.
  const dueIs = f.due ? undefined : f.dueIs && tidyDateTest(f.dueIs)
  const startIs = f.startIs && tidyDateTest(f.startIs)
  const filter: TableFilter = {
    ...f,
    statuses: keepIn(f.statuses, cols),
    labels: keepIn(f.labels, labels),
    // ("Me" is always someone to ask for: it's whoever is looking.)
    assignees: keepIn(f.assignees, new Set([...people, ME])),
    dueIs,
    startIs,
  }
  const hidden = p.display.board.hiddenColumns
  const nextHidden = keepIn(hidden, cols)
  const folded = p.display.board.collapsedColumns
  const nextFolded = keepIn(folded, cols)
  const order = p.display.board.listOrder
  const gone = order && Object.keys(order).some((id) => !cols.has(id))
  const kept = gone ? Object.fromEntries(Object.entries(order).filter(([id]) => cols.has(id))) : order
  const nextOrder = kept && !Object.keys(kept).length ? undefined : kept
  const focusId = p.focusId && data.tasks[p.focusId] ? p.focusId : undefined
  // The board's own fields: filters keep what their field can still use, and a column or a sort by a field that
  // left the board goes.
  const defs = new Map(data.fields.map((x) => [x.id, x]))
  const wanted = Object.entries(f.fields ?? {}).flatMap(([id, one]) => {
    const tidy = defs.has(id) ? tidyFilter(defs.get(id)!, one, (u) => people.has(u)) : undefined
    return tidy ? [[id, tidy] as const] : []
  })
  const sameFields = !!f.fields && wanted.length === Object.keys(f.fields).length && wanted.every(([id, one]) => f.fields![id] === one)
  filter.fields = sameFields || !f.fields ? f.fields : wanted.length ? Object.fromEntries(wanted) : undefined
  const o = p.outline
  const sort = o.sort && isFieldKey(o.sort.key) && !defs.has(fieldIdOf(o.sort.key)) ? undefined : o.sort
  const shownOff = o.hidden?.filter((k) => !isFieldKey(k) || defs.has(fieldIdOf(k)))
  const outlineHidden = !o.hidden || shownOff!.length === o.hidden.length ? o.hidden : shownOff!.length ? shownOff : undefined
  const arranged = o.order?.filter((k) => !isFieldKey(k) || defs.has(fieldIdOf(k)))
  const outlineOrder = !o.order || arranged!.length === o.order.length ? o.order : arranged!.length ? arranged : undefined
  const changed =
    filter.fields !== f.fields ||
    sort !== o.sort ||
    outlineHidden !== o.hidden ||
    outlineOrder !== o.order ||
    filter.statuses !== f.statuses ||
    filter.labels !== f.labels ||
    filter.assignees !== f.assignees ||
    dueIs !== f.dueIs ||
    startIs !== f.startIs ||
    nextHidden !== hidden ||
    nextFolded !== folded ||
    nextOrder !== order ||
    focusId !== p.focusId
  if (!changed) return p
  return {
    ...p,
    filter,
    outline:
      sort !== o.sort || outlineHidden !== o.hidden || outlineOrder !== o.order ? { ...o, sort, hidden: outlineHidden, order: outlineOrder } : o,
    focusId,
    display: { ...p.display, board: { ...p.display.board, hiddenColumns: nextHidden, collapsedColumns: nextFolded, listOrder: nextOrder } },
  }
}
