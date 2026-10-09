import { linkRef, mapLinks, parseRef } from './fields'
import { newId } from './ids'
import { repairData, upgradeSave } from './migrate'
import { PassageSchema, type Passage } from './passages'
import { z } from 'zod'
import { BoardDataSchema } from './schema'
import type { BoardData } from './types'

/** The export file format this version writes. */
export const EXPORT_FORMAT = 3

/** The cards without their covers: a cover is one of a card's files, and files don't travel in a board's file. */
const uncovered = (tasks: BoardData['tasks']): BoardData['tasks'] =>
  Object.fromEntries(Object.entries(tasks).map(([id, { cover: _file, ...t }]) => [id, t]))

/** A board without its covers (see `uncovered`): what goes in an export file, and what comes out of one. */
export const withoutCovers = (data: BoardData): BoardData =>
  [...Object.values(data.tasks), ...Object.values(data.archived ?? {})].some((t) => t.cover)
    ? { ...data, tasks: uncovered(data.tasks), ...(data.archived && { archived: uncovered(data.archived) }) }
    : data

/**
 * What was said and logged on a board's cards: its comments and its logged time, which the board itself doesn't
 * hold. They can go in its file (`exportFile`), each naming who it was by: the name to read, and the account's id,
 * which only means something on the site the file came from.
 */
export interface BoardExtras {
  /**
   * `passage`: it is about those words of its card's description (see passages.ts); `resolved`: and settled.
   * `replyTo`: it answers the comment with that `id` (ids only mean something inside the file).
   */
  comments: {
    taskId: string
    by: { id: string; name: string } | null
    body: string
    at: string
    id?: string
    passage?: Passage
    replyTo?: string
    resolved?: boolean
  }[]
  time: { taskId: string; by: { id: string; name: string } | null; day: string; minutes: number; note: string; at: string }[]
}

/** The most of each a file brings: more than a board is likely to have, and few enough to read in one go. */
export const EXTRAS_MAX = { comments: 50_000, time: 100_000 }

/**
 * An export file's contents: the board, and with `extras` its comments and logged time too. (The same format either
 * way: a reader that doesn't know them reads the board and leaves them.)
 */
export const exportFile = (data: BoardData, extras?: BoardExtras) => ({
  app: 'kanbanto',
  format: EXPORT_FORMAT,
  exportedAt: new Date().toISOString(),
  data: withoutCovers(data),
  ...(extras && { comments: extras.comments, time: extras.time }),
})

const who = z
  .object({ id: z.string().max(100), name: z.string().max(200) })
  .nullable()
  .catch(null)
const moment = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)))
const saidItem = z.object({
  taskId: z.string().min(1).max(100),
  by: who,
  body: z.string().min(1).max(10_000),
  at: moment,
  // (What a comment about a passage adds. Out of shape, it comes as a plain comment.)
  id: z.string().max(100).optional().catch(undefined),
  passage: PassageSchema.optional().catch(undefined),
  replyTo: z.string().max(100).optional().catch(undefined),
  resolved: z.boolean().optional().catch(undefined),
})
const timeItem = z.object({
  taskId: z.string().min(1).max(100),
  by: who,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minutes: z.number().int().min(1).max(1440),
  note: z.string().max(500).catch(''),
  at: moment,
})

/**
 * The comments and logged time a board's file brings (already parsed from JSON), for the cards it has. A file
 * without any, or from before they could be in one, brings none; an entry that isn't in shape is left out, and the
 * rest still come.
 */
export function readExtras(raw: unknown): BoardExtras {
  const file = (raw && typeof raw === 'object' ? raw : {}) as { comments?: unknown; time?: unknown }
  const list = <T>(items: unknown, one: z.ZodType<T>, max: number): T[] =>
    Array.isArray(items) ? items.slice(0, max).flatMap((item) => one.safeParse(item).data ?? []) : []
  return { comments: list(file.comments, saidItem, EXTRAS_MAX.comments), time: list(file.time, timeItem, EXTRAS_MAX.time) }
}

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
    return rehomed(withoutCovers(repairData(parsed.data as BoardData)), boardId)
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

/**
 * A board read from a file, under the id it gets here. Its card links to its own cards follow it; links to cards on
 * other boards don't travel with a file, and a link field that pointed at this board points at it still.
 */
function rehomed(data: BoardData, boardId: string): BoardData {
  const was = data.board.id
  const links = new Set(data.fields.filter((f) => f.type === 'link').map((f) => f.id))
  if (!links.size) return { ...data, board: { ...data.board, id: boardId } }
  const own = (ref: string) => {
    const to = parseRef(ref)
    return to && to.boardId === was ? linkRef(boardId, to.taskId) : null
  }
  const moved = (tasks: BoardData['tasks']) =>
    Object.fromEntries(
      Object.entries(tasks).map(([id, t]) => {
        const custom = mapLinks(t.custom, links, own)
        if (custom === t.custom) return [id, t]
        const { custom: _held, ...rest } = t
        return [id, custom ? { ...rest, custom } : rest]
      }),
    )
  return {
    ...data,
    board: { ...data.board, id: boardId },
    fields: data.fields.map((f) => (f.type === 'link' && f.board === was ? { ...f, board: boardId } : f)),
    tasks: moved(data.tasks),
    ...(data.archived && { archived: moved(data.archived) }),
  }
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
