import type { BoardSummary, Role, Visibility } from '@kanbanto/model/api'
import { BOARD_BACKGROUNDS, type ColorName } from '@kanbanto/model/colors'
import { CommandSchema } from '@kanbanto/model/schema'
import { readBoardFile } from '@kanbanto/model/transfer'
import { newId } from '@kanbanto/model/ids'
import { eq, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { accessFor, memberRole, requireAccess } from '../boards/access'
import { createBoard, importBoard } from '../boards/service'
import { boards } from '../db/schema'
import { HttpError, parse } from '../http'
import { requireUser } from './auth'
import { commentCounts } from './comments'
import { attachmentCounts, deleteBoardFiles } from './files'

const background = z.enum(Object.keys(BOARD_BACKGROUNDS) as [ColorName, ...ColorName[]])
const CreateBoard = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the board a name.')
    .max(200)
    .refine((n) => !n.includes('\u0000'), 'Board names can’t contain NUL characters.'),
  background: background.optional(),
  template: z.enum(['empty', 'example']).default('empty'),
})
const Params = z.object({ id: z.string().min(1).max(100) })
const Mutation = z.object({ mutationId: z.string().min(1).max(100), command: CommandSchema })
const MB = 1024 * 1024

export const boardRoutes: FastifyPluginAsync = async (app) => {
  /** Boards you can open: yours and ones you've joined. */
  app.get('/boards', async (req) => {
    const user = requireUser(req.user)
    const rows = await app.db.execute<{
      id: string
      name: string
      background: string | null
      visibility: string
      role: string | null
      task_count: number
      done_count: number
      created_at: Date
      activity_at: Date
    }>(sql`
      select b.id, b.name, b.background, b.visibility, m.role, b.created_at, b.activity_at,
        (select count(*)::int from tasks t where t.board_id = b.id) as task_count,
        (select count(*)::int from tasks t join lists l on l.board_id = t.board_id and l.id = t.status
          where t.board_id = b.id and l.category = 'done') as done_count
      from boards b
      join board_members m on m.board_id = b.id and m.user_id = ${user.id}
      where m.role = 'owner' or (m.role is not null and b.visibility <> 'private')
      order by b.activity_at desc`)
    const summaries: BoardSummary[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      background: r.background,
      visibility: r.visibility as Visibility,
      role: r.role as Role,
      taskCount: r.task_count,
      doneCount: r.done_count,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.activity_at).toISOString(),
    }))
    return { boards: summaries }
  })

  app.post('/boards', async (req) => {
    const user = requireUser(req.user)
    const body = parse(CreateBoard, req.body)
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

  app.get('/boards/:id', async (req) => {
    const { id } = parse(Params, req.params)
    const { board, access } = await requireAccess(app.db, req.user, id, 'viewer')
    const { data, seq } = await app.engine.snapshot(id)
    const counts = { comments: await commentCounts(app.db, id), attachments: await attachmentCounts(app.db, id) }
    return { data, seq, access: { ...access, visibility: board.visibility }, counts, canComment: access.via === 'member' }
  })

  app.delete('/boards/:id', async (req) => {
    const { id } = parse(Params, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'owner')
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
    return app.engine.mutate(id, body.mutationId, body.command, me.id)
  })

  /** Live changes for an open board. Anyone who can view it can listen. */
  app.get('/boards/:id/live', { websocket: true }, async (socket, req) => {
    const { id } = parse(Params, req.params)
    const [board] = await app.db.select().from(boards).where(eq(boards.id, id))
    // Someone who must confirm their email first sees boards only as a signed-out visitor would.
    const user = req.user?.mustVerify ? null : req.user
    if (!board || !accessFor(user, board, await memberRole(app.db, id, user?.id))) {
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
