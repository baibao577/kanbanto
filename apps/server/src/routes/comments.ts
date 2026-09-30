import type { CommentView, NotificationView } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAccess, type BoardRow } from '../boards/access'
import { boardPeople } from '../boards/store'
import type { Db, Tx } from '../db'
import { attachments, boards, comments, notifications, tasks, users, workspaces } from '../db/schema'
import { HttpError, parse } from '../http'
import { requireUser } from './auth'
import { attachDrafts, trashCommentFiles, views as attachmentViews } from './files'

const Params = z.object({ id: z.string().min(1).max(100) })
const TaskParams = Params.extend({ taskId: z.string().min(1).max(100) })
const CommentParams = Params.extend({ commentId: z.uuid() })
const Body = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write something first.')
    .max(10_000, 'That comment is too long.')
    .refine((b) => !b.includes('\u0000'), 'Comments can’t contain NUL characters.'),
  mentions: z.array(z.uuid()).max(50).default([]),
  /** Files uploaded for this comment (drafts) to attach. */
  attachments: z.array(z.uuid()).max(20).default([]),
})

/** How much of a comment the bell and the daily email show. */
export const excerpt = (body: string, n = 140) => (body.length > n ? `${body.slice(0, n - 1).trimEnd()}…` : body)

async function commentViews(db: Db | Tx, where: ReturnType<typeof and>): Promise<CommentView[]> {
  const rows = await db
    .select({ c: comments, authorName: users.name })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorId))
    .where(where)
    .orderBy(comments.createdAt)
  const files = rows.length
    ? await attachmentViews(
        db,
        and(
          inArray(
            attachments.commentId,
            rows.map((r) => r.c.id),
          ),
          isNull(attachments.deletedAt),
        ),
      )
    : []
  return rows.map(({ c, authorName }) => ({
    id: c.id,
    taskId: c.taskId,
    author: c.authorId ? { id: c.authorId, name: authorName ?? 'Someone' } : null,
    body: c.body,
    mentions: c.mentions,
    attachments: files.filter((f) => f.commentId === c.id),
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
  }))
}

/** Comment counts per task, for the badges on cards. */
export async function commentCounts(db: Db | Tx, boardId: string) {
  const rows = await db
    .select({ taskId: comments.taskId, n: sql<number>`count(*)::int` })
    .from(comments)
    .where(eq(comments.boardId, boardId))
    .groupBy(comments.taskId)
  return Object.fromEntries(rows.map((r) => [r.taskId, r.n]))
}

/** Only people on the board can be @mentioned (and not yourself). */
async function validMentions(db: Db | Tx, board: BoardRow, ids: string[], authorId: string) {
  const wanted = new Set(ids)
  wanted.delete(authorId)
  if (!wanted.size) return []
  return (await boardPeople(db, board)).filter((p) => wanted.has(p.userId)).map((p) => p.userId)
}

async function notify(db: Db | Tx, c: { boardId: string; taskId: string; commentId: string; actorId: string }, who: string[]) {
  if (!who.length) return
  await db.insert(notifications).values(who.map((userId) => ({ id: newId(), userId, kind: 'mention' as const, ...c })))
}

/** Tells someone under the bell that `actorId` added them to a board or a workspace. */
export async function notifyAdded(db: Db | Tx, userId: string, actorId: string, to: { boardId: string } | { workspaceId: string }) {
  await db.insert(notifications).values({ id: newId(), userId, kind: 'added', actorId, ...to })
}

/**
 * Adds a comment by `me` (who may comment on the board: check first). Tells the people @mentioned, shows it to everyone
 * with the board open, and sends it to the board's webhooks.
 */
export async function postComment(
  app: FastifyInstance,
  board: BoardRow,
  me: { id: string; name: string },
  taskId: string,
  body: { body: string; mentions: string[]; attachments?: string[] },
) {
  const id = board.id
  const { data } = await app.engine.snapshot(id)
  if (!data.tasks[taskId]) throw new HttpError(404, 'That task no longer exists.')
  const mentions = await validMentions(app.db, board, body.mentions, me.id)
  const commentId = newId()
  await app.db.transaction(async (tx) => {
    await tx.insert(comments).values({ id: commentId, boardId: id, taskId, authorId: me.id, body: body.body, mentions })
    await attachDrafts(tx, { boardId: id, taskId, uploaderId: me.id, commentId }, body.attachments ?? [])
    await notify(tx, { boardId: id, taskId, commentId, actorId: me.id }, mentions)
  })
  const [comment] = await commentViews(app.db, and(eq(comments.id, commentId)))
  app.hub.broadcast(id, { type: 'comment', taskId, action: 'added', commentId, comment })
  void app.webhooks
    .emit(id, 'comment.added', {
      board: { id, name: board.name },
      actor: { id: me.id, name: me.name },
      task: { id: taskId, title: data.tasks[taskId].title },
      comment: { id: commentId, body: body.body, mentions },
    })
    .catch((e) => app.log.error({ err: e instanceof Error ? e.message : e }, 'queueing webhooks'))
  return comment
}

