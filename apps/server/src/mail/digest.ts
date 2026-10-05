import { fireTime } from '@kanbanto/model/reminders'
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { boards, comments, lists, notifications, tasks, users } from '../db/schema'
import { mentionLine } from '../boards/follows'
import { excerpt } from '../routes/comments'
import { boardsFor } from '../routes/boards'
import { emails, type DigestItem } from './templates'

/** Morning, in someone's own time zone: the summary goes out the first time we look between these hours. */
const FROM_HOUR = 8
const UNTIL_HOUR = 12
const MAX_ITEMS = 10

/** "2026-10-01" in a time zone. */
export const dayIn = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const hourIn = (d: Date, tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d))
const timeIn = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
const dayWords = (day: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${day}T00:00:00Z`))
    .replace(',', '')

/**
 * The morning summary email, around 8:00 in each person's time zone (checked every 10 minutes): cards assigned to them
 * due today and overdue, reminders due later today, and mentions and news from the cards they follow that they haven't
 * seen. At most one a day, only when
 * there's something in it, and only for people who want it (Account → Notifications). If email isn't set up, or the
 * budget is used up, it tries again at the next check.
 */
export async function sendDigests(app: FastifyInstance, now = new Date()) {
  const site = app.mail.siteUrl
  if (!app.mail.platformReady || !site) return 0
  const people = await app.db
    .select()
    .from(users)
    .where(and(eq(users.mentionEmails, true), isNull(users.disabledAt)))
  let sent = 0
  for (const u of people) {
    // (One person's summary going wrong never stops the others'.)
    try {
      const tz = u.timeZone || 'UTC'
      const today = dayIn(now, tz)
      const hour = hourIn(now, tz)
      if (hour < FROM_HOUR || hour >= UNTIL_HOUR) continue
      if (u.lastDigestAt && dayIn(u.lastDigestAt, tz) === today) continue

      const boardIds = (await boardsFor(app.db, u.id)).filter((b) => !b.archivedAt).map((b) => b.id)
      const due: DigestItem[] = []
      const overdue: DigestItem[] = []
      const later: DigestItem[] = []
      if (boardIds.length) {
        // Open cards assigned to them, with a due date.
        const mine = await app.db
          .select({ title: tasks.title, due: tasks.due, board: boards.name })
          .from(tasks)
          .innerJoin(boards, eq(boards.id, tasks.boardId))
          .innerJoin(lists, and(eq(lists.boardId, tasks.boardId), eq(lists.id, tasks.status)))
          .where(
            and(
              inArray(tasks.boardId, boardIds),
              eq(tasks.assigneeId, u.id),
              isNull(tasks.archivedAt),
              isNotNull(tasks.due),
              ne(lists.category, 'done'),
            ),
          )
        for (const t of mine) {
          const timed = t.due!.length > 10
          const day = timed ? dayIn(new Date(t.due!), tz) : t.due!
          if (day === today) due.push({ task: t.title, board: t.board, note: timed ? timeIn(new Date(t.due!), tz) : undefined })
          else if (day < today) overdue.push({ task: t.title, board: t.board, note: `was due ${dayWords(day)}` })
        }
        // Reminders going off later today, for them.
        const withReminders = await app.db
          .select({ title: tasks.title, due: tasks.due, assigneeId: tasks.assigneeId, reminders: tasks.reminders, board: boards.name })
          .from(tasks)
          .innerJoin(boards, eq(boards.id, tasks.boardId))
          .where(
            and(
              inArray(tasks.boardId, boardIds),
              isNotNull(tasks.reminders),
              isNull(tasks.archivedAt),
              or(eq(tasks.assigneeId, u.id), isNull(tasks.assigneeId)),
            ),
          )
        for (const t of withReminders)
          for (const r of t.reminders ?? []) {
            if ((t.assigneeId ?? r.by) !== u.id) continue
            const at = fireTime(r, { due: t.due ?? undefined })
            if (at && at > now && dayIn(at, tz) === today) later.push({ task: t.title, board: t.board, note: timeIn(at, tz) })
          }
      }
      const news = await app.db
        .select({
          id: notifications.id,
          kind: notifications.kind,
          commentId: notifications.commentId,
          changes: notifications.changes,
          actor: users.name,
          board: boards.name,
          task: tasks.title,
          description: tasks.description,
          body: comments.body,
        })
        .from(notifications)
        .innerJoin(boards, eq(boards.id, notifications.boardId))
        .leftJoin(users, eq(users.id, notifications.actorId))
        .leftJoin(tasks, and(eq(tasks.boardId, notifications.boardId), eq(tasks.id, notifications.taskId)))
        .leftJoin(comments, eq(comments.id, notifications.commentId))
        .where(
          and(
            eq(notifications.userId, u.id),
            inArray(notifications.kind, ['mention', 'comment', 'change']),
            isNull(notifications.readAt),
            isNull(notifications.emailedAt),
            // (Only from boards they can still open: what's quoted is read now, not when they were mentioned.)
            boardIds.length ? inArray(notifications.boardId, boardIds) : sql`false`,
          ),
        )
        .orderBy(desc(notifications.createdAt))
        // (The email shows a few and counts the rest: there's no need to read every one.)
        .limit(500)
      if (!due.length && !overdue.length && !later.length && !news.length) continue
      const mentions = news.filter((m) => m.kind === 'mention')
      const followed = news.filter((m) => m.kind !== 'mention')

      later.sort((a, b) => (a.note ?? '').localeCompare(b.note ?? ''))
      const cut = <T>(xs: T[]) => ({ items: xs.slice(0, MAX_ITEMS), more: Math.max(0, xs.length - MAX_ITEMS) })
      const result = await app.mail.queue({
        kind: 'digest',
        to: u.email,
        requestedBy: null,
        content: (brand) =>
          emails.digest(brand, {
            name: u.name,
            site: `${site}/`,
            day: dayWords(today),
            due: cut(due),
            overdue: cut(overdue),
            reminders: cut(later),
            mentions: cut(
              mentions.map((m) => ({
                task: m.task ?? 'a deleted task',
                board: m.board,
                note: `${m.actor ?? 'Someone'}: “${excerpt(m.commentId ? (m.body ?? '') : mentionLine(m.description, u.name), 120)}”`,
              })),
            ),
            followed: cut(
              followed.map((m) => ({
                task: m.task ?? 'a deleted task',
                board: m.board,
                note:
                  m.kind === 'comment'
                    ? `${m.actor ?? 'Someone'}: “${excerpt(m.body ?? '', 120)}”`
                    : excerpt(`${m.actor ?? 'Someone'} ${(m.changes ?? []).join(', ')}`, 160),
              })),
            ),
          }),
      })
      if (!result.queued) continue
      if (news.length)
        await app.db
          .update(notifications)
          .set({ emailedAt: now })
          .where(
            inArray(
              notifications.id,
              news.map((m) => m.id),
            ),
          )
      await app.db.update(users).set({ lastDigestAt: now }).where(eq(users.id, u.id))
      sent++
    } catch (e) {
      app.log.error({ err: e instanceof Error ? e.message : e }, 'sending a morning summary')
    }
  }
  return sent
}
