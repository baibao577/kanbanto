import type { ArchivedPage, BoardAccess, BoardSummary, Role } from '@kanbanto/model/api'
import { ARCHIVED_DATES, archivedFamily, archivedIn } from '@kanbanto/model/archived'
import { isBackground, type BoardBackground } from '@kanbanto/model/colors'
import { CommandSchema } from '@kanbanto/model/schema'
import { readBoardFile } from '@kanbanto/model/transfer'
import { newId } from '@kanbanto/model/ids'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { accessFor, accessOf, requireAccess, type BoardRow } from '../boards/access'
import { parseMoment, readActivity } from '../boards/activityLog'
import { createBoard, importBoard } from '../boards/service'
import { requireWorkspace } from '../boards/workspaces'
import type { Db } from '../db'
import { boardFavorites, boards, workspaces } from '../db/schema'
import { HttpError, parse } from '../http'
import { requireUser } from './auth'
import { commentCounts, lastComments } from './comments'
import { attachmentCounts, deleteBoardFiles } from './files'
import { timeCounts } from './time'

const background = z
  .string()
  .max(40)
  .refine(isBackground, 'That isn’t a board background.')
  .transform((v) => v as BoardBackground)
const CreateBoard = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the board a name.')
    .max(200)
    .refine((n) => !n.includes('\u0000'), 'Board names can’t contain NUL characters.'),
  background: background.optional(),
  template: z.enum(['empty', 'example']).default('empty'),
  /** Where it goes: a workspace you're in (shared with everyone in it), or your Personal space. */
  workspaceId: z.uuid().nullable().optional(),
})
const Params = z.object({ id: z.string().min(1).max(100) })
const ArchivedQuery = z.object({
  task: z.string().min(1).max(100).optional(),
  when: z.enum(ARCHIVED_DATES).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
})
const Mutation = z.object({ mutationId: z.string().min(1).max(100), command: CommandSchema })
const MB = 1024 * 1024

/**
 * Boards `userId` can open: theirs, ones they've been added to, and ones shared with a workspace they're in. Private
 * boards only for their owners (even in a workspace: its admins don't see them). Most recently active first.
 */
export async function boardsFor(db: Db, userId: string): Promise<BoardSummary[]> {
  const rows = await db.execute<{
    id: string
    name: string
    description: string | null
    background: string | null
    visibility: BoardRow['visibility']
    public_link: boolean
    workspace_id: string | null
    workspace_role: BoardRow['workspaceRole']
    role: Role | null
    in_workspace: boolean
    task_count: number
    done_count: number
    created_at: Date
    activity_at: Date
    archived_at: Date | null
    favorited_at: Date | null
  }>(sql`
      select b.id, b.name, b.description, b.background, b.visibility, b.public_link, b.workspace_id, b.workspace_role, m.role,
        (w.user_id is not null) as in_workspace, b.created_at, b.activity_at, b.archived_at, f.created_at as favorited_at,
        (select count(*)::int from tasks t where t.board_id = b.id and t.archived_at is null) as task_count,
        (select count(*)::int from tasks t join lists l on l.board_id = t.board_id and l.id = t.status
          where t.board_id = b.id and t.archived_at is null and l.category = 'done') as done_count
      from boards b
      left join board_members m on m.board_id = b.id and m.user_id = ${userId}
      left join workspace_members w on w.workspace_id = b.workspace_id and w.user_id = ${userId}
      left join board_favorites f on f.board_id = b.id and f.user_id = ${userId}
      where m.role is not null or (b.visibility = 'workspace' and w.user_id is not null)
      order by b.activity_at desc`)
  const summaries: BoardSummary[] = []
  for (const r of rows) {
    const board = {
      id: r.id,
      visibility: r.visibility,
      publicLink: false,
      workspaceId: r.workspace_id,
      workspaceRole: r.workspace_role,
    } as BoardRow
    const access = accessFor(board, r.role, r.in_workspace)
    if (!access) continue
    summaries.push({
      id: r.id,
      name: r.name,
      description: r.description,
      background: r.background,
      visibility: r.visibility,
      publicLink: r.public_link,
      workspaceId: r.workspace_id,
      role: access.role,
      via: access.via === 'workspace' ? 'workspace' : 'member',
      taskCount: r.task_count,
      doneCount: r.done_count,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.activity_at).toISOString(),
      archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
      favoritedAt: r.favorited_at ? new Date(r.favorited_at).toISOString() : null,
    })
  }
  return summaries
}

