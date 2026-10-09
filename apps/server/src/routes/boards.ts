import type { ArchivedPage, BoardAccess, BoardSummary, CardHistory, Role, WhereIs } from '@kanbanto/model/api'
import { tidyPassage } from '@kanbanto/model/passages'
import { MAX_NUMBER, refOf } from '@kanbanto/model/refs'
import { ARCHIVED_DATES, archivedFamily, archivedIn } from '@kanbanto/model/archived'
import { isBackground, type BoardBackground } from '@kanbanto/model/colors'
import { BoardDataSchema, CommandSchema } from '@kanbanto/model/schema'
import { isStarter, STARTERS } from '@kanbanto/model/starters'
import { EXTRAS_MAX, readBoardFile, readExtras, type BoardExtras } from '@kanbanto/model/transfer'
import { fromTrello, isTrelloExport, slimTrello, type TrelloSummary } from '@kanbanto/model/trello'
import { CATEGORIES } from '@kanbanto/model/types'
import { isTimeZone } from '@kanbanto/model/dates'
import { newId } from '@kanbanto/model/ids'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { accessFor, accessOf, mayEdit, requireAccess, type BoardRow } from '../boards/access'
import { parseMoment, readActivity, readTaskActivity } from '../boards/activityLog'
import { notOnInbox } from '../boards/inbox'
import { setBoardCode } from '../boards/numbering'
import { canBeLinked, factOf, linksToResolve, resolveLinks, unlinkBoard } from '../boards/links'
import { createBoard, createStarter, importBoard } from '../boards/service'
import { createFromTemplate } from '../boards/templates'
import { requireWorkspace } from '../boards/workspaces'
import type { Db } from '../db'
import { boardFavorites, boards, comments, timeEntries, users, workspaces, taskMoves } from '../db/schema'
import { addCardSaid, NewCardBody } from '../boards/newCards'
import { importCards, ImportCardsBody } from '../boards/importCards'
import { pictureUrl } from '../pictures'
import { HttpError, parse, siteUrl } from '../http'
import { requireUser } from './auth'
import { commentCounts, lastComments } from './comments'
import { attachmentCounts, deleteBoardFiles } from './files'
import { timeCounts } from './time'

