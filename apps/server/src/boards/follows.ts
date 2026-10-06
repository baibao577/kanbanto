import { newId } from '@kanbanto/model/ids'
import type { Change } from '@kanbanto/model/records'
import type { BoardData, Task } from '@kanbanto/model/types'
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db, Tx } from '../db'
import { notifications, taskFollowers } from '../db/schema'
import { tellPerson } from '../tell'

/** Changes to a card by the same person within this long are one line under the bell, not one each. */
const TOGETHER_MS = 10 * 60_000
/** Lines kept in one notification. */
const MAX_LINES = 20

type Named = { id: string; name: string }

/**
 * The people whose "@Name" is in a text (any case). Longer names are looked for first, so "@Ann Lee" isn't also "@Ann",
 * and a name only counts when it ends there ("@Anna" isn't "@Ann").
 */
export function mentionedIn(text: string | undefined, people: Named[]): string[] {
  if (!text || !text.includes('@')) return []
  let rest = text.toLowerCase()
  // (Two people with the same name are both mentioned.)
  const byName = new Map<string, string[]>()
  for (const p of people) {
    const name = p.name.trim().toLowerCase()
    if (name) byName.set(name, [...(byName.get(name) ?? []), p.id])
  }
  const found: string[] = []
  for (const [name, ids] of [...byName].sort((a, b) => b[0].length - a[0].length)) {
    const needle = `@${name}`
    let hit = false
    for (let i = rest.indexOf(needle); i !== -1 && !hit; i = rest.indexOf(needle, i + needle.length)) {
      const next = rest[i + needle.length]
      hit = !next || !/[\p{L}\p{N}_]/u.test(next)
    }
    if (!hit) continue
    found.push(...ids)
    rest = rest.split(needle).join(' '.repeat(needle.length))
  }
  return found
}

/** The line of a text where someone is mentioned, for the bell ('' when they no longer are). */
export function mentionLine(text: string | null | undefined, name: string): string {
  const needle = `@${name.trim().toLowerCase()}`
  return (
    (text ?? '')
      .split('\n')
      .find((l) => l.toLowerCase().includes(needle))
      ?.trim() ?? ''
  )
}

/** Starts following cards, for people who haven't chosen to stop (`again`: even if they have, e.g. newly assigned). */
export async function follow(db: Db | Tx, boardId: string, pairs: { taskId: string; userId: string }[], again = false) {
  if (!pairs.length) return
  const q = db.insert(taskFollowers).values(pairs.map((p) => ({ boardId, ...p })))
  if (again) await q.onConflictDoUpdate({ target: [taskFollowers.boardId, taskFollowers.taskId, taskFollowers.userId], set: { following: true } })
  else await q.onConflictDoNothing()
}

/**
 * Who follows each of these cards, by card. `assignees`: who each is assigned to: they follow it unless they chose to
 * stop, whether or not that was ever written down (cards that came with a new board, or from before following).
 */
export async function followersOf(db: Db | Tx, boardId: string, assignees: Map<string, string | undefined>) {
  const out = new Map<string, string[]>()
  if (!assignees.size) return out
  const rows = await db
    .select({ taskId: taskFollowers.taskId, userId: taskFollowers.userId, following: taskFollowers.following })
    .from(taskFollowers)
    .where(and(eq(taskFollowers.boardId, boardId), inArray(taskFollowers.taskId, [...assignees.keys()])))
  for (const [taskId, assigneeId] of assignees) {
    const mine = rows.filter((r) => r.taskId === taskId)
    const ids = mine.filter((r) => r.following).map((r) => r.userId)
    if (assigneeId && !mine.some((r) => r.userId === assigneeId)) ids.push(assigneeId)
    out.set(taskId, ids)
  }
  return out
}

/** Follows a card, or stops (remembered: see `follow`). */
export async function setFollowing(db: Db | Tx, boardId: string, taskId: string, userId: string, following: boolean) {
  await db
    .insert(taskFollowers)
    .values({ boardId, taskId, userId, following })
    .onConflictDoUpdate({ target: [taskFollowers.boardId, taskFollowers.taskId, taskFollowers.userId], set: { following } })
}

