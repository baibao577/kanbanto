import type { ActivityItem } from '@kanbanto/model/activity'
import type { TimeEntryView, TimeMine, WeekView } from '@kanbanto/model/api'
import { fromDay, normalizeTaskDate, toDay, weekdayOf } from '@kanbanto/model/dates'
import { newId } from '@kanbanto/model/ids'
import { MAX_MINUTES } from '@kanbanto/model/time'
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { atLeast, requireAccess, workspaceRole, type Access, type BoardRow } from '../boards/access'
import type { SessionUser } from '../auth/sessions'
import type { Db, Tx } from '../db'
import { boardActivity, comments, lists, planningPeople, tasks, timeEntries, users } from '../db/schema'
import { HttpError, parse } from '../http'
import { dayIn } from '../mail/digest'
import { requireUser } from './auth'
import { boardsFor } from './boards'

/**
 * Time logged on cards. Editors and owners log; everyone on the board sees it (not visitors with the public link).
 * You change your own entries; a board owner, or an admin of the board's workspace, can fix anyone's.
 */

const Params = z.object({ id: z.string().min(1).max(100) })
const TaskParams = Params.extend({ taskId: z.string().min(1).max(100) })
const EntryParams = Params.extend({ entryId: z.uuid() })
const Day = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && normalizeTaskDate(v) === v, 'Days look like 2026-10-02.')
const Note = z
  .string()
  .trim()
  .max(200, 'Keep the note under 200 characters.')
  .refine((n) => !n.includes('\u0000'), 'Notes can’t contain NUL characters.')
const Minutes = z.number().int().min(1, 'That’s no time at all.').max(MAX_MINUTES, 'One entry can be up to 24h.')
const Log = z.object({ minutes: Minutes, day: Day, note: Note.default('') })
const Edit = z.object({ minutes: Minutes, day: Day, note: Note }).partial()
const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
const Zone = z.string().max(64).refine(validZone, 'That isn’t a time zone.').default('UTC')
const MineQuery = z.object({ day: Day, timeZone: Zone })
const WeekQuery = z.object({
  from: Day.refine((v) => weekdayOf(toDay(v)) === 1, 'A week starts on a Monday.'),
  timeZone: Zone,
})

type Entry = typeof timeEntries.$inferSelect
const editor = alias(users, 'editor')

/** Who may change which entries: their author while they can edit the board, its owners, its workspace's admins. */
async function changeRule(db: Db | Tx, me: SessionUser, board: BoardRow, access: Access) {
  const admin = !!board.workspaceId && (await workspaceRole(db, board.workspaceId, me.id)) === 'admin'
  const archived = !!board.archivedAt
  return (e: Pick<Entry, 'userId'>) => !archived && (e.userId === me.id ? atLeast(access.role, 'editor') : access.role === 'owner' || admin)
}

async function entryViews(db: Db | Tx, where: ReturnType<typeof and>, canEdit: (e: Entry) => boolean): Promise<TimeEntryView[]> {
  const rows = await db
    .select({ e: timeEntries, userName: users.name, editorName: editor.name })
    .from(timeEntries)
    .leftJoin(users, eq(users.id, timeEntries.userId))
    .leftJoin(editor, eq(editor.id, timeEntries.editedBy))
    .where(where)
    .orderBy(desc(timeEntries.day), desc(timeEntries.createdAt))
  return rows.map(({ e, userName, editorName }) => ({
    id: e.id,
    boardId: e.boardId,
    taskId: e.taskId,
    user: e.userId ? { id: e.userId, name: userName ?? 'Someone' } : null,
    day: e.day,
    minutes: e.minutes,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    editedBy: e.editedBy ? { id: e.editedBy, name: editorName ?? 'Someone' } : null,
    canEdit: canEdit(e),
  }))
}

/** Minutes logged on each card of a board that still exists, archived ones included (for the totals on cards). */
export async function timeCounts(db: Db | Tx, boardId: string) {
  const rows = await db
    .select({ taskId: timeEntries.taskId, n: sql<number>`sum(${timeEntries.minutes})::int` })
    .from(timeEntries)
    .innerJoin(tasks, and(eq(tasks.boardId, timeEntries.boardId), eq(tasks.id, timeEntries.taskId)))
    .where(eq(timeEntries.boardId, boardId))
    .groupBy(timeEntries.taskId)
  return Object.fromEntries(rows.map((r) => [r.taskId, r.n]))
}

/**
 * Time logged on some boards' cards (cards that still exist, archived ones included), in minutes by board, then by
 * account: what Planning counts as actual man-days.
 */
