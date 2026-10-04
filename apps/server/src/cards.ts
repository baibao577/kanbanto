import type { CardRow, CardsPage, CardsQuery } from '@kanbanto/model/api'
import { toDay } from '@kanbanto/model/dates'
import { indexFor, isLeaf, statusCol } from '@kanbanto/model/indexer'
import {
  CARD_DATES,
  CARD_SORTS,
  CARD_STATES,
  cardMoment,
  compareCards,
  hasWords,
  matchesCard,
  wordsOf,
  type CardFacts,
  type CardFilter,
} from '@kanbanto/model/search'
import { CATEGORIES, PRIORITIES, type BoardData, type Task } from '@kanbanto/model/types'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { SessionUser } from './auth/sessions'
import { HttpError, parse } from './http'
import { dayIn } from './mail/digest'
import { requireUser } from './routes/auth'
import { boardsFor, withPlaces } from './routes/boards'
import { commentsWith, lastCommentsFor } from './routes/comments'

/**
 * Cards across the boards someone can open, as one searchable list: the Search cards page's source. The cards on
 * their boards, the archived ones, or both; filtered by where, who, what kind of list, words (comments too) and
 * dates (see model/search.ts for the rules). Boards are read as the server holds them (from memory, mostly); only
 * comments are looked up in the database.
 */

/** Boards searched at once (each is read from memory or the database). */
const MAX_BOARDS = 100

