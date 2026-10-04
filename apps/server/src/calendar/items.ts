import { eq } from 'drizzle-orm'
import { openBoards } from '../boards/access'
import type { Db } from '../db'
import { calendarBoards } from '../db/schema'

/** The address of a card, for the link in its calendar event. */
export const taskUrl = (site: string, boardId: string, taskId: string) =>
  `${site}/#/b/${encodeURIComponent(boardId)}?task=${encodeURIComponent(taskId)}`

export interface CalendarBoard {
  id: string
  name: string
  /** The board's change number now, and what it was when the board was last sent to Google (null: never). */
  seq: number
  syncedSeq: number | null
  /** They left it out of their calendar. */
  off: boolean
}

/** The boards someone can open that aren't archived (by name), with what they chose for each. */
export async function calendarChoices(db: Db, userId: string): Promise<CalendarBoard[]> {
  const prefs = new Map((await db.select().from(calendarBoards).where(eq(calendarBoards.userId, userId))).map((p) => [p.boardId, p]))
  return (await openBoards(db, userId))
    .filter((b) => !b.archivedAt)
    .map((b) => ({ id: b.id, name: b.name, seq: b.seq, syncedSeq: prefs.get(b.id)?.syncedSeq ?? null, off: prefs.get(b.id)?.off ?? false }))
}

/** The boards in someone's calendar: the ones they can open, without archived boards and the ones they left out. */
export const boardsInCalendar = async (db: Db, userId: string) => (await calendarChoices(db, userId)).filter((b) => !b.off)

/** Leaves a board out of someone's calendar, or puts it back. Either way it's sent to Google again from scratch. */
export async function setBoardOff(db: Db, userId: string, boardId: string, off: boolean) {
  await db
    .insert(calendarBoards)
    .values({ userId, boardId, off })
    .onConflictDoUpdate({ target: [calendarBoards.userId, calendarBoards.boardId], set: { off, syncedSeq: null } })
}