export async function loggedOn(db: Db | Tx, boardIds: string[]): Promise<Record<string, Record<string, number>>> {
  if (!boardIds.length) return {}
  const rows = await db
    .select({ boardId: timeEntries.boardId, userId: timeEntries.userId, n: sql<number>`sum(${timeEntries.minutes})::int` })
    .from(timeEntries)
    .innerJoin(tasks, and(eq(tasks.boardId, timeEntries.boardId), eq(tasks.id, timeEntries.taskId)))
    .where(and(inArray(timeEntries.boardId, boardIds), isNotNull(timeEntries.userId)))
    .groupBy(timeEntries.boardId, timeEntries.userId)
  const out: Record<string, Record<string, number>> = {}
  for (const r of rows) (out[r.boardId] ??= {})[r.userId!] = r.n
  return out
}

/** Your hours a day: from your place in a workspace's plan (the board's, or the first that has you), or 8. */
async function hoursPerDay(db: Db | Tx, userId: string, workspaceId?: string | null) {
  if (workspaceId === null) return 8
  const [p] = await db
    .select({ h: planningPeople.hoursPerDay })
    .from(planningPeople)
    .where(and(eq(planningPeople.userId, userId), workspaceId ? eq(planningPeople.workspaceId, workspaceId) : undefined))
    .orderBy(asc(planningPeople.createdAt))
    .limit(1)
  return p?.h ?? 8
}

/**
 * The cards you touched (changed, moved, commented on) on some boards between two days, by the day they fall on in
 * your time zone: `${boardId}:${taskId}` → days, latest touch first in the map's order.
 */
async function touchedCards(db: Db | Tx, userId: string, boardIds: string[], first: string, last: string, tz: string) {
  const out = new Map<string, Set<string>>()
  if (!boardIds.length) return out
  // A day either side, then sorted out by the day each falls on where you are.
  const from = new Date((toDay(first) - 1) * 86_400_000)
  const until = new Date((toDay(last) + 2) * 86_400_000)
  const changes = await db
    .select({ at: boardActivity.at, boardId: boardActivity.boardId, items: boardActivity.items })
    .from(boardActivity)
    .where(and(inArray(boardActivity.boardId, boardIds), eq(boardActivity.actorId, userId), gte(boardActivity.at, from), lt(boardActivity.at, until)))
  const said = await db
    .select({ at: comments.createdAt, boardId: comments.boardId, taskId: comments.taskId })
    .from(comments)
    .where(and(inArray(comments.boardId, boardIds), eq(comments.authorId, userId), gte(comments.createdAt, from), lt(comments.createdAt, until)))
  const touches = [
    ...changes.flatMap((c) => (c.items as ActivityItem[]).flatMap((i) => (i.taskId ? [{ at: c.at, boardId: c.boardId, taskId: i.taskId }] : []))),
    ...said,
  ].sort((a, b) => b.at.getTime() - a.at.getTime())
  for (const t of touches) {
    const day = dayIn(t.at, tz)
    if (day < first || day > last) continue
    const key = `${t.boardId}:${t.taskId}`
    if (!out.has(key)) out.set(key, new Set())
    out.get(key)!.add(day)
  }
  return out
}