export async function searchCards(app: FastifyInstance, me: SessionUser, q: CardsQuery): Promise<CardsPage> {
  const mine = await withPlaces(app.db, await boardsFor(app.db, me.id))
  // Archived boards are put away too: they're searched with the archived cards, or when asked for.
  let boards = q.board ? mine.filter((b) => b.id === q.board) : mine.filter((b) => q.state !== 'active' || !b.archivedAt)
  if (q.board && !boards.length) throw new HttpError(404, 'This board doesn’t exist, or you don’t have access to it.')
  if (q.place)
    boards = boards.filter((b) =>
      q.place === 'personal'
        ? !b.workspaceId && b.role === 'owner'
        : q.place === 'shared'
          ? !b.workspaceId && b.role !== 'owner'
          : b.workspaceId === q.place,
    )
  boards = boards.slice(0, MAX_BOARDS)
  const boardIds = boards.map((b) => b.id)

  const words = wordsOf(q.q)
  const moment = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined
    const ms = Date.parse(v)
    if (Number.isNaN(ms)) throw new HttpError(400, `“${name}” isn’t a date: use one like 2026-10-15 or 2026-10-15T07:30:00Z.`)
    return ms
  }
  const filter: CardFilter = {
    words,
    ...(q.assignee && { assignee: q.assignee === 'me' ? me.id : q.assignee === 'none' ? '' : q.assignee }),
    ...(q.priorities && { priorities: q.priorities.map((p) => (p === 'none' ? '' : p)) }),
    ...(q.label?.trim() && { label: q.label.trim().toLowerCase() }),
    due: q.due,
    today: toDay(dayIn(new Date(), me.timeZone ?? 'UTC')),
    kinds: q.kinds,
    completed: q.completed,
    when: q.when,
    from: moment(q.from, 'from'),
    to: moment(q.to, 'to'),
    leaves: q.parents === 'hide',
  }
  // Comments: their text when there are words to find, and when each card last had one when "changed" matters.
  const found = await commentsWith(app.db, boardIds, words)
  const dated = !q.when || q.when === 'any' || q.when === 'changed'
  const commented = dated ? await lastCommentsFor(app.db, boardIds) : new Map<string, Record<string, string>>()

  const rows: { row: CardRow; at: number; createdAt: number; due?: string; priority?: Task['priority'] }[] = []
  const labels = new Set<string>()
  const people = new Map<string, string>()
  for (const b of boards) {
    const { data } = await app.engine.snapshot(b.id)
    const idx = indexFor(data)
    const archived = data.archived ?? {}
    const labelById = new Map(data.labels.map((l) => [l.id, l]))
    for (const l of data.labels) if (l.name.trim()) labels.add(l.name.trim())
    for (const m of data.members) people.set(m.id, m.name)
    const canEdit = b.role !== 'viewer' && !b.archivedAt
    const under = archivedUnder(archived)
    const lastComment = commented.get(b.id) ?? {}

    const consider = (t: Task, put: boolean) => {
      const own = `${t.title} ${t.description ?? ''}`.toLowerCase()
      const bodies = found.get(`${b.id}:${t.id}`) ?? []
      const kind = put ? (t.archivedDone ? 'done' : null) : idx.category.get(t.id)!
      const done = kind === 'done'
      const kids = (put && under.get(t.id)) || NONE
      const facts: CardFacts = {
        text: bodies.length ? `${own} ${bodies.join(' ').toLowerCase()}` : own,
        assigneeId: t.assigneeId,
        priority: t.priority,
        due: t.due,
        labels: t.labels.flatMap((l) => (labelById.get(l)?.name.trim() ? [labelById.get(l)!.name.trim().toLowerCase()] : [])),
        kind,
        done,
        archived: put,
        leaf: put ? !kids.n : isLeaf(idx, t.id),
        createdAt: Date.parse(t.createdAt),
        // Its own last change or comment (not its subtasks': each of them is a row of its own).
        activeAt: Math.max(Date.parse(t.activeAt ?? t.updatedAt), lastComment[t.id] ? Date.parse(lastComment[t.id]) : 0),
        doneAt: !done ? null : put ? Date.parse(t.doneAt ?? t.archivedAt!) : (idx.doneAt.get(t.id) ?? null),
        archivedAt: t.archivedAt ? Date.parse(t.archivedAt) : null,
      }
      if (!matchesCard(facts, filter)) return
      const at = cardMoment(facts, filter)!
      const assignee = t.assigneeId ? (data.members.find((m) => m.id === t.assigneeId)?.name ?? null) : null
      rows.push({
        at: at.at,
        createdAt: facts.createdAt,
        due: t.due,
        priority: t.priority,
        row: {
          id: t.id,
          title: t.title,
          board: { id: b.id, name: b.name, background: b.background },
          place: b.place,
          path: pathOf(data, t),
          archived: put,
          list: put ? (t.archivedList ?? data.columns.find((c) => c.id === t.status)?.name ?? null) : statusCol(idx, t.id).name,
          kind,
          listColor: (put ? null : statusCol(idx, t.id).color) ?? null,
          done,
          completed: put ? (t.archivedDone ?? null) : null,
          assignee,
          priority: t.priority ?? null,
          due: t.due ?? null,
          labels: t.labels.flatMap((l) => (labelById.has(l) ? [{ name: labelById.get(l)!.name, color: labelById.get(l)!.color }] : [])),
          subtasks: put ? kids.n : idx.subTotal.get(t.id)!,
          subtasksDone: put ? kids.done : idx.subDone.get(t.id)!,
          createdAt: t.createdAt,
          activeAt: new Date(facts.activeAt).toISOString(),
          doneAt: facts.doneAt === null ? null : new Date(facts.doneAt).toISOString(),
          archivedAt: t.archivedAt ?? null,
          at: new Date(at.at).toISOString(),
          atKind: at.kind,
          ...(!hasWords(words, own) && { snippet: snippetOf(bodies, words, own) }),
          canEdit,
        },
      })
    }

    if (q.state !== 'archived') for (const id of idx.preorder) consider(data.tasks[id], false)
    if (q.state !== 'active')
      for (const t of Object.values(archived)) {
        // A card archived with its parent goes with it: in the list of archived cards, only the one that was archived
        // is a row. Looking for words, or through every card, each one counts.
        if (q.state === 'archived' && !words.length && t.parentId && archived[t.parentId]) continue
        consider(t, true)
      }
  }
  const order = compareCards(q.sort ?? 'recent')
  rows.sort(order)
  const offset = q.offset ?? 0
  const limit = q.limit ?? 50
  const page = rows.slice(offset, offset + limit).map((r) => r.row)
  return {
    cards: page,
    total: rows.length,
    nextOffset: offset + page.length < rows.length ? offset + page.length : null,
    ...(offset === 0 && {
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
      people: [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    }),
  }
}

