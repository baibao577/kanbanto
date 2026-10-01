import type { OutlineConfig, TableFilter } from './table'
import type { BoardData, Layout, ViewConfig } from './types'

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

/** What a board preset keeps: the filters, and how the Board and Outline look (not which tab is open). */
export type PresetSettings = Pick<ViewPrefs, 'filter' | 'display' | 'outline'>

export const presetOf = (p: ViewPrefs): PresetSettings => ({ filter: p.filter, display: p.display, outline: p.outline })

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
  const filter: TableFilter = {
    ...f,
    statuses: keepIn(f.statuses, cols),
    labels: keepIn(f.labels, labels),
    assignees: keepIn(f.assignees, people),
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
  const changed =
    filter.statuses !== f.statuses ||
    filter.labels !== f.labels ||
    filter.assignees !== f.assignees ||
    nextHidden !== hidden ||
    nextFolded !== folded ||
    nextOrder !== order ||
    focusId !== p.focusId
  if (!changed) return p
  return {
    ...p,
    filter,
    focusId,
    display: { ...p.display, board: { ...p.display.board, hiddenColumns: nextHidden, collapsedColumns: nextFolded, listOrder: nextOrder } },
  }
}
