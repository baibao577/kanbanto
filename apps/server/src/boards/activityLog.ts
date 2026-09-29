import type { ActivityItem } from '@kanbanto/model/activity'
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import type { Db } from '../db'
import { boardActivity, comments, tasks, users } from '../db/schema'
import { HttpError } from '../http'

/** How long the activity log keeps changes (see pruneActivity). */
export const ACTIVITY_DAYS = 90

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
