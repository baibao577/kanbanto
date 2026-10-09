import { NOTIFICATIONS_KEPT_MONTHS, type CommentView, type NotificationView } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { PassageSchema, quoteLine, tidyPassage, type Passage } from '@kanbanto/model/passages'
import { isReaction, REACTIONS, type ReactionView } from '@kanbanto/model/reactions'
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { commentMessage } from '../chat/format'
import { tellPerson } from '../tell'
import { openBoards, requireAccess, type BoardRow } from '../boards/access'
import { follow, followersOf, isFollowing, mentionLine, setFollowing } from '../boards/follows'
import { boardPeople } from '../boards/store'
import type { Db, Tx } from '../db'
import { attachments, boardRules, boards, commentReactions, comments, notifications, tasks, users, workspaces } from '../db/schema'
import { HttpError, parse } from '../http'
import { requireUser } from './auth'
import { uncover } from './covers'
import { attachDrafts, trashCommentFiles, views as attachmentViews } from './files'
import { pictureUrl } from '../pictures'

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
/** A new comment may be about some words of the description (`passage`), or answer a comment that is (`parentId`). */
const NewBody = Body.extend({ passage: PassageSchema.optional(), parentId: z.uuid().optional() })

/** The people of a board whose name a text @mentions (for comments written where there's no picker: an assistant, an upload link). */
export const mentionsIn = (members: { id: string; name: string }[], text: string) => {
  const lower = text.toLowerCase()
  return members.filter((m) => lower.includes(`@${m.name.toLowerCase()}`)).map((m) => m.id)
}

/** How much of a comment the bell and the daily email show. */
export const excerpt = (body: string, n = 140) => (body.length > n ? `${body.slice(0, n - 1).trimEnd()}…` : body)

/**
 * The emoji on these comments, by comment: each with the people who added it, in the order they did. The emoji come
 * in the order they're offered (and any from a set of another day after them, in the order they were first used).
 */
export async function reactionsOf(db: Db | Tx, commentIds: string[]): Promise<Map<string, ReactionView[]>> {
  const out = new Map<string, ReactionView[]>()
  if (!commentIds.length) return out
  const rows = await db
    .select({ commentId: commentReactions.commentId, emoji: commentReactions.emoji, id: commentReactions.userId, name: users.name })
    .from(commentReactions)
    .innerJoin(users, eq(users.id, commentReactions.userId))
    .where(inArray(commentReactions.commentId, commentIds))
    .orderBy(commentReactions.createdAt)
  for (const r of rows) {
    const list = out.get(r.commentId) ?? []
    if (!out.has(r.commentId)) out.set(r.commentId, list)
    const one = list.find((x) => x.emoji === r.emoji)
    if (one) one.by.push({ id: r.id, name: r.name })
    else list.push({ emoji: r.emoji, by: [{ id: r.id, name: r.name }] })
  }
  const place = (emoji: string) => {
    const i = (REACTIONS as readonly string[]).indexOf(emoji)
    return i < 0 ? REACTIONS.length : i
  }
  for (const list of out.values()) list.sort((a, b) => place(a.emoji) - place(b.emoji))
  return out
}

const resolvers = alias(users, 'resolvers')

async function commentViews(db: Db | Tx, where: ReturnType<typeof and>): Promise<CommentView[]> {
  const rows = await db
    .select({ c: comments, authorName: users.name, authorPicture: users.picture, resolver: resolvers.name })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorId))
    .leftJoin(resolvers, eq(resolvers.id, comments.resolvedBy))
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
  const reactions = await reactionsOf(
    db,
    rows.map((r) => r.c.id),
  )
  return rows.map(({ c, authorName, authorPicture, resolver }) => ({
    id: c.id,
    taskId: c.taskId,
    author: c.authorId ? { id: c.authorId, name: authorName ?? 'Someone', picture: pictureUrl(authorPicture) } : null,
    body: c.body,
    mentions: c.mentions,
    attachments: files.filter((f) => f.commentId === c.id),
    reactions: reactions.get(c.id) ?? [],
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
    // (Only a comment about a passage, and the answers to one, say more.)
    ...(c.passage && {
      passage: c.passage,
      resolved: c.resolvedAt ? { at: c.resolvedAt.toISOString(), by: c.resolvedBy ? { id: c.resolvedBy, name: resolver ?? 'Someone' } : null } : null,
    }),
    ...(c.parentId && { parentId: c.parentId }),
  }))
}

