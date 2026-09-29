import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { boards, comments, notifications, tasks, users } from '../db/schema'
import { excerpt } from '../routes/comments'
import { emails } from './templates'

/** Mentions wait this long before going into an email (time to see them in the app first). */
const GRACE = sql`interval '1 hour'`
/** At most one summary per person per day. */
const EVERY = sql`interval '24 hours'`
const MAX_ITEMS = 10

/**
 * The daily email summary of @mentions: for everyone who wants it, has unread mentions they haven't been emailed
 * about (older than an hour), and hasn't had a summary in the last 24 hours. Runs every hour. If email isn't set
 * up or the budget is used up, it simply tries again next time.
 */
export async function sendDigests(app: FastifyInstance) {
  const site = app.mail.siteUrl
  if (!app.mail.platformReady || !site) return 0
  const due = await app.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.mentionEmails, true),
        isNull(users.disabledAt),
        sql`(${users.lastDigestAt} is null or ${users.lastDigestAt} < now() - ${EVERY})`,
        sql`exists (select 1 from ${notifications} n where n.user_id = ${users.id} and n.read_at is null and n.emailed_at is null and n.created_at < now() - ${GRACE})`,
      ),
    )
  let sent = 0
  for (const u of due) {
    const pending = await app.db
      .select({ id: notifications.id, actor: users.name, board: boards.name, task: tasks.title, body: comments.body })
      .from(notifications)
      .innerJoin(boards, eq(boards.id, notifications.boardId))
      .leftJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(tasks, and(eq(tasks.boardId, notifications.boardId), eq(tasks.id, notifications.taskId)))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(
        and(
          eq(notifications.userId, u.id),
          isNull(notifications.readAt),
          isNull(notifications.emailedAt),
          lt(notifications.createdAt, sql`now() - ${GRACE}`),
        ),
      )
      .orderBy(desc(notifications.createdAt))
    if (!pending.length) continue
    const shown = pending.slice(0, MAX_ITEMS)
    const result = await app.mail.queue({
      kind: 'digest',
      to: u.email,
      requestedBy: null,
      content: (brand) =>
        emails.digest(brand, {
          name: u.name,
          site: `${site}/`,
          items: shown.map((p) => ({
            actor: p.actor ?? 'Someone',
            task: p.task ?? 'a deleted task',
            board: p.board,
            excerpt: excerpt(p.body ?? '', 120),
          })),
          more: pending.length - shown.length,
        }),
    })
    if (!result.queued) continue
    const now = new Date()
    await app.db
      .update(notifications)
      .set({ emailedAt: now })
      .where(
        inArray(
          notifications.id,
          pending.map((p) => p.id),
        ),
      )
    await app.db.update(users).set({ lastDigestAt: now }).where(eq(users.id, u.id))
    sent++
  }
  return sent
}
