import { newId } from './ids'
import { repairData, upgradeSave } from './migrate'
import { BoardDataSchema } from './schema'
import type { BoardData } from './types'

/** The export file format this version writes. */
export const EXPORT_FORMAT = 3

/** An export file's contents. */
export const exportFile = (data: BoardData) => ({ app: 'kanbanto', format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), data })

/**
 * Reads an exported board (already parsed from JSON): the current format (checked against the schema) or any
 * older export (prototype task lists, v2 exports), which are converted. The result takes over `boardId`.
 * Throws with a readable message if it isn't a board.
 */
export function readBoardFile(raw: unknown, boardId: string): BoardData {
  const file = raw as { app?: string; format?: number; data?: unknown }
  if (file && typeof file === 'object' && file.format === EXPORT_FORMAT) {
    const parsed = BoardDataSchema.safeParse(file.data)
    if (!parsed.success) throw new Error('The file looks damaged: some of its data is missing or malformed.')
    const data = repairData(parsed.data as BoardData)
    return { ...data, board: { ...data.board, id: boardId } }
  }
  // Older exports: a bare task list, or { boardName, columns, labels, tasks }.
  const legacy = Array.isArray(raw) ? { tasks: raw } : raw
  const up = upgradeSave(legacy, { now: new Date().toISOString(), newId })
  if (!up) throw new Error('That file isn’t a board export.')
  // (Converted or not, what's stored passes the same checks: sizes, dates, ids.)
  const checked = BoardDataSchema.safeParse(up.data)
  if (!checked.success) throw new Error('The file looks damaged: some of its data is missing or malformed.')
  const data = repairData(checked.data as BoardData)
  return { ...data, board: { ...data.board, id: boardId } }
}

/** Same as `readBoardFile`, from the file's text. */
export function parseBoard(text: string, boardId: string): BoardData {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The file isn’t valid JSON.')
  }
  return readBoardFile(raw, boardId)
}