/** What a browser sends over a board's live connection (`DocRequest` in the model's api.ts). */
const docPart = z.string().max(1_400_000)
const docCard = z.string().min(1).max(64)
const DocRequest = z.discriminatedUnion('op', [
  z.object({
    type: z.literal('doc'),
    op: z.literal('join'),
    taskId: docCard,
    session: z.string().max(64).optional(),
    client: z.number().int().nonnegative().optional(),
    seeder: z.boolean().optional(),
    editor: z.number().int().nonnegative().max(1_000_000).optional(),
  }),
  z.object({ type: z.literal('doc'), op: z.literal('update'), taskId: docCard, session: z.string().max(64), data: docPart }),
  z.object({ type: z.literal('doc'), op: z.literal('awareness'), taskId: docCard, data: docPart }),
  z.object({ type: z.literal('doc'), op: z.literal('leave'), taskId: docCard }),
])

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
  /** `sales`, `support`, `store`, `bookings`: a starter board, with its fields and the clients it links to (see createStarter). */
  template: z.enum(['empty', 'example', ...STARTERS]).default('empty'),
  /** Where it goes: a workspace you're in (shared with everyone in it), or your Personal space. */
  workspaceId: z.uuid().nullable().optional(),
  /** A board template to make it from (see boards/templates.ts), in place of `template`: one of yours, or of a workspace you're in. */
  templateId: z.uuid().optional(),
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
    inbox_of: string | null
    code: string | null
    past_codes: string[]
  }>(sql`
      select b.id, b.name, b.description, b.background, b.visibility, b.public_link, b.workspace_id, b.workspace_role, b.inbox_of, m.role,
        b.code, b.past_codes,
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
      inbox: r.inbox_of === userId,
      code: r.code,
      ...(r.past_codes.length && { pastCodes: r.past_codes }),
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
    if (body.templateId) return createFromTemplate(app, user, body.templateId, body)
    if (isStarter(body.template)) return createStarter(app, user, body.template, body)
    return { id: await createBoard(app.db, user.id, { ...body, template: body.template }) }
  })

  /**
   * A board from a file: one of Kanbanto's own exports, or a Trello board ("Export as JSON"; `lists` says what its
   * lists count as, by their Trello ids, where the guess from their names isn't wanted). A Trello board answers with
   * `trello` too: what came over and what stayed behind.
   */
  app.post('/boards/import', { bodyLimit: 20 * MB }, async (req): Promise<{ id: string; lost: string[]; trello?: TrelloSummary }> => {
    const user = requireUser(req.user)
    const { file, lists } = parse(z.object({ file: z.unknown(), lists: z.record(z.string().max(100), z.enum(CATEGORIES)).optional() }), req.body)
    if (isTrelloExport(file)) {
      let made
      try {
        made = fromTrello(slimTrello(file), {
          boardId: newId(),
          now: new Date().toISOString(),
          newId,
          categories: lists,
          zone: isTimeZone(user.timeZone) ? user.timeZone : 'UTC',
        })
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : 'That Trello export couldn’t be read.')
      }
      // (What's stored passes the same checks as any board file: sizes, dates, ids.)
      const checked = BoardDataSchema.safeParse(made.data)
      if (!checked.success) throw new HttpError(400, 'That Trello export couldn’t be read: some of it is in a shape Kanbanto doesn’t know.')
      const done = await importBoard(app, user.id, made.data, { comments: made.comments, fieldText: true })
      return { ...done, trello: made.summary }
    }
    let data
    try {
      data = readBoardFile(file, newId())
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'That file isn’t a board export.')
    }
    // What was said and logged on its cards, when the file has them. Its people aren't accounts here: a comment
    // comes in the importer's name and says who wrote it, as a Trello board's do; logged time is the importer's
    // own where it was theirs (the same account, on the site the file came from) and nobody's otherwise, with who
    // logged it in the note.
    const extras = readExtras(file)
    const name = (by: { name: string } | null) => by?.name.trim().replace(/([\\*_[\]])/g, '\\$1') || ''
    return importBoard(app, user.id, data, {
      comments: extras.comments.map((c) => ({
        taskId: c.taskId,
        at: c.at,
        body: c.by?.id === user.id ? c.body : `${name(c.by) ? `**${name(c.by)}** wrote:` : 'Someone wrote:'}\n\n${c.body}`.slice(0, 10_000),
        ...(c.id && { key: c.id }),
        ...(c.passage && { passage: tidyPassage(c.passage), resolved: !!c.resolved }),
        ...(c.replyTo && { replyTo: c.replyTo }),
      })),
      time: extras.time.map((e) => {
        const mine = e.by?.id === user.id
        return {
          taskId: e.taskId,
          userId: mine ? user.id : null,
          day: e.day,
          minutes: e.minutes,
          at: e.at,
          note: (mine ? e.note : [e.by?.name.trim() || 'Someone', e.note].filter(Boolean).join(': ')).slice(0, 500),
        }
      }),
    })
  })

  /**
   * What was said and logged on a board's cards, archived ones too: its comments and its logged time, for the
   * board's file (see model transfer.ts: the board itself doesn't hold them). For the board's people, viewers too;
   * not for visitors with the public link, who can't see logged time. Each names who it was by. Files posted in
   * comments stay where they are (a comment still names them), and reactions aren't in it.
   */
  app.get('/boards/:id/extras', async (req): Promise<BoardExtras> => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { access } = await requireAccess(app.db, me, id, 'viewer')
    if (access.via === 'public') throw new HttpError(403, 'Join this board to save its comments and logged time.')
    const by = (userId: string | null, name: string | null) => (userId ? { id: userId, name: name ?? 'Someone' } : null)
    const said = await app.db
      .select({ c: comments, name: users.name })
      .from(comments)
      .leftJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.boardId, id))
      .orderBy(comments.createdAt)
      .limit(EXTRAS_MAX.comments)
    const logged = await app.db
      .select({ e: timeEntries, name: users.name })
      .from(timeEntries)
      .leftJoin(users, eq(users.id, timeEntries.userId))
      .where(eq(timeEntries.boardId, id))
      .orderBy(timeEntries.createdAt)
      .limit(EXTRAS_MAX.time)
    return {
      comments: said.map(({ c, name }) => ({
        taskId: c.taskId,
        by: by(c.authorId, name),
        body: c.body,
        at: c.createdAt.toISOString(),
        // (A comment about words of the description, with the answers to it: see the model's passages.ts.)
        ...((c.passage || c.parentId) && { id: c.id }),
        ...(c.passage && { passage: c.passage, ...(c.resolvedAt && { resolved: true }) }),
        ...(c.parentId && { replyTo: c.parentId }),
      })),
      time: logged.map(({ e, name }) => ({
        taskId: e.taskId,
        by: by(e.userId, name),
        day: e.day,
        minutes: e.minutes,
        note: e.note,
        at: e.createdAt.toISOString(),
      })),
    }
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
      inbox: !!board.inboxOf,
    }
    // What the cards' links point at, for this person (a visitor with the public link: cards of this board only).
    const viewer = access.via === 'public' ? undefined : req.user?.id
    const env = { db: app.db, engine: app.engine }
    const refs = linksToResolve(whole)
    const linked = refs.length ? await resolveLinks(env, viewer, board, whole, refs) : undefined
    const linkable = !!viewer && (await canBeLinked(app.db, board))
    return {
      data,
      seq,
      access: shown,
      counts,
      canComment: access.via !== 'public',
      ...(linked && { linked }),
      ...(linkable && { canBeLinked: true }),
    }
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

  /**
   * Where a card is, by its number on this board (`n`) or the id it had here (`task`): still here (on the board,
   * or archived), or on the board it was moved to (see task_moves), when that's one the asker can open. For a name
   * written before the card moved, and for an old link to it.
   */
  app.get('/boards/:id/whereis', async (req): Promise<WhereIs> => {
    const { id } = parse(Params, req.params)
    const q = parse(
      z.object({ n: z.coerce.number().int().positive().max(MAX_NUMBER).optional(), task: z.string().min(1).max(100).optional() }),
      req.query,
    )
    if ((q.n === undefined) === (q.task === undefined)) throw new HttpError(400, 'Say which card: n (its number here) or task (its id here).')
    await requireAccess(app.db, req.user, id, 'viewer', { archived: true })
    const { data } = await app.engine.snapshot(id)
    const all = { ...data.archived, ...data.tasks }
    const here = q.task ? all[q.task] : Object.values(all).find((t) => t.number === q.n)
    if (here) return { boardId: id, taskId: here.id, moved: false, ...(here.archivedAt && { archived: true }) }
    const [went] = await app.db
      .select()
      .from(taskMoves)
      .where(and(eq(taskMoves.fromBoardId, id), q.task ? eq(taskMoves.fromTaskId, q.task) : eq(taskMoves.fromNumber, q.n!)))
      .orderBy(desc(taskMoves.movedAt))
      .limit(1)
    if (!went) throw new HttpError(404, 'There’s no such card on this board.')
    // (A board the asker can't open isn't named, nor whether the card is still there.)
    const dest = await requireAccess(app.db, req.user, went.toBoardId, 'viewer', { archived: true })
      .then(() => app.engine.snapshot(went.toBoardId))
      .catch(() => null)
    if (!dest) throw new HttpError(404, 'That card was moved to a board you can’t open.', 'moved')
    const t = dest.data.tasks[went.toTaskId] ?? dest.data.archived?.[went.toTaskId]
    if (!t) throw new HttpError(404, 'That card was moved to another board, and isn’t there any more.', 'moved')
    const ref = refOf(dest.data.board, t)
    return {
      boardId: went.toBoardId,
      taskId: t.id,
      // (Moved away and back again: it's here, as another card than it was.)
      moved: went.toBoardId !== id,
      board: dest.data.board.name,
      ...(ref && { ref }),
      ...(t.archivedAt && { archived: true }),
    }
  })

  /**
   * Changes a board's letters (owners): what its cards' names start with, WEB in WEB-12. Every card is called by the
   * new ones at once; the old ones are remembered, so a number written with them still finds its card. No two boards
   * in a workspace, or among one person's own, have the same.
   */
  app.put('/boards/:id/code', async (req) => {
    const { id } = parse(Params, req.params)
    const { code } = parse(z.object({ code: z.string().trim().toUpperCase().max(20) }).strict(), req.body)
    const { board } = await requireAccess(app.db, requireUser(req.user), id, 'owner')
    notOnInbox(board, 'letters')
    const set = await app.db.transaction(async (tx) => {
      const out = await setBoardCode(tx, id, code)
      // (No command carries this: the board's change counter moves with it, and every open copy reads it again.)
      await app.engine.bump(tx, [id])
      return out
    })
    app.engine.reloaded([id])
    return set
  })

  /** Archives a board (owners): off the boards page and read-only, until restored. Or restores it. */
  app.post('/boards/:id/archive', async (req) => {
    const { id } = parse(Params, req.params)
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body)
    const { board } = await requireAccess(app.db, requireUser(req.user), id, 'owner', { archived: true })
    if (archived) notOnInbox(board, 'archive')
    if (!!board.archivedAt !== archived) {
      await app.db
        .update(boards)
        .set({ archivedAt: archived ? new Date() : null })
        .where(eq(boards.id, id))
      // Everyone with it open sees it change (read-only, or back to normal).
      await app.engine.touch(id)
      app.hub.broadcast(id, { type: 'reload' })
      // (Nobody goes on writing a description on a board that is put away.)
      if (archived) await app.docs.recheck(id, async () => false)
    }
    return { ok: true }
  })

  app.delete('/boards/:id', async (req) => {
    const { id } = parse(Params, req.params)
    const { board } = await requireAccess(app.db, requireUser(req.user), id, 'owner', { archived: true })
    notOnInbox(board, 'delete')
    // (As it was: other boards' links to its cards are taken out once it's gone.)
    const was = await factOf(app.db, id)
    await deleteBoardFiles(app.db, id)
    await app.db.delete(boards).where(eq(boards.id, id))
    app.engine.forget(id)
    app.hub.closeBoard(id)
    if (was) await unlinkBoard({ db: app.db, engine: app.engine }, was).catch((e) => app.log.error(e))
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
   * Adds a card (and its subtasks) to a board you can edit, in one call, with plain names: its list, labels and
   * assignee by name, the board's own fields by theirs, a due date as a day, a moment or words ("tomorrow 3pm").
   * A wrong name adds nothing, and the answer says what there is.
   */
  app.post('/boards/:id/cards', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    return addCardSaid(app, { me, via: req.apiToken?.app }, id, parse(NewCardBody, req.body), app.mail.siteUrl ?? siteUrl(req))
  })

  /**
   * Adds cards from a spreadsheet to a board you can edit: `text` is what was pasted from Excel or Google Sheets, or
   * a .csv file's text, and `columns` says what each column is (left out, the names in the first row say). With
   * `dryRun` nothing is changed, and the answer is the check: how many cards would be added, which lists and labels
   * would be made, which rows are left out and which cells couldn't be read. Without it the cards are added as one
   * change: one line in the activity, one message to the board's webhooks, and each assignee told once.
   */
  app.post('/boards/:id/tasks/import', { bodyLimit: 6 * MB }, async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { board } = await requireAccess(app.db, me, id, 'editor')
    return importCards(app, { me, via: req.apiToken?.app }, board, parse(ImportCardsBody, req.body))
  })

  /**
   * Moves a task, with its subtasks, comments and files, to another board you can edit. Lists and labels are matched by
   * name; people who aren't on that board are unassigned. `list`: a list there for what isn't done yet. `order`, with
   * `list`: where in that list (its cards as the board shows them, and the place among them); then the task goes in
   * exactly that list.
   */
  app.post('/boards/:id/tasks/:taskId/move', async (req) => {
    const { id, taskId } = parse(z.object({ id: z.string().max(100), taskId: z.string().max(100) }), req.params)
    const me = requireUser(req.user)
    const body = parse(
      z.object({
        boardId: z.string().max(100),
        list: z.string().max(100).optional(),
        parentId: z.string().max(100).nullable().optional(),
        order: z.object({ ids: z.array(z.string().max(100)).max(5000), at: z.number().int().min(0) }).optional(),
      }),
      req.body,
    )
    if (body.order && !body.list) throw new HttpError(400, 'order: say which list (list) it’s the order of.')
    await requireAccess(app.db, me, id, 'editor')
    await requireAccess(app.db, me, body.boardId, 'editor')
    const to = { status: body.list, parentId: body.parentId, order: body.order }
    return app.engine.transfer(id, body.boardId, taskId, to, me.id, req.apiToken?.app)
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

  /**
   * What happened to one card, newest first: its own lines of the board's log, each with who did it, when and through
   * which app (the History beside a card's comments). For the board's people, like the board's log: not public-link
   * visitors. An archived card's history is still read. More: ask again with `until` set to `nextUntil`.
   */
  app.get('/boards/:id/tasks/:taskId/activity', async (req): Promise<CardHistory> => {
    const { id, taskId } = parse(Params.extend({ taskId: z.string().min(1).max(100) }), req.params)
    const me = requireUser(req.user)
    const { access } = await requireAccess(app.db, me, id, 'viewer')
    if (access.via === 'public') throw new HttpError(403, 'Join this board to see its activity.')
    const q = parse(z.object({ until: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query)
    const until = parseMoment(q.until, 'until', null)
    const { entries, more } = await readTaskActivity(app.db, { boardId: id, taskId, until, limit: q.limit ?? 50 })
    return {
      entries: entries.map((e) => ({
        at: e.at.toISOString(),
        actor: e.actorId ? { id: e.actorId, name: e.actorName ?? 'Someone', picture: pictureUrl(e.actorPicture) } : null,
        via: e.via,
        // (A line logged before the card's own wording was kept says the card's name, as the board's log does.)
        lines: e.items.map((i) => (i.own ? { text: i.own, ...(i.date && { date: i.date }) } : { text: i.text })),
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
    // A live connection belongs to a browser session (or a visitor with the public link). An API token asks each
    // time instead: a connection can't be taken back when its token is deleted or runs out.
    const access = board && !req.apiToken ? await accessOf(app.db, board, user?.id) : null
    if (!access) {
      socket.close(4403, 'No access')
      return
    }
    // (It may have closed while that was being looked up: then there's nothing to join.)
    if (socket.readyState !== socket.OPEN) return
    const leave = app.hub.join(id, socket, user?.id ?? null, req.sessionToken, access.via !== 'public')
    // Keeps the connection open through proxies that close idle ones, and closes one whose browser has gone without
    // saying so (a laptop put to sleep): it would go on counting as someone writing a description.
    let alive = true
    socket.on('pong', () => (alive = true))
    const ping = setInterval(() => {
      if (!alive) return socket.terminate()
      alive = false
      socket.ping()
    }, 25_000)
    socket.on('close', () => {
      clearInterval(ping)
      leave()
      app.docs.leaveAll(socket)
    })
    // The one thing a browser says over this connection: about a description it is writing with others (see
    // boards/liveDocs.ts). One message at a time, in the order they came: joining looks things up first, and what
    // follows it (leaving again, say) mustn't overtake it.
    if (user && access.via !== 'public') {
      const who = { userId: user.id, name: user.name }
      let turn = Promise.resolve()
      socket.on('message', (raw) => {
        turn = turn
          .then(async () => {
            const said = DocRequest.safeParse(JSON.parse(String(raw)))
            if (!said.success) return
            const m = said.data
            if (m.op !== 'join') return app.docs.handle(id, socket, { ...who, canWrite: true }, m)
            // Joining is checked each time against the board as it is now: rights change, and cards go.
            const canWrite = await mayEdit(app.db, id, user.id)
            const { data } = await app.engine.snapshot(id)
            if (!data.tasks[m.taskId]) return app.hub.send(socket, { type: 'doc', op: 'ended', taskId: m.taskId })
            if (socket.readyState === socket.OPEN) app.docs.handle(id, socket, { ...who, canWrite }, m)
          })
          .catch(() => {
            // (Not something this connection understands: left unanswered.)
          })
      })
    }
    const [now] = await app.db.select({ seq: boards.seq }).from(boards).where(eq(boards.id, id))
    app.hub.send(socket, { type: 'hello', seq: now?.seq ?? 0 })
    // Who is writing which description at this moment (the board's people see it on the card).
    if (access.via !== 'public') for (const w of app.docs.writing(id)) app.hub.send(socket, { type: 'writing', ...w })
  })
}
