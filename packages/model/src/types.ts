import type { ColorName } from './colors'

/**
 * What a status column means. Roll-up, progress and "up next" read this, never the column name.
 * Order matters: backlog < todo < doing < done.
 */
export type Category = 'backlog' | 'todo' | 'doing' | 'done'

export const CATEGORIES: Category[] = ['backlog', 'todo', 'doing', 'done']
export const CATEGORY_LABEL: Record<Category, string> = {
  backlog: 'Backlog',
  todo: 'Not started',
  doing: 'In progress',
  done: 'Done',
}
export const CATEGORY_HINT: Record<Category, string> = {
  backlog: 'Planned, not ready yet',
  todo: 'Ready to start',
  doing: 'Being worked on',
  done: 'Finished',
}

/**
 * Bookkeeping every stored record carries, so a server can tell what changed and when.
 * `version` goes up by one on every change (for detecting conflicting edits later).
 */
export interface Meta {
  createdAt: string
  updatedAt: string
  version: number
}

/** A fixed timestamp for built-in records (default lists, the example board). */
export const EPOCH = '2026-01-01T00:00:00.000Z'
export const builtIn = (): Meta => ({ createdAt: EPOCH, updatedAt: EPOCH, version: 1 })

/** The board itself and its board-wide settings. */
export interface Board extends Meta {
  id: string
  name: string
  /** How a parent's status is decided. */
  mode: StatusMode
  /** Board background; unset = the default canvas. */
  background?: ColorName
  /** What the board is for, in a sentence or two (also how assistants tell boards apart). */
  description?: string
}

/** Someone tasks can be assigned to. Tasks point at members by id, so renaming a person is one change. */
export interface Member extends Meta {
  id: string
  name: string
}

/** A user-defined status list. */
export interface StatusColumn extends Meta {
  id: string
  name: string
  category: Category
  color?: ColorName
  /** Position key (see model/position.ts); lists are kept sorted by it. */
  position: string
}

/** A reusable label, shared by every card on the board. */
export interface LabelDef extends Meta {
  id: string
  /** May be empty: a color-only label, like Trello. */
  name: string
  color: ColorName
}

/** Default workflow. Ids match the old fixed statuses, so older saved data keeps working. */
export const DEFAULT_COLUMNS: StatusColumn[] = [
  { id: 'todo', name: 'To Do', category: 'todo', position: 'a1', ...builtIn() },
  { id: 'doing', name: 'Doing', category: 'doing', position: 'a2', ...builtIn() },
  { id: 'done', name: 'Done', category: 'done', position: 'a3', ...builtIn() },
]

/** New and example boards also get a Backlog list. */
export const EXAMPLE_COLUMNS: StatusColumn[] = [
  { id: 'backlog', name: 'Backlog', category: 'backlog', position: 'a0', ...builtIn() },
  ...DEFAULT_COLUMNS,
]

/** How important a task is, most first. Unset: no priority. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export type Priority = (typeof PRIORITIES)[number]
export const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' }

export interface Task extends Meta {
  id: string
  title: string
  parentId: string | null
  /** Id of a StatusColumn. */
  status: string
  /** Position among its siblings in the outline (a position key, see model/position.ts). */
  order: string
  /** Member id. */
  assigneeId?: string
  /** YYYY-MM-DD. With `due`, the task's timeline bar. */
  start?: string
  due?: string
  /** LabelDef ids. */
  labels: string[]
  blockedBy: string[]
  description?: string
  priority?: Priority
  /** When it was archived (with its subtasks): then it's in `BoardData.archived`, out of every view and count. */
  archivedAt?: string
  /** Timeline bar color; unset = its status color. */
  color?: ColorName
  /**
   * Position key within a board list, set when you drag cards around (Trello-style).
   * Separate from `order`, so reordering the board never reshuffles the outline.
   */
  rank?: string
}

export type StatusMode = 'manual' | 'derived'

/** The views of a board (the tabs). The web app describes each one in src/components/views.ts. */
export const LAYOUTS = ['board', 'timeline', 'outline'] as const
export type Layout = (typeof LAYOUTS)[number]

export type ColumnsBy = 'status' | 'parent'
/** rootParent = the task's project (top-level ancestor). */
export type RowsBy = 'none' | 'rootParent' | 'directParent' | 'assignee'
/**
 * leaves = tasks without subtasks; topLevel = projects;
 * main = every task once: the first level of cards, with subtasks listed on their parent's card instead of as cards.
 */
export type Filter = 'all' | 'leaves' | 'main' | 'topLevel' | 'actionable'
/** Independent on/off toggles for how parents show up; none on = hidden. */
export type ParentDisplay = 'label' | 'checklist' | 'progress' | 'rowHeader'

/** The display settings of a board or list: the four settings every view is made of. */
export interface ViewConfig {
  columns: ColumnsBy
  rows: RowsBy
  filter: Filter
  parentDisplay: ParentDisplay[]
  /** Status lists hidden from this view (and the cards in them). */
  hiddenColumns?: string[]
  /**
   * Inside each list, show subtasks under a header for their parent instead of showing the parent as a card.
   * Only tasks without subtasks are cards; a parent appears as a header in every list where its subtasks are.
   */
  groupByParent?: boolean
}

/** Where you are, what you searched for and how you filtered; shared by every tab. */
export interface Scope {
  /** Show only this task's subtasks ("focus"). */
  focusId?: string
  search?: string
  /** Only tasks that pass this test are shown as cards (see model/table.ts). */
  keep?: (id: string) => boolean
}

export type TaskMap = Record<string, Task>

/**
 * Everything that belongs to a board and would live on a server: the shared data.
 * (Per-person view settings are separate: see model/prefs.ts.)
 */
export interface BoardData {
  board: Board
  members: Member[]
  /** Kept sorted by `position`. */
  columns: StatusColumn[]
  labels: LabelDef[]
  tasks: TaskMap
  /**
   * Archived tasks, kept apart so views, counts and rules only ever see `tasks`. They come back with task.restore,
   * or go for good with task.delete. (Missing: none.)
   */
  archived?: TaskMap
}
