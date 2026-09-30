import type { CardRow, CardsPage, CardsQuery } from '@kanbanto/model/api'
import type { BoardData, Task } from '@kanbanto/model/types'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { SessionUser } from './auth/sessions'
import { HttpError, parse } from './http'
import { requireUser } from './routes/auth'
import { boardsFor } from './routes/boards'

/**
 * Cards across the boards someone can open, as one searchable list: the Cards page's source. Only archived cards for
 * now; the query is shaped so active cards and more filters (list, person, dates) can be added without a new API.
 */

/** Boards searched at once (each is read from memory or the database). */
const MAX_BOARDS = 100

export async function searchCards(app: FastifyInstance, me: SessionUser, q: CardsQuery): Promise<CardsPage> {
  const mine = await boardsFor(app.db, me.id)
  const boards = q.board ? mine.filter((b) => b.id === q.board) : mine.slice(0, MAX_BOARDS)
  if (q.board && !boards.length) throw new HttpError(404, 'This board doesn’t exist, or you don’t have access to it.')
  const words = q.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
  const matches = (t: Task) => words.every((w) => `${t.title} ${t.description ?? ''}`.toLowerCase().includes(w))

  const rows: CardRow[] = []
  for (const b of boards) {
    const { data } = await app.engine.snapshot(b.id)
    const archived = data.archived ?? {}
    const canEdit = b.role !== 'viewer' && !b.archivedAt
    for (const t of Object.values(archived)) {
      // A card archived with its parent goes with it: only the one that was archived is a row.
      if (t.parentId && archived[t.parentId]) continue
      if (!matches(t)) continue
      rows.push({
        id: t.id,
        title: t.title,
        board: { id: b.id, name: b.name, background: b.background },
        path: pathOf(data, t),
        list: data.columns.find((c) => c.id === t.status)?.name ?? null,
        assignee: t.assigneeId ? (data.members.find((m) => m.id === t.assigneeId)?.name ?? null) : null,
        subtasks: countUnder(archived, t.id),
        archivedAt: t.archivedAt ?? null,
        canEdit,
      })
    }
  }
  rows.sort((x, y) => (y.archivedAt ?? '').localeCompare(x.archivedAt ?? ''))
  const offset = q.offset ?? 0
  const limit = q.limit ?? 50
  const page = rows.slice(offset, offset + limit)
  return { cards: page, total: rows.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null }
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

function countUnder(tasks: Record<string, Task>, id: string): number {
  let n = 0
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const t of Object.values(tasks))
      if (t.parentId === cur) {
        n++
        stack.push(t.id)
      }
  }
  return n
}

const Query = z.object({
  state: z.enum(['archived']).default('archived'),
  board: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

/** GET /api/cards?state=archived&board=…&q=…&offset=… */
export const cardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/cards', async (req) => searchCards(app, requireUser(req.user), parse(Query, req.query)))
}