/** Tells which cards someone follows on these boards (for searching by it). */
export async function followedBy(db: Db | Tx, userId: string, boardIds: string[]) {
  const rows = boardIds.length
    ? await db
        .select({ boardId: taskFollowers.boardId, taskId: taskFollowers.taskId, following: taskFollowers.following })
        .from(taskFollowers)
        .where(and(eq(taskFollowers.userId, userId), inArray(taskFollowers.boardId, boardIds)))
    : []
  const said = new Map(rows.map((r) => [`${r.boardId}:${r.taskId}`, r.following]))
  return (boardId: string, task: { id: string; assigneeId?: string }) => said.get(`${boardId}:${task.id}`) ?? task.assigneeId === userId
}

/** Whether someone follows a card. */
export async function isFollowing(db: Db | Tx, boardId: string, task: { id: string; assigneeId?: string }, userId: string) {
  const [f] = await db
    .select({ following: taskFollowers.following })
    .from(taskFollowers)
    .where(and(eq(taskFollowers.boardId, boardId), eq(taskFollowers.taskId, task.id), eq(taskFollowers.userId, userId)))
  return f ? f.following : task.assigneeId === userId
}

const q = (s: string) => `“${s}”`
const dayWords = (day: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${day}T00:00:00Z`))

/** One thing that happened to a card that its followers hear about, in words to follow the actor's name. */
interface News {
  taskId: string
  text: string
  /** How it reads to this person instead (the one it was assigned to). */
  toYou?: { userId: string; text: string }
  /** Not for these people (they're told another way: mentioned in the new description). */
  except?: string[]
}

/**
 * What a change did to cards, as their followers hear it: moved to another list, assigned, due date, description,
 * archived or deleted. The rest (order, labels, priority, reminders, a new name) isn't news.
 */
function newsIn(data: BoardData, changes: Change[], mentioned: Map<string, string[]>): News[] {
  const list = (id: string) => data.columns.find((c) => c.id === id)?.name ?? 'another list'
  const person = (id: string) => data.members.find((m) => m.id === id)?.name ?? 'someone'
  const out: News[] = []
  for (const c of changes) {
    if (c.entity !== 'task') continue
    const a = c.before as Task | null
    const b = c.after as Task | null
    if (a && !b) out.push({ taskId: a.id, text: `deleted ${q(a.title)}` })
    if (!a || !b) continue
    const t = q(b.title)
    if (!a.archivedAt !== !b.archivedAt) {
      out.push({ taskId: b.id, text: b.archivedAt ? `archived ${t}${b.archivedDone ? ' as completed' : ''}` : `restored ${t}` })
      continue
    }
    if (a.status !== b.status) out.push({ taskId: b.id, text: `moved ${t} to ${list(b.status)}` })
    if (a.assigneeId !== b.assigneeId)
      out.push({
        taskId: b.id,
        text: b.assigneeId ? `assigned ${t} to ${person(b.assigneeId)}` : `unassigned ${t}`,
        ...(b.assigneeId && { toYou: { userId: b.assigneeId, text: `assigned ${t} to you` } }),
      })
    if (a.due !== b.due)
      out.push({
        taskId: b.id,
        text: !b.due ? `cleared the due date of ${t}` : b.due.length === 10 ? `set ${t} due ${dayWords(b.due)}` : `changed when ${t} is due`,
      })
    if ((a.description ?? '') !== (b.description ?? ''))
      out.push({ taskId: b.id, text: `edited the description of ${t}`, except: mentioned.get(b.id) })
  }
  return out
}

/**
 * After a change to a board: the people it involves start following the cards (whoever made a card, whoever it's
 * assigned to, whoever is newly @mentioned in its description), the newly mentioned are told, and each card's
 * followers hear what happened to it. Never the person who made the change, and only people on the board.
 */
export async function afterBoardChange(
  app: FastifyInstance,
  boardId: string,
  e: { userId: string; command: string; changes: Change[]; data: BoardData },
) {
  const { data, changes, userId: actorId } = e
  const onBoard = new Set(data.members.map((m) => m.id))
  // Undo puts things back: nobody is mentioned again by it, and a card it brings back isn't one you made.
  const undo = e.command === 'records.restore'

  const starts: { taskId: string; userId: string }[] = []
  const assigned: { taskId: string; userId: string }[] = []
  const mentioned = new Map<string, string[]>()
  for (const c of changes) {
    if (c.entity !== 'task' || !c.after) continue
    const a = c.before as Task | null
    const b = c.after as Task
    if (!a && !undo && onBoard.has(actorId)) starts.push({ taskId: b.id, userId: actorId })
    if (b.assigneeId && b.assigneeId !== a?.assigneeId && onBoard.has(b.assigneeId)) assigned.push({ taskId: b.id, userId: b.assigneeId })
    if (undo || (a?.description ?? '') === (b.description ?? '')) continue
    const before = new Set(mentionedIn(a?.description, data.members))
    const fresh = mentionedIn(b.description, data.members).filter((id) => id !== actorId && !before.has(id))
    if (fresh.length) mentioned.set(b.id, fresh)
  }
  const news = newsIn(data, changes, mentioned)
  // A card that was just made has no one to tell yet, except whoever it was given to.
  for (const c of changes)
    if (c.entity === 'task' && !c.before && c.after?.assigneeId && !undo)
      news.push({ taskId: c.id, text: '', toYou: { userId: c.after.assigneeId, text: `assigned ${q(c.after.title)} to you` } })
  if (!starts.length && !assigned.length && !mentioned.size && !news.length) return

  const actor = data.members.find((m) => m.id === actorId)?.name ?? 'Someone'
  const url = (taskId: string) => `/#/b/${encodeURIComponent(boardId)}?task=${encodeURIComponent(taskId)}`
  const pushes: { userId: string; kind: 'mentions' | 'follows'; title: string; body: string; taskId: string }[] = []

  await app.db.transaction(async (tx) => {
    await follow(tx, boardId, assigned, true)
    await follow(tx, boardId, [...starts, ...[...mentioned].flatMap(([taskId, ids]) => ids.map((userId) => ({ taskId, userId })))])

    for (const [taskId, ids] of mentioned) {
      await tx.insert(notifications).values(ids.map((id) => ({ id: newId(), userId: id, kind: 'mention' as const, boardId, taskId, actorId })))
      const t = data.tasks[taskId]
      for (const id of ids)
        pushes.push({
          userId: id,
          kind: 'mentions',
          title: `${actor} mentioned you`,
          body: `In the description of ${q(t?.title ?? 'a task')}`,
          taskId,
        })
    }

    if (!news.length) return
    const assignees = new Map<string, string | undefined>()
    for (const c of changes) if (c.entity === 'task') assignees.set(c.id, (c.after ?? c.before)?.assigneeId)
    const followers = await followersOf(tx, boardId, new Map(news.map((n) => [n.taskId, assignees.get(n.taskId)])))
    // Per person and card: the lines for them.
    const lines = new Map<string, { userId: string; taskId: string; texts: string[] }>()
    for (const n of news)
      for (const userId of followers.get(n.taskId) ?? []) {
        if (userId === actorId || !onBoard.has(userId) || n.except?.includes(userId)) continue
        const text = n.toYou?.userId === userId ? n.toYou.text : n.text
        if (!text) continue
        const key = `${userId}:${n.taskId}`
        if (!lines.has(key)) lines.set(key, { userId, taskId: n.taskId, texts: [] })
        lines.get(key)!.texts.push(text)
      }
    const since = new Date(Date.now() - TOGETHER_MS)
    for (const { userId, taskId, texts } of lines.values()) {
      // More from the same person on the same card, not yet seen: added to that line.
      const [open] = await tx
        .select({ id: notifications.id, changes: notifications.changes })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.kind, 'change'),
            eq(notifications.boardId, boardId),
            eq(notifications.taskId, taskId),
            eq(notifications.actorId, actorId),
            isNull(notifications.readAt),
            isNull(notifications.emailedAt),
            gt(notifications.createdAt, since),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(1)
      if (open)
        await tx
          .update(notifications)
          .set({ changes: [...(open.changes ?? []), ...texts].slice(-MAX_LINES), createdAt: sql`now()` })
          .where(eq(notifications.id, open.id))
      else await tx.insert(notifications).values({ id: newId(), userId, kind: 'change', boardId, taskId, actorId, changes: texts })
      pushes.push({ userId, kind: 'follows', title: `${actor} ${texts[0]}`, body: texts.slice(1).join(' · ') || data.board.name, taskId })
    }
  })

  // As it happens, for the people who want that: on their desktop, and through a Telegram bot of their own. (The
  // board's webhooks were sent this change already: a bot of theirs on this very board that passes card changes
  // on has told their chat, and isn't asked to again.)
  for (const p of pushes)
    void tellPerson(app, p.userId, p.kind, { title: p.title, body: p.body, url: url(p.taskId), tag: `${p.kind}:${boardId}:${p.taskId}` }, 24 * 3600, {
      boardId,
      covered: 'board.changed',
    }).catch((err) => app.log.error({ err: err instanceof Error ? err.message : err }, 'push'))
}
