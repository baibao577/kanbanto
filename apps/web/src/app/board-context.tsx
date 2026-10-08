import { createContext, useContext, type Dispatch } from 'react'
import type { Command, TaskFields } from '@kanbanto/model/commands'
import type { TaskIndex } from '@kanbanto/model/indexer'
import type { Change } from '@kanbanto/model/records'
import type { PrefsAction, ViewPrefs } from '@kanbanto/model/prefs'
import type { BoardAccess, TaskCounts } from '@kanbanto/model/api'
import type { CardTemplate } from '@kanbanto/model/templates'
import type { LinkStore } from '@/data/links'
import type { TaskActivity } from '@/data/sync'
import type { BoardData } from '@kanbanto/model/types'

export interface BoardContextValue {
  /** Board data (shared; read-only here — change it with `run`). */
  data: BoardData
  /** This person's view settings. */
  prefs: ViewPrefs
  setPrefs: Dispatch<PrefsAction>
  /** Everything derived from the tasks (tree, rolled-up status, progress). */
  idx: TaskIndex
  /** Runs a command. If it isn't allowed, shows why and returns false. */
  run: (cmd: Command) => boolean
  /**
   * Takes in a change the server made for you outside `run` (cards added from a spreadsheet): it shows at once, and
   * `done` is said with an Undo button, which takes it back like any change of yours.
   */
  adopt: (seq: number, changes: Change[], done: string) => void
  /** Takes back your last change to the board, and says what it was. */
  undo: () => void
  /** Fetches the board again, after changing something about it that isn't a command (which fields it uses). */
  reload: () => void
  /** Your role on this board, and why you have it. */
  access: BoardAccess
  /** You can view but not change this board: editing controls are hidden. */
  readOnly: boolean
  /** Opens the Share dialog. */
  openShare: () => void
  /** Comments, files and logged minutes per card. */
  counts: TaskCounts
  /** You can comment (members, viewers included). */
  canComment: boolean
  /** Listen for comments and files changing (live). Returns a function that stops listening. */
  onActivity: (listener: (m: TaskActivity) => void) => () => void
  /** Open the task detail dialog. */
  openTask: (id: string) => void
  /** Asks where to move a task (with its subtasks) on another board. */
  moveToBoard: (id: string) => void
  /** Create a task (defaults: under the focused task, first "not started" list). Returns its id, or null if refused. */
  createTask: (
    parentId: string | null | undefined,
    fields: TaskFields & { title: string },
    opts?: { open?: boolean; rankAfter?: string },
  ) => string | null
  /** The board's card templates (see model templates.ts), by name. Kept up to date as people save and remove them. */
  templates: CardTemplate[]
  /**
   * Adds a card from one of them, with its subtasks, as one change: in `status` (left out: the first "not started"
   * list), under `parentId` (left out: the focused task), with what else `top` says about where it was put. Says so,
   * with Undo. Returns the new card's id, or null if it was refused.
   */
  addFromTemplate: (
    template: CardTemplate,
    to?: { status?: string; parentId?: string | null; top?: TaskFields },
    opts?: { open?: boolean },
  ) => string | null
  /** Show only this task's subtasks (or everything, with no id). */
  focus: (id?: string) => void
  /** A member's name ('' if unknown). */
  memberName: (id: string | undefined) => string
  /** What the cards' links point at, for you (see LinkStore). The same object for as long as the board is open. */
  links: LinkStore
  /** Some card link is in use in this board's space: a card here may have cards linking to it. */
  canBeLinked: boolean
  /** Opens the log box (with a card already picked). Missing when you can't log time here. */
  logTime?: (taskId?: string) => void
}

export const BoardContext = createContext<BoardContextValue | null>(null)

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext)
  if (!ctx) throw new Error('useBoard must be used inside <BoardContext>')
  return ctx
}

/** True when you can view but not change the open board (false outside a board). */
export const useReadOnly = () => useContext(BoardContext)?.readOnly ?? false
