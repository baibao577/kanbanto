import { createContext, useContext, type Dispatch } from 'react'
import type { Command, TaskFields } from '@kanbanto/model/commands'
import type { TaskIndex } from '@kanbanto/model/indexer'
import type { PrefsAction, ViewPrefs } from '@kanbanto/model/prefs'
import type { BoardAccess, TaskCounts } from '@kanbanto/model/api'
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
  /** Takes back your last change to the board, and says what it was. */
  undo: () => void
  /** Your role on this board, and why you have it. */
  access: BoardAccess
  /** You can view but not change this board: editing controls are hidden. */
  readOnly: boolean
  /** Opens the Share dialog. */
  openShare: () => void
  /** Comments and files per card. */
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
  /** Show only this task's subtasks (or everything, with no id). */
  focus: (id?: string) => void
  /** A member's name ('' if unknown). */
  memberName: (id: string | undefined) => string
}

export const BoardContext = createContext<BoardContextValue | null>(null)

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext)
  if (!ctx) throw new Error('useBoard must be used inside <BoardContext>')
  return ctx
}

/** True when you can view but not change the open board (false outside a board). */
export const useReadOnly = () => useContext(BoardContext)?.readOnly ?? false