/** Tells everyone on the board a card's new total. */
async function announce(app: FastifyInstance, boardId: string, taskId: string) {
  const [r] = await app.db
    .select({ n: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int` })
    .from(timeEntries)
    .where(and(eq(timeEntries.boardId, boardId), eq(timeEntries.taskId, taskId)))
  app.hub.broadcast(boardId, { type: 'time', taskId, total: r?.n ?? 0 })
}

/** An entry on a board you can see, and whether you may change it. */
async function entryFor(app: FastifyInstance, me: SessionUser, boardId: string, entryId: string) {
  const { board, access } = await requireAccess(app.db, me, boardId, 'viewer', { write: true })
  if (access.via === 'public') throw new HttpError(403, 'Join this board to change its time.')
  const [e] = await app.db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.id, entryId), eq(timeEntries.boardId, boardId)))
  if (!e) throw new HttpError(404, 'That entry no longer exists.')
  if (!(await changeRule(app.db, me, board, access))(e))
    throw new HttpError(403, 'You can change your own time. A board owner or workspace admin can fix other people’s.')
  return e
}

/** Logs time on a card as `me` (an editor or owner of its board): the entry, as they see it. Shared with MCP. */
export async function logTimeOn(
  app: FastifyInstance,
  me: SessionUser,
  boardId: string,
  taskId: string,
  body: { minutes: number; day: string; note: string },
  via: string | null,
) {
  const { board, access } = await requireAccess(app.db, me, boardId, 'editor')
  const [card] = await app.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.boardId, boardId), eq(tasks.id, taskId)))
  if (!card) throw new HttpError(404, 'That card no longer exists.')
  const entryId = newId()
  await app.db.insert(timeEntries).values({ id: entryId, boardId, taskId, userId: me.id, ...body, via })
  const [entry] = await entryViews(app.db, eq(timeEntries.id, entryId), await changeRule(app.db, me, board, access))
  await announce(app, boardId, taskId)
  return entry
}

/** A card's entries, newest day first, as `viewer` sees them (for MCP's get_task). */
export async function cardTime(app: FastifyInstance, me: SessionUser, board: BoardRow, access: Access, taskId: string) {
  return entryViews(app.db, and(eq(timeEntries.boardId, board.id), eq(timeEntries.taskId, taskId)), await changeRule(app.db, me, board, access))
}

/** Minutes each person logged on a board's cards from `from` (a day) on, by account. */
export async function loggedSince(db: Db | Tx, boardId: string, from: string) {
  const rows = await db
    .select({ userId: timeEntries.userId, name: users.name, n: sql<number>`sum(${timeEntries.minutes})::int` })
    .from(timeEntries)
    .leftJoin(users, eq(users.id, timeEntries.userId))
    .innerJoin(tasks, and(eq(tasks.boardId, timeEntries.boardId), eq(tasks.id, timeEntries.taskId)))
    .where(and(eq(timeEntries.boardId, boardId), gte(timeEntries.day, from)))
    .groupBy(timeEntries.userId, users.name)
  return rows.map((r) => ({ userId: r.userId, name: r.name ?? 'Someone who left', minutes: r.n }))
}

export const timeRoutes: FastifyPluginAsync = async (app) => {
  /** A card's time, newest day first. */
  app.get('/boards/:id/tasks/:taskId/time', async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    const me = requireUser(req.user)
    const { board, access } = await requireAccess(app.db, me, id, 'viewer')
    if (access.via === 'public') throw new HttpError(403, 'Join this board to see its time.')
    const may = await changeRule(app.db, me, board, access)
    return {
      entries: await entryViews(app.db, and(eq(timeEntries.boardId, id), eq(timeEntries.taskId, taskId)), may),
      canLog: atLeast(access.role, 'editor') && !board.archivedAt,
    }
  })

  /** Logs time on a card (editors and owners). */
  app.post('/boards/:id/tasks/:taskId/time', async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    const me = requireUser(req.user)
    return { entry: await logTimeOn(app, me, id, taskId, parse(Log, req.body), req.apiToken?.app ?? null) }
  })

  /** Changes an entry's time, day or note. Someone else's, fixed by an owner or admin, shows who did it. */
  app.patch('/boards/:id/time/:entryId', async (req) => {
    const { id, entryId } = parse(EntryParams, req.params)
    const me = requireUser(req.user)
    const e = await entryFor(app, me, id, entryId)
    const body = parse(Edit, req.body)
    await app.db
      .update(timeEntries)
      .set({ ...body, updatedAt: new Date(), ...(e.userId !== me.id && { editedBy: me.id }) })
      .where(eq(timeEntries.id, entryId))
    const { board, access } = await requireAccess(app.db, me, id, 'viewer', { write: true })
    const [entry] = await entryViews(app.db, eq(timeEntries.id, entryId), await changeRule(app.db, me, board, access))
    await announce(app, id, e.taskId)
    return { entry }
  })

  app.delete('/boards/:id/time/:entryId', async (req) => {
    const { id, entryId } = parse(EntryParams, req.params)
    const me = requireUser(req.user)
    const e = await entryFor(app, me, id, entryId)
    await app.db.delete(timeEntries).where(eq(timeEntries.id, entryId))
    await announce(app, id, e.taskId)
    return { ok: true }
  })

  /** For the log box on a board: the cards you touched that day and logged on lately, and your day so far. */
  app.get('/boards/:id/time/mine', async (req): Promise<TimeMine> => {
    const { id } = parse(Params, req.params)
    const { day, timeZone } = parse(MineQuery, req.query)
    const me = requireUser(req.user)
    const { board } = await requireAccess(app.db, me, id, 'editor')
    const touched = await touchedCards(app.db, me.id, [id], day, day, timeZone)
    const recent = await app.db
      .select({ taskId: timeEntries.taskId })
      .from(timeEntries)
      .where(and(eq(timeEntries.boardId, id), eq(timeEntries.userId, me.id)))
      .orderBy(desc(timeEntries.createdAt))
      .limit(50)
    const [logged] = await app.db
      .select({ n: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int` })
      .from(timeEntries)
      .where(and(eq(timeEntries.userId, me.id), eq(timeEntries.day, day)))
    return {
      day,
      touched: [...touched.keys()].map((k) => k.slice(id.length + 1)),
      recent: [...new Set(recent.map((r) => r.taskId))].slice(0, 10),
      logged: logged?.n ?? 0,
      hoursPerDay: await hoursPerDay(app.db, me.id, board.workspaceId),
    }
  })

  /** My week: your time Monday to Sunday on every board you can open, and the cards to fill it in on. */
  app.get('/time/week', async (req): Promise<WeekView> => {
    const { from, timeZone } = parse(WeekQuery, req.query)
    return weekOf(app, requireUser(req.user), from, timeZone)
  })
}