/** Its parents' titles, top first (parents may be active or archived). */
function pathOf(data: BoardData, t: Task): string[] {
  const out: string[] = []
  const seen = new Set([t.id])
  let p = t.parentId
  while (p && !seen.has(p)) {
    const parent = data.tasks[p] ?? data.archived?.[p]
    if (!parent) break
    out.unshift(parent.title)
    seen.add(p)
    p = parent.parentId
  }
  return out
}

const NONE = { n: 0, done: 0 }

/**
 * For each archived task with archived tasks under it (at any depth): how many, and how many of those were done.
 * One pass down each tree, so a long chain of nested tasks costs no more than the same number side by side.
 */
function archivedUnder(archived: Record<string, Task>): Map<string, { n: number; done: number }> {
  const kids = new Map<string, string[]>()
  const tops: string[] = []
  for (const t of Object.values(archived)) {
    if (t.parentId && archived[t.parentId] && t.parentId !== t.id) {
      const of = kids.get(t.parentId)
      if (of) of.push(t.id)
      else kids.set(t.parentId, [t.id])
    } else tops.push(t.id)
  }
  const out = new Map<string, { n: number; done: number }>()
  const seen = new Set<string>()
  // Parents before their children, then counted from the bottom up. (Tasks in a loop have no top: they're left out.)
  const order: string[] = []
  const stack = [...tops]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
    stack.push(...(kids.get(id) ?? []))
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const mine = kids.get(order[i])
    if (!mine) continue
    const sum = { n: 0, done: 0 }
    for (const k of mine) {
      const below = out.get(k) ?? NONE
      sum.n += 1 + below.n
      sum.done += (archived[k].archivedDone ? 1 : 0) + below.done
    }
    out.set(order[i], sum)
  }
  return out
}

/** The part of a comment around the first word the card itself doesn't have. */
function snippetOf(bodies: string[], words: string[], own: string): string | undefined {
  const AROUND = 60
  for (const w of words.filter((x) => !own.includes(x)))
    for (const body of bodies) {
      const flat = body.replace(/\s+/g, ' ').trim()
      const i = flat.toLowerCase().indexOf(w)
      if (i < 0) continue
      const from = Math.max(0, i - AROUND)
      const to = Math.min(flat.length, i + w.length + AROUND)
      return `${from > 0 ? '…' : ''}${flat.slice(from, to).trim()}${to < flat.length ? '…' : ''}`
    }
  return undefined
}

/** `a,b,c` in the address, as a list of the values allowed. */
const listOf = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .max(200)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values as readonly [T, ...T[]])))
    .optional()

const Query = z
  .object({
    state: z.enum(CARD_STATES).default('archived'),
    board: z.string().max(100).optional(),
    place: z.string().max(100).optional(),
    q: z.string().max(200).optional(),
    completed: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    kind: listOf(CATEGORIES),
    assignee: z.string().max(100).optional(),
    priority: listOf([...PRIORITIES, 'none'] as const),
    label: z.string().max(200).optional(),
    due: z.enum(['overdue', 'week', 'none']).optional(),
    when: z.enum(CARD_DATES).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    parents: z.enum(['hide']).optional(),
    sort: z.enum(CARD_SORTS).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .transform(({ kind, priority, ...q }): CardsQuery => ({
    ...q,
    ...(kind?.length && { kinds: kind }),
    ...(priority?.length && { priorities: priority }),
  }))

/** GET /api/cards?state=all&q=…&assignee=me&when=done&from=…&to=… (see CardsQuery) */
export const cardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/cards', async (req) => searchCards(app, requireUser(req.user), parse(Query, req.query)))
}
