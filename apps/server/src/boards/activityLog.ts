import type { ActivityItem } from '@kanbanto/model/activity'
import { newId } from '@kanbanto/model/ids'
import { and, desc, eq, gte, inArray, lt, lte, notInArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import { boardActivity, comments, tasks, timeEntries, users } from '../db/schema'
import { HttpError } from '../http'

/**
 * How long the activity log keeps changes (see pruneActivity). Long enough to look back on a couple of quarters
 * ("what was I working on in spring?"): a card itself only keeps its last change.
 */
export const ACTIVITY_DAYS = 180

/**
 * The commands logged time's lines are kept under ("logged 1h 30m on “Deploy”"). Such a line says when the time was
 * typed in, which is often not the day the work was done (that's the entry's own day): so it's part of the card's
 * history, but not a sign that the card was worked on at that moment.
 */
export const TIME_COMMANDS = ['time.log', 'time.change', 'time.remove']

/**
 * Writes one line about a card into the board's log, for what isn't a board command and so doesn't go through the
 * engine (a card's files, its logged time): `text` as the board's log reads it ("attached “a.pdf” to “Deploy”"),
 * `own` as the card's own history does ("attached “a.pdf”").
 */
export async function logLine(
  db: Db | Tx,
  line: { boardId: string; actorId: string; command: string; via?: string | null; item: ActivityItem & { taskId: string } },
) {
  await db
    .insert(boardActivity)
    .values({ id: newId(), boardId: line.boardId, actorId: line.actorId, command: line.command, items: [line.item], via: line.via ?? null })
}

/** One thing that happened on a board: a change (in words), or a comment. */
export type ActivityEntry = {
  at: Date
  boardId: string
  actorId: string | null
  actorName: string | null
} & (
  | { kind: 'change'; items: ActivityItem[]; command: string; via: string | null }
  | { kind: 'comment'; taskId: string; task: string | null; body: string; mentions: string[] }
)

/** What was done to one card at one time: its own lines of a change, who made it and through what. */
export interface TaskActivityEntry {
  at: Date
  actorId: string | null
  actorName: string | null
  actorPicture: string | null
  via: string | null
  items: ActivityItem[]
}

/**
 * One card's own history from the board's log, newest first: the lines about it (a change may hold lines about other
 * cards too: those are left out), back as far as the log goes. Comments aren't in it: a card's comments are their own
 * list. Returns up to `limit`, and whether there's more (then ask again with `until` set to the last one's `at`).
 *
 * (A line is tied to its card inside the row's `items`, so this asks the database which rows hold one for this card.
 * It reads the board's rows through `board_activity_board_idx`: quick enough on a board with tens of thousands.)
 */
export async function readTaskActivity(
  db: Db,
  q: { boardId: string; taskId: string; until: Date | null; limit: number },
): Promise<{ entries: TaskActivityEntry[]; more: boolean }> {
  const rows = await db
    .select({
      at: boardActivity.at,
      actorId: boardActivity.actorId,
      actorName: users.name,
      actorPicture: users.picture,
      via: boardActivity.via,
      items: boardActivity.items,
    })
    .from(boardActivity)
    .leftJoin(users, eq(users.id, boardActivity.actorId))
    .where(
      and(
        eq(boardActivity.boardId, q.boardId),
        sql`${boardActivity.items} @> ${JSON.stringify([{ taskId: q.taskId }])}::jsonb`,
        q.until ? lt(boardActivity.at, q.until) : undefined,
      ),
    )
    .orderBy(desc(boardActivity.at))
    .limit(q.limit + 1)
  return {
    entries: rows.slice(0, q.limit).map((r) => ({ ...r, items: (r.items as ActivityItem[]).filter((i) => i.taskId === q.taskId) })),
    more: rows.length > q.limit,
  }
}

const UNITS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/**
 * A moment from what people (and assistants) type: an ISO date or date-time, or a time back from now like "24h", "3d"
 * or "2w". Undefined: `fallback`.
 */
export function parseMoment(v: string | undefined, name: string, fallback: Date | null): Date | null {
  if (v === undefined || v === '') return fallback
  const back = v.trim().match(/^(\d+)\s*(h|d|w)$/i)
  const d = back ? new Date(Date.now() - Number(back[1]) * UNITS[back[2].toLowerCase() as 'h' | 'd' | 'w']) : new Date(v)
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${name} looks like 2026-10-01, 2026-10-01T09:00:00Z, or 24h / 3d / 2w.`)
  return d
}

/**
 * What happened on some boards between `from` and `until` (not including it), newest first: changes and comments,
 * optionally only by some people. Returns up to `limit`, and whether there's more (then ask again with `until` set to
 * the last one's `at`).
 */
export async function readActivity(
  db: Db,
  q: { boardIds: string[]; from: Date; until: Date | null; actors: string[] | null; limit: number },
): Promise<{ entries: ActivityEntry[]; more: boolean }> {
  if (!q.boardIds.length) return { entries: [], more: false }
  const changes = await db
    .select({
      at: boardActivity.at,
      boardId: boardActivity.boardId,
      actorId: boardActivity.actorId,
      actorName: users.name,
      items: boardActivity.items,
      command: boardActivity.command,
      via: boardActivity.via,
    })
    .from(boardActivity)
    .leftJoin(users, eq(users.id, boardActivity.actorId))
    .where(
      and(
        inArray(boardActivity.boardId, q.boardIds),
        gte(boardActivity.at, q.from),
        q.until ? lt(boardActivity.at, q.until) : undefined,
        q.actors ? inArray(boardActivity.actorId, q.actors) : undefined,
      ),
    )
    .orderBy(desc(boardActivity.at))
    .limit(q.limit + 1)
  const said = await db
    .select({
      at: comments.createdAt,
      boardId: comments.boardId,
      actorId: comments.authorId,
      actorName: users.name,
      taskId: comments.taskId,
      task: tasks.title,
      body: comments.body,
      mentions: comments.mentions,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorId))
    .leftJoin(tasks, and(eq(tasks.boardId, comments.boardId), eq(tasks.id, comments.taskId)))
    .where(
      and(
        inArray(comments.boardId, q.boardIds),
        gte(comments.createdAt, q.from),
        q.until ? lt(comments.createdAt, q.until) : undefined,
        q.actors ? inArray(comments.authorId, q.actors) : undefined,
      ),
    )
    .orderBy(desc(comments.createdAt))
    .limit(q.limit + 1)
  const all: ActivityEntry[] = [
    ...changes.map((c) => ({ ...c, kind: 'change' as const, items: c.items as ActivityItem[] })),
    ...said.map((c) => ({ ...c, kind: 'comment' as const })),
  ].sort((x, y) => y.at.getTime() - x.at.getTime())
  return { entries: all.slice(0, q.limit), more: all.length > q.limit }
}

/** A sign that a card was worked on, besides its own dates (made, last changed, done, archived). */
export type WorkSign = 'commented' | 'time logged' | 'changed'

/**
 * Signs of work on some boards' cards in a stretch of time (`from` up to, not including, `to`; either may be open):
 * a comment written then, time logged for a day in it (`dayOf`: the day a moment falls on where the person asking
 * is), a change in the activity log (which goes back ACTIVITY_DAYS days: before that, only a card's last change is
 * known, from the card itself). `${boardId}:${taskId}` → the signs found.
 */
export async function workSigns(
  db: Db,
  boardIds: string[],
  from: Date | null,
  to: Date | null,
  dayOf: (moment: Date) => string,
): Promise<Map<string, Set<WorkSign>>> {
  const out = new Map<string, Set<WorkSign>>()
  if (!boardIds.length) return out
  const add = (boardId: string, taskId: string, sign: WorkSign) => {
    const key = `${boardId}:${taskId}`
    const signs = out.get(key)
    if (signs) signs.add(sign)
    else out.set(key, new Set([sign]))
  }
  const commented = await db
    .selectDistinct({ boardId: comments.boardId, taskId: comments.taskId })
    .from(comments)
    .where(and(inArray(comments.boardId, boardIds), from ? gte(comments.createdAt, from) : undefined, to ? lt(comments.createdAt, to) : undefined))
  for (const c of commented) add(c.boardId, c.taskId, 'commented')
  const logged = await db
    .selectDistinct({ boardId: timeEntries.boardId, taskId: timeEntries.taskId })
    .from(timeEntries)
    .where(
      and(
        inArray(timeEntries.boardId, boardIds),
        from ? gte(timeEntries.day, dayOf(from)) : undefined,
        // (`to` isn't part of the stretch: the day just before it is the last one.)
        to ? lte(timeEntries.day, dayOf(new Date(to.getTime() - 1))) : undefined,
      ),
    )
  for (const e of logged) add(e.boardId, e.taskId, 'time logged')
  const changes = await db
    .select({ boardId: boardActivity.boardId, items: boardActivity.items })
    .from(boardActivity)
    .where(
      and(
        inArray(boardActivity.boardId, boardIds),
        // (Time shows by the day it was logged for, just above.)
        notInArray(boardActivity.command, TIME_COMMANDS),
        from ? gte(boardActivity.at, from) : undefined,
        to ? lt(boardActivity.at, to) : undefined,
      ),
    )
  for (const c of changes) for (const item of c.items as ActivityItem[]) if (item.taskId) add(c.boardId, item.taskId, 'changed')
  return out
}