/** Where each board lives, by name: its workspace's name, "Personal" (yours), or "Shared with you". */
export async function withPlaces(db: Db, list: BoardSummary[]): Promise<(BoardSummary & { place: string })[]> {
  const ids = [...new Set(list.flatMap((b) => (b.workspaceId ? [b.workspaceId] : [])))]
  const names = new Map(
    ids.length
      ? (await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, ids))).map((w) => [w.id, w.name])
      : [],
  )
  return list.map((b) => ({
    ...b,
    place: b.workspaceId ? (names.get(b.workspaceId) ?? 'A workspace') : b.role === 'owner' ? 'Personal' : 'Shared with you',
  }))
}

export const boardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/boards', async (req) => ({ boards: await boardsFor(app.db, requireUser(req.user).id) }))

  app.post('/boards', async (req) => {
    const user = requireUser(req.user)
    const body = parse(CreateBoard, req.body)
    if (body.workspaceId) await requireWorkspace(app.db, body.workspaceId, user.id)
    return { id: await createBoard(app.db, user.id, body) }
  })

  app.post('/boards/import', { bodyLimit: 20 * MB }, async (req) => {
    const user = requireUser(req.user)
    const { file } = parse(z.object({ file: z.unknown() }), req.body)
    let data
    try {
      data = readBoardFile(file, newId())
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'That file isn’t a board export.')
    }
    return { id: await importBoard(app.db, user.id, data) }
  })

  /**
   * The board as it is now. Its archived cards aren't sent with it (a board can have many more of them than cards):
   * `GET /boards/:id/archived` gives them, and `?archived=all` sends everything at once (an export, a backup).
   */
  app.get('/boards/:id', async (req) => {
    const { id } = parse(Params, req.params)
    const { archived: withArchived } = parse(z.object({ archived: z.enum(['all']).optional() }), req.query)
    const { board, access } = await requireAccess(app.db, req.user, id, 'viewer')
    const { data: whole, seq } = await app.engine.snapshot(id)
    const { archived: _putAway, ...onBoard } = whole
    const data = withArchived ? whole : onBoard
    const counts = {
      comments: await commentCounts(app.db, id),
      attachments: await attachmentCounts(app.db, id),
      lastComment: await lastComments(app.db, id),
      // Who logged how much isn't for visitors with the public link.
      time: access.via === 'public' ? {} : await timeCounts(app.db, id),
    }
    // Visitors with the public link aren't told which workspace it's in.
    const [workspace] =
      board.workspaceId && access.via !== 'public'
        ? await app.db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, board.workspaceId))
        : [null]
    const shown: BoardAccess = {
      ...access,
      visibility: board.visibility,
      publicLink: board.publicLink,
      workspace: workspace ?? null,
      archivedAt: board.archivedAt?.toISOString() ?? null,
    }
    return { data, seq, access: shown, counts, canComment: access.via !== 'public' }
  })

  /**
   * A board's archived cards, as the board keeps them. `task`: that one, with the archived cards above and under it
   * (what the app needs to show or restore it; none when it isn't an archived card: the app asks about any card it
   * doesn't find on the board). Otherwise the ones archived from `from` up to `to` (or, with `when`, done or made
   * then, or any of these), newest first, a page at a time; without a range, all of them.
   */
  app.get('/boards/:id/archived', async (req): Promise<ArchivedPage> => {
    const { id } = parse(Params, req.params)
    const q = parse(ArchivedQuery, req.query)
    await requireAccess(app.db, req.user, id, 'viewer')
    const archived = (await app.engine.snapshot(id)).data.archived ?? {}
    if (q.task) {
      const tasks = archivedFamily(archived, q.task)
      return { tasks, total: tasks.length, nextOffset: null }
    }
    const all = archivedIn(archived, {
      when: q.when,
      from: parseMoment(q.from, 'from', null)?.getTime(),
      to: parseMoment(q.to, 'to', null)?.getTime(),
    })
    const offset = q.offset ?? 0
    const tasks = all.slice(offset, offset + (q.limit ?? 200))
    return { tasks, total: all.length, nextOffset: offset + tasks.length < all.length ? offset + tasks.length : null }
  })

  /** Stars a board as one of your favourites, or unstars it. */
  app.put('/boards/:id/favorite', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { favorite } = parse(z.object({ favorite: z.boolean() }).strict(), req.body)
    const { access } = await requireAccess(app.db, me, id, 'viewer', { archived: true })
    if (access.via === 'public') throw new HttpError(403, 'Only boards you’re on can be favourites.')
    if (favorite) await app.db.insert(boardFavorites).values({ userId: me.id, boardId: id }).onConflictDoNothing()
    else await app.db.delete(boardFavorites).where(and(eq(boardFavorites.userId, me.id), eq(boardFavorites.boardId, id)))
    return { favorite }
  })

  /** Archives a board (owners): off the boards page and read-only, until restored. Or restores it. */
  app.post('/boards/:id/archive', async (req) => {
    const { id } = parse(Params, req.params)
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body)
    const { board } = await requireAccess(app.db, requireUser(req.user), id, 'owner', { archived: true })
    if (!!board.archivedAt !== archived) {
      await app.db
        .update(boards)
        .set({ archivedAt: archived ? new Date() : null })
        .where(eq(boards.id, id))
      // Everyone with it open sees it change (read-only, or back to normal).
      await app.engine.touch(id)
      app.hub.broadcast(id, { type: 'reload' })
    }
    return { ok: true }
  })

  app.delete('/boards/:id', async (req) => {
    const { id } = parse(Params, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'owner', { archived: true })
    await deleteBoardFiles(app.db, id)
    await app.db.delete(boards).where(eq(boards.id, id))
    app.engine.forget(id)
    app.hub.closeBoard(id)
    return { ok: true }
  })

  /** Runs one command. The answer (and every open copy of the board) gets the changes it made. */
  // Undoing a big delete puts back many records at once, so this allows more than the usual 1 MB.
  app.post('/boards/:id/mutations', { bodyLimit: 10 * MB }, async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    const body = parse(Mutation, req.body)
    return app.engine.mutate(id, body.mutationId, body.command, me.id, req.apiToken?.app)
  })

  /**
   * Moves a task, with its subtasks, comments and files, to another board you can edit. Lists and labels are matched by
   * name; people who aren't on that board are unassigned. `list`: a list there for what isn't done yet.
   */
  app.post('/boards/:id/tasks/:taskId/move', async (req) => {
    const { id, taskId } = parse(z.object({ id: z.string().max(100), taskId: z.string().max(100) }), req.params)
    const me = requireUser(req.user)
    const body = parse(
      z.object({ boardId: z.string().max(100), list: z.string().max(100).optional(), parentId: z.string().max(100).nullable().optional() }),
      req.body,
    )
    await requireAccess(app.db, me, id, 'editor')
    await requireAccess(app.db, me, body.boardId, 'editor')
    return app.engine.transfer(id, body.boardId, taskId, { status: body.list, parentId: body.parentId }, me.id, req.apiToken?.app)
  })

  /**
   * What happened on the board in a stretch of time, newest first: its changes (in words) and comments. For its people
   * (not public-link visitors). More: ask again with `until` set to `nextUntil`.
   */
  app.get('/boards/:id/activity', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { access } = await requireAccess(app.db, me, id, 'viewer')
    if (access.via === 'public') throw new HttpError(403, 'Join this board to see its activity.')
    const q = parse(
      z.object({
        since: z.string().max(40).optional(),
        until: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    )
    const from = parseMoment(q.since, 'since', new Date(Date.now() - 86_400_000))!
    const until = parseMoment(q.until, 'until', null)
    const { entries, more } = await readActivity(app.db, { boardIds: [id], from, until, actors: null, limit: q.limit ?? 50 })
    return {
      activity: entries.map((e) => ({
        at: e.at.toISOString(),
        kind: e.kind,
        actor: e.actorId ? { id: e.actorId, name: e.actorName } : null,
        ...(e.kind === 'change'
          ? { command: e.command, via: e.via, items: e.items }
          : { taskId: e.taskId, task: e.task, body: e.body, mentions: e.mentions }),
      })),
      nextUntil: more ? entries[entries.length - 1].at.toISOString() : null,
    }
  })

  /** Live changes for an open board. Anyone who can view it can listen. */
  app.get('/boards/:id/live', { websocket: true }, async (socket, req) => {
    const { id } = parse(Params, req.params)
    const [board] = await app.db.select().from(boards).where(eq(boards.id, id))
    // Someone who must confirm their email first sees boards only as a signed-out visitor would.
    const user = req.user?.mustVerify ? null : req.user
    if (!board || !(await accessOf(app.db, board, user?.id))) {
      socket.close(4403, 'No access')
      return
    }
    const leave = app.hub.join(id, socket, user?.id ?? null, req.sessionToken)
    // Keeps the connection open through proxies that close idle ones.
    const ping = setInterval(() => socket.ping(), 25_000)
    socket.on('close', () => {
      clearInterval(ping)
      leave()
    })
    const [now] = await app.db.select({ seq: boards.seq }).from(boards).where(eq(boards.id, id))
    app.hub.send(socket, { type: 'hello', seq: now?.seq ?? 0 })
  })
}
