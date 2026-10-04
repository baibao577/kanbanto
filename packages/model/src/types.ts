import type { BoardBackground, ColorName } from './colors'

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
  background?: BoardBackground
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

/**
 * A reminder on a task, for whoever is assigned when it fires (or `by`, when nobody is). Either at a moment (`at`, UTC),
 * or some minutes before the task is due (`beforeDue`, following the due date; a whole-day due date counts as 9:00
 * in `tz`, the time zone of the person who set it). See reminders.ts.
 */
export interface Reminder {
  id: string
  at?: string
  beforeDue?: number
  tz?: string
  /** Who set it (a member id). */
  by?: string
}

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
  reminders?: Reminder[]
  /** When it was archived (with its subtasks): then it's in `BoardData.archived`, out of every view and count. */
  archivedAt?: string
  /**
   * Kept from the moment it was archived, whatever happens to the lists later: the list it was in (by name), and
   * whether that meant finished (a done list): "archived as completed".
   */
  archivedList?: string
  archivedDone?: boolean
  /**
   * The last real work on it: moved to another list or edited (see ACTIVE_FIELDS). Reordering doesn't count. Unset on
   * older cards: `updatedAt` stands in. Card age also counts its subtasks and comments (see age.ts).
   */
  activeAt?: string
  /**
   * When it got done: the moment it entered a done list (kept while it stays in one, and through archiving). Unset
   * while it isn't done. What a parent whose list follows its subtasks shows is worked out from theirs (see the index);
   * archived as completed, it's written here, since the index only covers what's on the board.
   */
  doneAt?: string
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
export type ParentDisplay = 'label' | 'checklist' | 'progress' | 'rowHeader' | 'age'

/** The display settings of a board or list: the four settings every view is made of. */
export interface ViewConfig {
  columns: ColumnsBy
  rows: RowsBy
  filter: Filter
  parentDisplay: ParentDisplay[]
  /** Status lists hidden from this view (and the cards in them). */
  hiddenColumns?: string[]
  /** Status lists folded to a narrow strip (their name and how many cards), to make room for the others. */
  collapsedColumns?: string[]
  /**
   * Inside each list, show subtasks under a header for their parent instead of showing the parent as a card.
   * Only tasks without subtasks are cards; a parent appears as a header in every list where its subtasks are.
   */
  groupByParent?: boolean
  /**
   * Lists of finished work (category done): every card, or only cards done or touched in the last `doneDays` days
   * (the rest behind "N older · Show"). Unset: recent.
   */
  doneLists?: DoneLists
  /** For recent done lists; unset: DONE_DAYS. */
  doneDays?: number
  /**
   * Status lists shown in another order than the one their cards were dragged into (list id → what by). Only how
   * the list is shown: the order made by hand is kept, and is back when the entry is removed.
   */
  listOrder?: Record<string, ListOrder>
}

/** What a list's cards can be ordered by: most important first, soonest due first, A to Z. Without one: last. */
export const LIST_ORDERS = ['priority', 'due', 'title'] as const
export type ListOrder = (typeof LIST_ORDERS)[number]

export type DoneLists = 'all' | 'recent'
export const DONE_DAYS = 14

/** Where you are, what you searched for and how you filtered; shared by every tab. */
export interface Scope {
  /** Show only this task's subtasks ("focus"). */
  focusId?: string
  search?: string
  /** Only tasks that pass this test are shown as cards (see model/table.ts). */
  keep?: (id: string) => boolean
  /** The time now (ms), for recent done lists; without it, done lists show every card. */
  now?: number
  /** Done lists opened to show their older cards too (list ids). */
  showOlder?: ReadonlySet<string>
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
   * or go for good with task.delete. The server holds them all; the app is sent a board without them and asks for
   * the ones it needs (an archived card someone opens), so there this is only the ones it has. (Missing: none.)
   */
  archived?: TaskMap
}