export const commentRoutes: FastifyPluginAsync = async (app) => {
  /** A card's comments (anyone who can view the board can read them). */
  app.get('/boards/:id/tasks/:taskId/comments', async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    await requireAccess(app.db, req.user, id, 'viewer')
    return { comments: await commentViews(app.db, and(eq(comments.boardId, id), eq(comments.taskId, taskId))) }
  })

  /**
   * Adds a comment. Everyone on the board can comment (added to it or through its workspace), viewers included;
   * visitors with the public link can't.
   */
  app.post('/boards/:id/tasks/:taskId/comments', async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    const me = requireUser(req.user)
    const { board, access } = await requireAccess(app.db, me, id, 'viewer', { write: true })
    if (access.via === 'public') throw new HttpError(403, 'Join this board to comment on it.')
    const body = parse(Body, req.body)
    return { comment: await postComment(app, board, me, taskId, body) }
  })

  /** Edits your own comment. People newly @mentioned are told. */
  app.patch('/boards/:id/comments/:commentId', async (req) => {
    const { id, commentId } = parse(CommentParams, req.params)
    const me = requireUser(req.user)
    const { board, access } = await requireAccess(app.db, me, id, 'viewer', { write: true })
    if (access.via === 'public') throw new HttpError(403, 'Join this board to comment on it.')
    const body = parse(Body, req.body)
    const [c] = await app.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.boardId, id)))
    if (!c) throw new HttpError(404, 'That comment no longer exists.')
    if (c.authorId !== me.id) throw new HttpError(403, 'You can only edit your own comments.')
    const mentions = await validMentions(app.db, board, body.mentions, me.id)
    await app.db.transaction(async (tx) => {
      await tx.update(comments).set({ body: body.body, mentions, editedAt: new Date() }).where(eq(comments.id, commentId))
      await attachDrafts(tx, { boardId: id, taskId: c.taskId, uploaderId: me.id, commentId }, body.attachments)
      await notify(
        tx,
        { boardId: id, taskId: c.taskId, commentId, actorId: me.id },
        mentions.filter((m) => !c.mentions.includes(m)),
      )
    })
    const [comment] = await commentViews(app.db, and(eq(comments.id, commentId)))
    app.hub.broadcast(id, { type: 'comment', taskId: c.taskId, action: 'edited', commentId, comment })
    return { comment }
  })

  /** Deletes a comment: its author, or a board owner. */
  app.delete('/boards/:id/comments/:commentId', async (req) => {
    const { id, commentId } = parse(CommentParams, req.params)
    const me = requireUser(req.user)
    const { access } = await requireAccess(app.db, me, id, 'viewer', { write: true })
    const [c] = await app.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.boardId, id)))
    if (!c) throw new HttpError(404, 'That comment no longer exists.')
    if (c.authorId !== me.id && access.role !== 'owner') throw new HttpError(403, 'Only its author or a board owner can delete a comment.')
    await trashCommentFiles(app.db, commentId)
    await app.db.delete(comments).where(eq(comments.id, commentId))
    app.hub.broadcast(id, { type: 'comment', taskId: c.taskId, action: 'deleted', commentId })
    return { ok: true }
  })

  // ── The bell ────────────────────────────────────────────────────────────

  app.get('/notifications', async (req) => {
    const me = requireUser(req.user)
    const rows = await app.db
      .select({
        n: notifications,
        actor: users.name,
        boardName: boards.name,
        workspaceName: workspaces.name,
        taskTitle: tasks.title,
        body: comments.body,
      })
      .from(notifications)
      .leftJoin(boards, eq(boards.id, notifications.boardId))
      .leftJoin(workspaces, eq(workspaces.id, notifications.workspaceId))
      .leftJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(tasks, and(eq(tasks.boardId, notifications.boardId), eq(tasks.id, notifications.taskId)))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(eq(notifications.userId, me.id))
      .orderBy(desc(notifications.createdAt))
      .limit(30)
    const [{ unread }] = await app.db
      .select({ unread: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt)))
    const items: NotificationView[] = rows.map((r) => {
      const common = { id: r.n.id, actor: r.actor ?? 'Someone', createdAt: r.n.createdAt.toISOString(), read: !!r.n.readAt }
      const board = r.n.boardId && r.boardName !== null ? { id: r.n.boardId, name: r.boardName } : null
      if (r.n.kind === 'added') {
        const workspace = r.n.workspaceId && r.workspaceName !== null ? { id: r.n.workspaceId, name: r.workspaceName } : null
        return { ...common, kind: 'added', board, workspace }
      }
      if (r.n.kind === 'reminder')
        return {
          ...common,
          kind: 'reminder',
          actor: r.actor,
          board: board ?? { id: '', name: 'A deleted board' },
          task: { id: r.n.taskId ?? '', title: r.taskTitle ?? 'A deleted task' },
        }
      return {
        ...common,
        kind: 'mention',
        board: board ?? { id: '', name: 'A deleted board' },
        task: { id: r.n.taskId ?? '', title: r.taskTitle ?? 'A deleted task' },
        excerpt: excerpt(r.body ?? ''),
      }
    })
    return { notifications: items, unread }
  })

  /** Marks notifications read (all of them without `ids`). */
  app.post('/notifications/read', async (req) => {
    const me = requireUser(req.user)
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).max(100).optional() }), req.body ?? {})
    await app.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined))
    return { ok: true }
  })
}
