import { newId } from '@kanbanto/model/ids'
import { fireTime } from '@kanbanto/model/reminders'
import type { Reminder } from '@kanbanto/model/types'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { accessOf } from './boards/access'
import { boards, lists, notifications, reminderSends, tasks, users } from './db/schema'
import { reminderMessage } from './chat/format'
import { emails } from './mail/templates'

/** A reminder whose moment passed while the server was down still goes out, up to this late. */
const LATE_MS = 24 * 60 * 60 * 1000

/**
 * Sends the reminders whose moment has come (every minute): to the card's assignee, or whoever set the reminder when
 * nobody is assigned. Each reminder goes out once per moment (reminder_sends), under the bell, by email (unless
 * they've turned that off), and to the board's webhooks as `reminder.due`. Archived cards and boards wait.
 */
export async function sendReminders(app: FastifyInstance, now = new Date()): Promise<number> {
  const rows = await app.db
    .select({
      boardId: tasks.boardId,
      id: tasks.id,
      title: tasks.title,
      due: tasks.due,
      status: tasks.status,
      assigneeId: tasks.assigneeId,
      reminders: tasks.reminders,
    })
    .from(tasks)
    .innerJoin(boards, eq(boards.id, tasks.boardId))
    .where(and(isNotNull(tasks.reminders), isNull(tasks.archivedAt), isNull(boards.archivedAt)))
  let sent = 0
  for (const t of rows) {
    for (const r of t.reminders ?? []) {
      const at = fireTime(r, { due: t.due ?? undefined })
      if (!at || at > now || now.getTime() - at.getTime() > LATE_MS) continue
      const to = t.assigneeId ?? r.by ?? null
      // (One card's reminder going wrong never stops the others: this run is for every board.)
      try {
        // Claim it first, so two servers (or a slow run) never send it twice.
        const [claimed] = await app.db
          .insert(reminderSends)
          .values({ boardId: t.boardId, taskId: t.id, reminderId: r.id, fireAt: at, userId: to })
          .onConflictDoNothing()
          .returning()
        if (!claimed) continue
        if (to && (await deliver(app, t, r, to))) sent++
      } catch (e) {
        app.log.error({ err: e instanceof Error ? e.message : e }, 'sending a reminder')
      }
    }
  }
  return sent
}

async function deliver(
  app: FastifyInstance,
  t: { boardId: string; id: string; title: string; due: string | null; status: string },
  r: Reminder,
  userId: string,
): Promise<boolean> {
  const [board] = await app.db.select().from(boards).where(eq(boards.id, t.boardId))
  const [u] = await app.db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
  // Only for someone who can still open the board.
  if (!board || !u || !(await accessOf(app.db, board, u.id))) return false
  const by = r.by && r.by !== u.id ? (await app.db.select({ name: users.name }).from(users).where(eq(users.id, r.by)))[0]?.name : undefined

  await app.db
    .insert(notifications)
    .values({ id: newId(), userId: u.id, kind: 'reminder', boardId: t.boardId, taskId: t.id, actorId: r.by && r.by !== u.id ? r.by : null })

  const site = app.mail.siteUrl
  if (u.reminderEmails && app.mail.platformReady && site)
    await app.mail.queue({
      kind: 'reminder',
      to: u.email,
      // A reminder for someone else counts against whoever set it, like the other emails one person causes
      // another to get; your own reminders to yourself don't.
      requestedBy: r.by && r.by !== u.id ? r.by : null,
      content: (brand) =>
        emails.reminder(brand, {
          name: u.name,
          task: t.title,
          board: board.name,
          due: t.due ? dueInWords(t.due, r.tz) : null,
          by: by ?? null,
          url: `${site}/#/b/${encodeURIComponent(t.boardId)}?task=${encodeURIComponent(t.id)}`,
        }),
    })

  if (u.pushReminders)
    await app.push.toUser(
      u.id,
      {
        title: `⏰ ${t.title}`,
        body: `${board.name}${t.due ? ` · due ${dueInWords(t.due, r.tz)}` : ''}${by ? ` · set by ${by}` : ''}`,
        url: `/#/b/${encodeURIComponent(t.boardId)}?task=${encodeURIComponent(t.id)}`,
        tag: `reminder:${t.boardId}:${t.id}`,
      },
      3600,
    )

  const [list] = await app.db
    .select({ name: lists.name })
    .from(lists)
    .where(and(eq(lists.boardId, t.boardId), eq(lists.id, t.status)))
  await app.webhooks.emit(
    t.boardId,
    'reminder.due',
    {
      board: { id: board.id, name: board.name },
      task: { id: t.id, title: t.title, due: t.due, list: list?.name ?? null },
      reminder: { id: r.id, at: fireTime(r, { due: t.due ?? undefined })?.toISOString() ?? null },
      for: { id: u.id, name: u.name },
    },
    () =>
      reminderMessage(
        { for: u.name, board: board.name, title: t.title, due: t.due ? dueInWords(t.due, r.tz) : null },
        app.webhooks.cardUrl(t.boardId, t.id),
      ),
  )
  return true
}

/** "Fri 3 Oct" (a whole day), or "Fri 3 Oct, 14:30" in the setter's time zone (UTC when unknown). */
function dueInWords(due: string, tz?: string): string {
  const whole = due.length <= 10
  const d = new Date(whole ? `${due}T00:00:00Z` : due)
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', timeZone: whole ? 'UTC' : tz || 'UTC' }
  try {
    const day = new Intl.DateTimeFormat('en-GB', opts).format(d).replace(',', '')
    if (whole) return day
    const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz || 'UTC' }).format(d)
    return `${day}, ${time}${tz ? '' : ' UTC'}`
  } catch {
    return due.slice(0, 10)
  }
}