/**
 * The words a comment is about, for each of these comments: its own passage, or (an answer) the passage of the
 * comment it answers. Comments that aren't about a passage are left out.
 */
export async function passagesOf(db: Db | Tx, rows: { id: string; passage: Passage | null; parentId: string | null }[]) {
  const out = new Map<string, string>()
  const parents = [...new Set(rows.flatMap((r) => (!r.passage && r.parentId ? [r.parentId] : [])))]
  const theirs = parents.length
    ? await db.select({ id: comments.id, passage: comments.passage }).from(comments).where(inArray(comments.id, parents))
    : []
  for (const r of rows) {
    const passage = r.passage ?? theirs.find((p) => p.id === r.parentId)?.passage
    if (passage) out.set(r.id, passage.quote)
  }
  return out
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

/** When each task's latest comment was written, for card age. */
export async function lastComments(db: Db | Tx, boardId: string) {
  const rows = await db
    .select({ taskId: comments.taskId, at: sql<Date>`max(${comments.createdAt})` })
    .from(comments)
    .where(eq(comments.boardId, boardId))
    .groupBy(comments.taskId)
  return Object.fromEntries(rows.map((r) => [r.taskId, new Date(r.at).toISOString()]))
}

/** The same, for several boards at once: per board, per task. */
export async function lastCommentsFor(db: Db | Tx, boardIds: string[]) {
  const out = new Map<string, Record<string, string>>()
  if (!boardIds.length) return out
  const rows = await db
    .select({ boardId: comments.boardId, taskId: comments.taskId, at: sql<Date>`max(${comments.createdAt})` })
    .from(comments)
    .where(inArray(comments.boardId, boardIds))
    .groupBy(comments.boardId, comments.taskId)
  for (const r of rows) {
    if (!out.has(r.boardId)) out.set(r.boardId, {})
    out.get(r.boardId)![r.taskId] = new Date(r.at).toISOString()
  }
  return out
}

/** How many comments a search reads at most (the newest ones). */
const MAX_FOUND = 2000

/** Comments on these boards with any of these words in them, newest first: per board and task, their text. */
export async function commentsWith(db: Db | Tx, boardIds: string[], words: string[]) {
  const out = new Map<string, string[]>()
  if (!boardIds.length || !words.length) return out
  const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = await db
    .select({ boardId: comments.boardId, taskId: comments.taskId, body: comments.body })
    .from(comments)
    .where(and(inArray(comments.boardId, boardIds), or(...words.map((w) => ilike(comments.body, like(w))))))
    .orderBy(desc(comments.createdAt))
    .limit(MAX_FOUND)
  for (const r of rows) {
    const key = `${r.boardId}:${r.taskId}`
    if (!out.has(key)) out.set(key, [])
    out.get(key)!.push(r.body)
  }
  return out
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
 * Adds a comment by `me` (who may comment on the board: check first). Tells the people @mentioned and the card's other
 * followers, shows it to everyone with the board open, and sends it to the board's webhooks. Commenting on a card, or
 * being mentioned on it, is following it from then on.
 */
export async function postComment(
  app: FastifyInstance,
  board: BoardRow,
  me: { id: string; name: string },
  taskId: string,
  /**
   * `notToHook`: a webhook that isn't sent it (a Telegram bot whose own chat the comment came from: it was answered
   * there). `passage`: the words of the description it is about (it starts a thread). `parentId`: the comment about
   * a passage it answers (an answer to an answer joins the same thread); answering a resolved thread opens it again.
   */
  body: { body: string; mentions: string[]; attachments?: string[]; notToHook?: string; passage?: Passage; parentId?: string },
) {
  const id = board.id
  const { data } = await app.engine.snapshot(id)
  if (!data.tasks[taskId]) throw new HttpError(404, 'That task no longer exists.')
  // What it answers: the first comment of the thread, which is about a passage.
  let thread: typeof comments.$inferSelect | undefined
  if (body.parentId) {
    const on = (commentId: string) => and(eq(comments.id, commentId), eq(comments.boardId, id), eq(comments.taskId, taskId))
    const [answered] = await app.db.select().from(comments).where(on(body.parentId))
    thread = answered?.parentId ? (await app.db.select().from(comments).where(on(answered.parentId)))[0] : answered
    if (!thread) throw new HttpError(404, 'The comment this answers no longer exists.')
    if (!thread.passage) throw new HttpError(400, 'Only a comment about words of the description can be answered.')
  }
  const passage = !thread && body.passage ? tidyPassage(body.passage) : null
  const about = (thread?.passage ?? passage)?.quote
  const mentions = await validMentions(app.db, board, body.mentions, me.id)
  const commentId = newId()
  const followers: string[] = []
  await app.db.transaction(async (tx) => {
    await tx
      .insert(comments)
      .values({ id: commentId, boardId: id, taskId, authorId: me.id, body: body.body, mentions, passage, parentId: thread?.id ?? null })
    // (An answer to something that was settled: it isn't settled any more.)
    if (thread?.resolvedAt) {
      await tx.update(comments).set({ resolvedAt: null, resolvedBy: null }).where(eq(comments.id, thread.id))
      await tx.delete(notifications).where(and(eq(notifications.kind, 'resolved'), eq(notifications.commentId, thread.id)))
    }
    await attachDrafts(tx, { boardId: id, taskId, uploaderId: me.id, commentId }, body.attachments ?? [])
    await notify(tx, { boardId: id, taskId, commentId, actorId: me.id }, mentions)
    // The card's other followers, the ones still on the board (someone mentioned has that instead).
    const onBoard = new Set(data.members.map((m) => m.id))
    for (const userId of (await followersOf(tx, id, new Map([[taskId, data.tasks[taskId].assigneeId]]))).get(taskId) ?? [])
      if (userId !== me.id && onBoard.has(userId) && !mentions.includes(userId)) followers.push(userId)
    if (followers.length)
      await tx
        .insert(notifications)
        .values(followers.map((userId) => ({ id: newId(), userId, kind: 'comment' as const, boardId: id, taskId, commentId, actorId: me.id })))
    await follow(
      tx,
      id,
      [me.id, ...mentions].map((userId) => ({ taskId, userId })),
    )
  })
  const [comment] = await commentViews(app.db, and(eq(comments.id, commentId)))
  app.hub.broadcast(id, { type: 'comment', taskId, action: 'added', commentId, comment })
  if (thread?.resolvedAt) {
    const [opened] = await commentViews(app.db, and(eq(comments.id, thread.id)))
    app.hub.broadcast(id, { type: 'comment', taskId, action: 'resolved', commentId: thread.id, comment: opened })
  }
  // (The words it is about go before what it says, wherever it is told in one line.)
  const said = (n: number) => (about ? `On “${quoteLine(about, 50)}”: ${excerpt(body.body, n)}` : excerpt(body.body, n))
  // As it happens, for the people mentioned and the card's followers who want that: on their desktop, and through
  // a Telegram bot of their own. Then the board's webhooks, leaving out the bots that have just told their chat.
  const tell = (userId: string, kind: 'mentions' | 'follows') =>
    tellPerson(
      app,
      userId,
      kind,
      {
        title: kind === 'mentions' ? `${me.name} mentioned you` : `${me.name} commented on “${data.tasks[taskId].title}”`,
        body: kind === 'mentions' ? `“${data.tasks[taskId].title}”: ${said(120)}` : said(120),
        url: `/#/b/${encodeURIComponent(id)}?task=${encodeURIComponent(taskId)}`,
        tag: `mention:${commentId}`,
      },
      24 * 3600,
      { boardId: id },
    ).catch((e) => {
      app.log.error({ err: e instanceof Error ? e.message : e }, 'push')
      return null
    })
  app.webhooks.later(
    Promise.all([...mentions.map((userId) => tell(userId, 'mentions')), ...followers.map((userId) => tell(userId, 'follows'))])
      .then((told) =>
        app.webhooks.emit(
          id,
          'comment.added',
          {
            board: { id, name: board.name },
            actor: { id: me.id, name: me.name },
            task: { id: taskId, title: data.tasks[taskId].title },
            comment: {
              id: commentId,
              body: body.body,
              mentions,
              // (The files posted with it: fetched with a token from /api/attachments/<id>.)
              files: comment.attachments.map((f) => ({ id: f.id, name: f.name, size: f.size })),
              // (About some words of the description, or an answer to a comment that is.)
              ...(about && { about }),
              ...(thread && { replyTo: thread.id }),
            },
          },
          () =>
            commentMessage(
              { actor: me.name, board: board.name, title: data.tasks[taskId].title, body: body.body, about },
              app.webhooks.cardUrl(id, taskId),
            ),
          [body.notToHook, ...told].filter((hook): hook is string => !!hook),
        ),
      )
      .catch((e) => app.log.error({ err: e instanceof Error ? e.message : e }, 'queueing webhooks')),
  )
  return comment
}

/**
 * Notifications that have been read are kept for a few months (NOTIFICATIONS_KEPT_MONTHS), counted from when they
 * came. What is still unread stays, however old: a line someone means to come back to never goes by itself.
 */
export async function pruneNotifications(db: Db) {
  await db
    .delete(notifications)
    .where(and(isNotNull(notifications.readAt), sql`${notifications.createdAt} < now() - make_interval(months => ${NOTIFICATIONS_KEPT_MONTHS})`))
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
    const body = parse(NewBody, req.body)
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
      await follow(
        tx,
        id,
        mentions.map((userId) => ({ taskId: c.taskId, userId })),
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
    // (Someone who is no longer on the board, looking through its public link, changes nothing on it: not even a
    // comment they wrote while they were, which now takes its answers and maybe the card's cover with it.)
    if (access.via === 'public') throw new HttpError(403, 'Join this board to delete comments on it.')
    const [c] = await app.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.boardId, id)))
    if (!c) throw new HttpError(404, 'That comment no longer exists.')
    if (c.authorId !== me.id && access.role !== 'owner') throw new HttpError(403, 'Only its author or a board owner can delete a comment.')
    // (The answers to a comment about a passage go with it, and their files with them.)
    const answers = c.passage
      ? (await app.db.select({ id: comments.id }).from(comments).where(eq(comments.parentId, commentId))).map((r) => r.id)
      : []
    const files = (await Promise.all([commentId, ...answers].map((one) => trashCommentFiles(app.db, one)))).flat()
    await app.db.delete(comments).where(eq(comments.id, commentId))
    // (A picture posted in the comment may have been made the card's cover: it goes with the comment.)
    await uncover(app, id, c.taskId, files, { userId: me.id, via: req.apiToken?.app }).catch(() => false)
    for (const gone of [...answers, commentId]) app.hub.broadcast(id, { type: 'comment', taskId: c.taskId, action: 'deleted', commentId: gone })
    return { ok: true }
  })

  /**
   * Resolves a comment about a passage (the matter is settled: it folds away, and its words are no longer marked in
   * the text), or opens it again. Everyone who can comment can, as with the comment itself. Its author has a line
   * under their bell when someone else resolves it (which goes if it is opened again). Answers with the comment as
   * it is now, which everyone with the card open is sent too.
   */
  app.put('/boards/:id/comments/:commentId/resolved', async (req) => {
    const { id, commentId } = parse(CommentParams, req.params)
    const me = requireUser(req.user)
    const { board, access } = await requireAccess(app.db, me, id, 'viewer', { write: true })
    if (access.via === 'public') throw new HttpError(403, 'Join this board to resolve its comments.')
    const { resolved } = parse(z.object({ resolved: z.boolean() }), req.body)
    const [c] = await app.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.boardId, id)))
    if (!c) throw new HttpError(404, 'That comment no longer exists.')
    if (!c.passage) throw new HttpError(400, 'Only a comment about words of the description can be resolved.')
    if (!!c.resolvedAt !== resolved)
      await app.db.transaction(async (tx) => {
        await tx
          .update(comments)
          .set(resolved ? { resolvedAt: new Date(), resolvedBy: me.id } : { resolvedAt: null, resolvedBy: null })
          .where(eq(comments.id, commentId))
        await tx.delete(notifications).where(and(eq(notifications.kind, 'resolved'), eq(notifications.commentId, commentId)))
        if (!resolved || !c.authorId || c.authorId === me.id) return
        if (!(await boardPeople(tx, board)).some((p) => p.userId === c.authorId)) return
        await tx
          .insert(notifications)
          .values({ id: newId(), userId: c.authorId, kind: 'resolved', boardId: id, taskId: c.taskId, commentId, actorId: me.id })
      })
    const [comment] = await commentViews(app.db, and(eq(comments.id, commentId)))
    app.hub.broadcast(id, { type: 'comment', taskId: c.taskId, action: 'resolved', commentId, comment })
    return { comment }
  })

  /**
   * Answers a comment with an emoji (`on: true`), or takes yours back. Everyone who can comment can: the board's
   * people, viewers too; visitors with the public link can't. One of each emoji to a person on a comment, from the
   * set in model reactions.ts. The comment's author has one line under their bell for it (never for their own, and
   * never an email or a message elsewhere: a reaction is quieter than a comment), which goes again when every
   * reaction is taken back. Answers with the comment as it is now, which everyone with the card
   * open is sent too.
   */
  app.put('/boards/:id/comments/:commentId/reactions', async (req) => {
    const { id, commentId } = parse(CommentParams, req.params)
    const me = requireUser(req.user)
    const { board, access } = await requireAccess(app.db, me, id, 'viewer', { write: true })
    if (access.via === 'public') throw new HttpError(403, 'Join this board to react to its comments.')
    const { emoji, on } = parse(z.object({ emoji: z.string().min(1).max(32), on: z.boolean() }), req.body)
    if (!isReaction(emoji)) throw new HttpError(400, 'That isn’t one of the reactions to choose from.')
    const [c] = await app.db
      .select({ id: comments.id, taskId: comments.taskId, authorId: comments.authorId })
      .from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.boardId, id)))
    if (!c) throw new HttpError(404, 'That comment no longer exists.')
    const others = and(eq(commentReactions.commentId, commentId), c.authorId ? sql`${commentReactions.userId} <> ${c.authorId}` : undefined)
    const lines = and(eq(notifications.kind, 'reaction'), eq(notifications.commentId, commentId))
    await app.db.transaction(async (tx) => {
      if (on) {
        const added = await tx.insert(commentReactions).values({ commentId, userId: me.id, emoji }).onConflictDoNothing().returning()
        // Its author has one line for the comment, however many react and whenever: a later reaction brings that
        // line back to the top, unread (two lines naming the same people would say nothing more).
        if (!added.length || !c.authorId || c.authorId === me.id) return
        if (!(await boardPeople(tx, board)).some((p) => p.userId === c.authorId)) return
        const [open] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(and(lines, eq(notifications.userId, c.authorId)))
          .limit(1)
        if (open)
          await tx
            .update(notifications)
            .set({ actorId: me.id, createdAt: sql`now()`, readAt: null, keptAt: null })
            .where(eq(notifications.id, open.id))
        else
          await tx
            .insert(notifications)
            .values({ id: newId(), userId: c.authorId, kind: 'reaction', boardId: id, taskId: c.taskId, commentId, actorId: me.id })
      } else {
        await tx
          .delete(commentReactions)
          .where(and(eq(commentReactions.commentId, commentId), eq(commentReactions.userId, me.id), eq(commentReactions.emoji, emoji)))
        // Nobody else's reaction is left on it: the lines its author got about them have nothing to say any more.
        const [left] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(commentReactions)
          .where(others)
        if (!left.n) await tx.delete(notifications).where(lines)
      }
    })
    const [comment] = await commentViews(app.db, and(eq(comments.id, commentId)))
    app.hub.broadcast(id, { type: 'comment', taskId: c.taskId, action: 'reacted', commentId, comment })
    return { comment }
  })

  // ── The bell ────────────────────────────────────────────────────────────

  /**
   * Your notifications, newest first: the newest 30 for the bell, or a page of them with `limit`, going further back
   * with `before` (the `next` of the page before). Narrowed with `unread`, `mentions` (only @mentions of you) and
   * `board`. `unread` in the answer is how many are unread in all, whatever is asked for.
   */
  app.get('/notifications', async (req) => {
    const me = requireUser(req.user)
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        before: z
          .string()
          .regex(/^[0-9T:.+ -]{10,40}\|[0-9a-f-]{36}$/)
          .optional(),
        unread: z.enum(['1']).optional(),
        mentions: z.enum(['1']).optional(),
        board: z.string().max(64).optional(),
      }),
      req.query,
    )
    // (Where the page before ended: a moment as the database keeps it, to the microsecond, and that line's id.)
    const [stamp, last] = q.before?.split('|') ?? []
    const found = await app.db
      .select({
        n: notifications,
        stamp: sql<string>`${notifications.createdAt}::text`,
        actor: users.name,
        boardName: boards.name,
        workspaceName: workspaces.name,
        taskTitle: tasks.title,
        description: tasks.description,
        body: comments.body,
        passage: comments.passage,
        parentId: comments.parentId,
        ruleName: sql<string | null>`${boardRules.rule}->>'name'`,
      })
      .from(notifications)
      .leftJoin(boards, eq(boards.id, notifications.boardId))
      .leftJoin(boardRules, eq(boardRules.id, notifications.ruleId))
      .leftJoin(workspaces, eq(workspaces.id, notifications.workspaceId))
      .leftJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(tasks, and(eq(tasks.boardId, notifications.boardId), eq(tasks.id, notifications.taskId)))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(
        and(
          eq(notifications.userId, me.id),
          q.unread ? isNull(notifications.readAt) : undefined,
          q.mentions ? eq(notifications.kind, 'mention') : undefined,
          q.board ? eq(notifications.boardId, q.board) : undefined,
          stamp ? sql`(${notifications.createdAt}, ${notifications.id}) < (${stamp}::timestamptz, ${last}::uuid)` : undefined,
        ),
      )
      // (Lines written in the same moment, as two rules' are for one change, keep the order they were written in.)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(q.limit + 1)
    const rows = found.slice(0, q.limit)
    const next = found.length > q.limit && rows.length ? `${rows.at(-1)!.stamp}|${rows.at(-1)!.n.id}` : null
    const [{ unread }] = await app.db
      .select({ unread: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt)))
    // What a notification shows is read now, not when it was made: only from boards they can still open. One
    // from a board they've left (or a card since moved to one they aren't on) says so, and nothing more.
    const open = new Set((await openBoards(app.db, me.id)).map((b) => b.id))
    const CLOSED = { id: '', name: 'A board you can no longer open' }
    // Who reacted to a comment of theirs is read now, like the rest: the reactions that are on it, less their own.
    const reacted = await reactionsOf(
      app.db,
      rows.flatMap((r) => (r.n.kind === 'reaction' && r.n.commentId ? [r.n.commentId] : [])),
    )
    // The words a comment is about (its own, or those of the comment it answers), by comment.
    const quoted = await passagesOf(
      app.db,
      rows.flatMap((r) => (r.n.commentId ? [{ id: r.n.commentId, passage: r.passage, parentId: r.parentId }] : [])),
    )
    // (And the comment that started its thread: where the full page opens for it.)
    const about = (commentId: string | null, parentId: string | null) => {
      const quote = commentId ? quoted.get(commentId) : undefined
      return quote && commentId ? { about: quoteLine(quote, 70), thread: parentId ?? commentId } : {}
    }
    const lines = rows.map((r): NotificationView | null => {
      const common = {
        id: r.n.id,
        actor: r.actor ?? 'Someone',
        createdAt: r.n.createdAt.toISOString(),
        read: !!r.n.readAt,
        kept: !r.n.readAt && !!r.n.keptAt,
      }
      const can = !!r.n.boardId && open.has(r.n.boardId)
      if (r.n.boardId && r.boardName !== null && !can) {
        if (r.n.kind === 'added') return { ...common, kind: 'added', board: null, workspace: null }
        if (r.n.kind === 'reminder') return { ...common, kind: 'reminder', actor: r.actor, board: CLOSED, task: { id: '', title: 'A task' } }
        if (r.n.kind === 'change') return { ...common, kind: 'change', board: CLOSED, task: { id: '', title: 'A task' }, changes: [] }
        if (r.n.kind === 'comment') return { ...common, kind: 'comment', board: CLOSED, task: { id: '', title: 'A task' }, excerpt: '' }
        if (r.n.kind === 'resolved')
          return { ...common, kind: 'resolved', board: CLOSED, task: { id: '', title: 'A task' }, about: '', thread: '', excerpt: '' }
        if (r.n.kind === 'reaction')
          return { ...common, kind: 'reaction', board: CLOSED, task: { id: '', title: 'A task' }, people: [], emoji: [], excerpt: '' }
        if (r.n.kind === 'rule')
          return {
            ...common,
            kind: 'rule',
            board: CLOSED,
            task: { id: '', title: 'A task' },
            rule: { id: null, name: '' },
            moment: '',
            cards: [],
            more: 0,
          }
        return { ...common, kind: 'mention', where: 'comment', board: CLOSED, task: { id: '', title: 'A task' }, excerpt: '' }
      }
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
      const on = {
        board: board ?? { id: '', name: 'A deleted board' },
        task: { id: r.n.taskId ?? '', title: r.taskTitle ?? 'A deleted task' },
      }
      if (r.n.kind === 'change') return { ...common, kind: 'change', ...on, changes: r.n.changes ?? [] }
      if (r.n.kind === 'comment') return { ...common, kind: 'comment', ...on, excerpt: excerpt(r.body ?? ''), ...about(r.n.commentId, r.parentId) }
      // (The comment is gone since, or opened again: the line has nothing left to say.)
      if (r.n.kind === 'resolved')
        return r.passage && r.n.commentId
          ? { ...common, kind: 'resolved', ...on, about: quoteLine(r.passage.quote, 70), thread: r.n.commentId, excerpt: excerpt(r.body ?? '') }
          : null
      if (r.n.kind === 'reaction') {
        const theirs = (reacted.get(r.n.commentId ?? '') ?? [])
          .map((x) => ({ emoji: x.emoji, by: x.by.filter((p) => p.id !== me.id) }))
          .filter((x) => x.by.length)
        // (Every reaction taken back since they read it: the line has nothing left to say.)
        if (!theirs.length) return null
        // (Whoever reacted last is named first: the line is about them.)
        const names = [...new Set(theirs.flatMap((x) => x.by.map((p) => p.name)))]
        const people = [...names.filter((name) => name === common.actor), ...names.filter((name) => name !== common.actor)]
        return { ...common, kind: 'reaction', ...on, people, emoji: theirs.map((x) => x.emoji), excerpt: excerpt(r.body ?? '') }
      }
      // (What a rule said is kept as it was said: the cards by the titles they had, since one may be gone by now.)
      if (r.n.kind === 'rule') {
        const cards = r.n.said?.cards ?? []
        return {
          ...common,
          kind: 'rule',
          board: on.board,
          task: cards[0] ?? on.task,
          rule: { id: r.n.ruleId, name: r.ruleName ?? '' },
          moment: r.n.said?.moment ?? '',
          cards,
          more: r.n.said?.more ?? 0,
        }
      }
      // (A mention with no comment is in the card's description: the line it's on, as it reads now.)
      return r.n.commentId
        ? { ...common, kind: 'mention', where: 'comment', ...on, excerpt: excerpt(r.body ?? ''), ...about(r.n.commentId, r.parentId) }
        : { ...common, kind: 'mention', where: 'description', ...on, excerpt: excerpt(mentionLine(r.description, me.name)) }
    })
    const items = lines.filter((n): n is NotificationView => !!n)
    return { notifications: items, unread, next }
  })

  // ── Following a card ────────────────────────────────────────────────────

  /** Whether you follow a card (you're told what happens on it). */
  app.get('/boards/:id/tasks/:taskId/follow', async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'viewer')
    const { data } = await app.engine.snapshot(id)
    const task = data.tasks[taskId]
    return { following: !!task && (await isFollowing(app.db, id, task, me.id)) }
  })

  /**
   * Follows a card, or stops. Everyone on the board can (viewers too); visitors with the public link can't. Stopping
   * is remembered: commenting there again doesn't start it again, only being assigned the card does.
   */
  app.put('/boards/:id/tasks/:taskId/follow', async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    const me = requireUser(req.user)
    const { access } = await requireAccess(app.db, me, id, 'viewer', { write: true })
    if (access.via === 'public') throw new HttpError(403, 'Join this board to follow its cards.')
    const { following } = parse(z.object({ following: z.boolean() }), req.body)
    const { data } = await app.engine.snapshot(id)
    if (!data.tasks[taskId]) throw new HttpError(404, 'That task no longer exists.')
    await setFollowing(app.db, id, taskId, me.id, following)
    return { following }
  })

  /**
   * Marks notifications read: the ones named, or, without `ids`, all that are new. "All" leaves the ones they turned
   * back to unread themselves (see below): those are dealt with one by one.
   */
  app.post('/notifications/read', async (req) => {
    const me = requireUser(req.user)
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).max(100).optional() }), req.body ?? {})
    await app.db
      .update(notifications)
      .set({ readAt: new Date(), keptAt: null })
      .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : isNull(notifications.keptAt)))
    return { ok: true }
  })

  /**
   * Turns one notification back to unread (`read: false`), to come back to it, or marks it read. Turned back, it
   * counts under the bell again and is theirs: nothing more is added to it, and the morning summary leaves it out.
   */
  app.put('/notifications/:notificationId/read', async (req) => {
    const me = requireUser(req.user)
    const { notificationId } = parse(z.object({ notificationId: z.uuid() }), req.params)
    const { read } = parse(z.object({ read: z.boolean() }), req.body)
    const changed = await app.db
      .update(notifications)
      .set(read ? { readAt: new Date(), keptAt: null } : { readAt: null, keptAt: new Date() })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, me.id)))
      .returning({ id: notifications.id })
    if (!changed.length) throw new HttpError(404, 'That notification is no longer there.')
    return { ok: true }
  })
}