/** Your week (from a Monday) on every board you can open: entries, the cards to show, the days you touched them. */
export async function weekOf(app: FastifyInstance, me: SessionUser, from: string, timeZone: string): Promise<WeekView> {
  const last = fromDay(toDay(from) + 6)
  const boards = await boardsFor(app.db, me.id)
  const byId = new Map(boards.map((b) => [b.id, b]))
  const ids = boards.map((b) => b.id)
  const active = boards.filter((b) => !b.archivedAt).map((b) => b.id)
  const canLog = (boardId: string) => {
    const b = byId.get(boardId)
    return !!b && !b.archivedAt && atLeast(b.role, 'editor')
  }

  const entries = ids.length
    ? await entryViews(
        app.db,
        and(eq(timeEntries.userId, me.id), inArray(timeEntries.boardId, ids), gte(timeEntries.day, from), lte(timeEntries.day, last)),
        (e) => canLog(e.boardId),
      )
    : []
  const touched = await touchedCards(app.db, me.id, active, from, last, timeZone)
  const assigned = active.length
    ? await app.db
        .select({ boardId: tasks.boardId, taskId: tasks.id })
        .from(tasks)
        .innerJoin(lists, and(eq(lists.boardId, tasks.boardId), eq(lists.id, tasks.status)))
        .where(and(eq(tasks.assigneeId, me.id), inArray(tasks.boardId, active), isNull(tasks.archivedAt), ne(lists.category, 'done')))
        .limit(100)
    : []

  // The rows: cards logged on, touched, then assigned (each once), as long as the card still exists.
  const keys = [
    ...new Set([...entries.map((e) => `${e.boardId}:${e.taskId}`), ...touched.keys(), ...assigned.map((a) => `${a.boardId}:${a.taskId}`)]),
  ]
  const wanted = keys.map((k) => {
    const i = k.indexOf(':')
    return { boardId: k.slice(0, i), taskId: k.slice(i + 1) }
  })
  const found = wanted.length
    ? await app.db
        .select({ boardId: tasks.boardId, id: tasks.id, title: tasks.title, parentId: tasks.parentId, category: lists.category })
        .from(tasks)
        .leftJoin(lists, and(eq(lists.boardId, tasks.boardId), eq(lists.id, tasks.status)))
        .where(
          sql`(${tasks.boardId}, ${tasks.id}) in (${sql.join(
            wanted.map((w) => sql`(${w.boardId}, ${w.taskId})`),
            sql`, `,
          )})`,
        )
    : []
  const parents = found.filter((f) => f.parentId)
  const parentTitles = parents.length
    ? await app.db
        .select({ boardId: tasks.boardId, id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(
          sql`(${tasks.boardId}, ${tasks.id}) in (${sql.join(
            parents.map((p) => sql`(${p.boardId}, ${p.parentId})`),
            sql`, `,
          )})`,
        )
    : []
  const parentTitle = new Map(parentTitles.map((p) => [`${p.boardId}:${p.id}`, p.title]))
  const card = new Map(found.map((f) => [`${f.boardId}:${f.id}`, f]))
  const cards = keys.flatMap((k) => {
    const f = card.get(k)
    if (!f) return []
    return [
      {
        boardId: f.boardId,
        taskId: f.id,
        title: f.title,
        parent: f.parentId ? (parentTitle.get(`${f.boardId}:${f.parentId}`) ?? null) : null,
        boardName: byId.get(f.boardId)?.name ?? '',
        done: f.category === 'done',
        canLog: canLog(f.boardId),
      },
    ]
  })
  return {
    from,
    hoursPerDay: await hoursPerDay(app.db, me.id),
    entries: entries.filter((e) => card.has(`${e.boardId}:${e.taskId}`)),
    cards,
    touched: Object.fromEntries([...touched].map(([k, days]) => [k, [...days].sort()])),
  }
}
