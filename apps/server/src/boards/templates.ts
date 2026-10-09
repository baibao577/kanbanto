import { newId } from '@kanbanto/model/ids'
import { carryCustom } from '@kanbanto/model/fields'
import { emptyBoard } from '@kanbanto/model/sample'
import type { BoardBackground } from '@kanbanto/model/colors'
import {
  boardTemplateOf,
  readTemplateCards,
  templateOf,
  BOARD_TEMPLATE_TEXT_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_TEXT_MAX,
  TEMPLATES_MAX,
  type BoardTemplate,
  type BoardTemplateContent,
  type CardTemplate,
  type TemplateCard,
} from '@kanbanto/model/templates'
import type { BoardData, Meta } from '@kanbanto/model/types'
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db, Tx } from '../db'
import { boardActivity, boardTemplates, cardTemplates, users, workspaces } from '../db/schema'
import { HttpError } from '../http'
import { workspaceRole } from './access'
import { applyAdoption, fitStarter, replaceBoardFields, type Library } from './fields'
import { adoptRules } from './rules'
import { insertBoard } from './service'

// Templates (see model templates.ts). A card template lives with its board and is everyone's on it; a board
// template is a workspace's or a person's. Each is a copy taken when saved: made here from the board as the server
// has it, never from what a browser sends, so what a template holds is always something a board really had.

/** A name as it's kept: trimmed, and one a template can have. */
function nameOf(raw: string): string {
  const name = raw.trim().normalize('NFC')
  if (!name) throw new HttpError(400, 'Give the template a name.')
  if (name.length > TEMPLATE_NAME_MAX) throw new HttpError(400, `A template’s name can be ${TEMPLATE_NAME_MAX} characters at most.`)
  return name
}

const said = (actorId: string, boardId: string, text: string, via?: string | null) => ({
  id: newId(),
  boardId,
  actorId,
  command: 'board.templates',
  items: [{ text }],
  via: via ?? null,
})

/** A board's card templates, by name. One whose cards can't be read (a shape a newer version saved) is left out. */
export async function cardTemplatesOf(db: Db | Tx, boardId: string): Promise<CardTemplate[]> {
  const rows = await db
    .select({ t: cardTemplates, by: users.name })
    .from(cardTemplates)
    .leftJoin(users, eq(users.id, cardTemplates.updatedBy))
    .where(eq(cardTemplates.boardId, boardId))
    .orderBy(asc(cardTemplates.name), asc(cardTemplates.createdAt))
  return rows.flatMap(({ t, by }) => {
    const cards = readTemplateCards(t.cards)
    return cards ? [{ id: t.id, name: t.name, cards, by, updatedAt: t.updatedAt.toISOString() }] : []
  })
}

/**
 * Saves a card, with everything under it, as one of its board's templates: a new one, or (`replace`) over one that
 * is there, which keeps its name unless another is given. The copy is taken from the board as it is now.
 */
export async function saveCardTemplate(
  app: FastifyInstance,
  boardId: string,
  me: { id: string },
  input: { taskId: string; name?: string; replace?: string },
  via?: string | null,
): Promise<CardTemplate> {
  const { data } = await app.engine.snapshot(boardId)
  const cards = templateOf(data, input.taskId)
  if ('error' in cards) throw new HttpError(data.tasks[input.taskId] ? 422 : 404, cards.error)
  if (JSON.stringify(cards).length > TEMPLATE_TEXT_MAX)
    throw new HttpError(
      422,
      'This card and what is under it hold too much text to keep as a template. Shorten the descriptions, or save a smaller part of it.',
    )
  const id = await app.db.transaction(async (tx) => {
    if (input.replace) {
      const [was] = await tx
        .select()
        .from(cardTemplates)
        .where(and(eq(cardTemplates.id, input.replace), eq(cardTemplates.boardId, boardId)))
      if (!was) throw new HttpError(404, 'That template no longer exists.')
      const name = input.name?.trim() ? nameOf(input.name) : was.name
      await tx.update(cardTemplates).set({ name, cards, updatedBy: me.id, updatedAt: new Date() }).where(eq(cardTemplates.id, was.id))
      await tx.insert(boardActivity).values(said(me.id, boardId, `saved “${cards[0].title}” over the template “${name}”`, via))
      return was.id
    }
    const name = nameOf(input.name ?? cards[0].title)
    const [{ n }] = await tx.select({ n: count() }).from(cardTemplates).where(eq(cardTemplates.boardId, boardId))
    if (n >= TEMPLATES_MAX) throw new HttpError(422, `A board can have up to ${TEMPLATES_MAX} card templates. Remove one first, or save over one.`)
    const made = newId()
    await tx.insert(cardTemplates).values({ id: made, boardId, name, cards, updatedBy: me.id })
    await tx.insert(boardActivity).values(said(me.id, boardId, `saved “${cards[0].title}” as the template “${name}”`, via))
    return made
  })
  app.hub.broadcast(boardId, { type: 'templates' })
  return (await cardTemplatesOf(app.db, boardId)).find((t) => t.id === id)!
}

/** Gives a card template another name. */
export async function renameCardTemplate(app: FastifyInstance, boardId: string, me: { id: string }, id: string, raw: string, via?: string | null) {
  const name = nameOf(raw)
  const [was] = await app.db
    .update(cardTemplates)
    .set({ name, updatedBy: me.id, updatedAt: new Date() })
    .where(and(eq(cardTemplates.id, id), eq(cardTemplates.boardId, boardId)))
    .returning()
  if (!was) throw new HttpError(404, 'That template no longer exists.')
  await app.db.insert(boardActivity).values(said(me.id, boardId, `renamed a template to “${name}”`, via))
  app.hub.broadcast(boardId, { type: 'templates' })
}

/** Removes a card template. (The cards made from it stay as they are.) */
export async function removeCardTemplate(app: FastifyInstance, boardId: string, me: { id: string }, id: string, via?: string | null) {
  const [was] = await app.db
    .delete(cardTemplates)
    .where(and(eq(cardTemplates.id, id), eq(cardTemplates.boardId, boardId)))
    .returning()
  if (!was) throw new HttpError(404, 'That template no longer exists.')
  await app.db.insert(boardActivity).values(said(me.id, boardId, `removed the template “${was.name}”`, via))
  app.hub.broadcast(boardId, { type: 'templates' })
}

// ── Board templates ─────────────────────────────────────────────────────────

type TemplateRow = typeof boardTemplates.$inferSelect
const contentOf = (row: TemplateRow) => row.content as BoardTemplateContent
const whereOf = (lib: Library) =>
  'workspaceId' in lib
    ? eq(boardTemplates.workspaceId, lib.workspaceId)
    : and(eq(boardTemplates.ownerId, lib.ownerId), isNull(boardTemplates.workspaceId))

/** May this person rename, replace and remove a board template? Their own; a workspace's for its admins and whoever saved it. */
const canChange = (row: Pick<TemplateRow, 'workspaceId' | 'ownerId' | 'updatedBy'>, userId: string, admin: boolean) =>
  row.workspaceId ? admin || row.updatedBy === userId : row.ownerId === userId

/** The board templates of a place: a workspace's (for its members), or a person's own. */
export async function boardTemplatesOf(db: Db | Tx, lib: Library, me: { id: string }): Promise<BoardTemplate[]> {
  const admin = 'workspaceId' in lib ? (await workspaceRole(db, lib.workspaceId, me.id)) === 'admin' : false
  // (How many of each a template holds is counted by the database: a list of templates doesn't read their contents.)
  const many = (part: 'columns' | 'fields' | 'cardTemplates') => {
    const it = sql`${boardTemplates.content}->${sql.raw(`'${part}'`)}`
    return sql<number>`case when jsonb_typeof(${it}) = 'array' then jsonb_array_length(${it}) else 0 end`.mapWith(Number)
  }
  const rows = await db
    .select({
      id: boardTemplates.id,
      name: boardTemplates.name,
      workspaceId: boardTemplates.workspaceId,
      ownerId: boardTemplates.ownerId,
      updatedBy: boardTemplates.updatedBy,
      updatedAt: boardTemplates.updatedAt,
      lists: many('columns'),
      fields: many('fields'),
      cardTemplates: many('cardTemplates'),
      by: users.name,
    })
    .from(boardTemplates)
    .leftJoin(users, eq(users.id, boardTemplates.updatedBy))
    .where(whereOf(lib))
    .orderBy(asc(boardTemplates.name), asc(boardTemplates.createdAt))
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    workspaceId: t.workspaceId,
    lists: t.lists,
    fields: t.fields,
    cardTemplates: t.cardTemplates,
    by: t.by,
    updatedAt: t.updatedAt.toISOString(),
    canChange: canChange(t, me.id, admin),
  }))
}

/** A board template the person may use: one of their own, or one of a workspace they are in. */
async function usable(db: Db | Tx, id: string, me: { id: string }): Promise<{ row: TemplateRow; admin: boolean }> {
  const [row] = await db.select().from(boardTemplates).where(eq(boardTemplates.id, id))
  const role = row?.workspaceId ? await workspaceRole(db, row.workspaceId, me.id) : null
  if (!row || (row.workspaceId ? !role : row.ownerId !== me.id)) throw new HttpError(404, 'That template no longer exists.')
  return { row, admin: role === 'admin' }
}

/**
 * Saves a board's shape as a board template, where the board lives: its workspace's, or (a Personal board) the
 * person's own. A new one, or (`replace`) over one of that place they may change. Never its cards or its people.
 */
export async function saveBoardTemplate(
  app: FastifyInstance,
  board: { id: string; workspaceId: string | null },
  me: { id: string },
  input: { name?: string; replace?: string },
  via?: string | null,
): Promise<BoardTemplate> {
  // A workspace's templates are its people's: an owner of one of its boards who isn't in the workspace doesn't add
  // to them (they could fill the workspace's thirty, and not take one away again).
  if (board.workspaceId && !(await workspaceRole(app.db, board.workspaceId, me.id)))
    throw new HttpError(403, 'Only people in this board’s workspace can save it as one of the workspace’s templates.')
  const { data } = await app.engine.snapshot(board.id)
  const content = boardTemplateOf(data, await cardTemplatesOf(app.db, board.id))
  if (JSON.stringify(content).length > BOARD_TEMPLATE_TEXT_MAX)
    throw new HttpError(422, 'This board’s card templates hold too much text to keep with a board template. Remove or shorten some of them first.')
  const lib: Library = board.workspaceId ? { workspaceId: board.workspaceId } : { ownerId: me.id }
  const id = await app.db.transaction(async (tx) => {
    if (input.replace) {
      const { row, admin } = await usable(tx, input.replace, me)
      // (Over a template of the same place only: a workspace's board saves over that workspace's.)
      if ((row.workspaceId ?? null) !== (board.workspaceId ?? null)) throw new HttpError(404, 'That template no longer exists.')
      if (!canChange(row, me.id, admin))
        throw new HttpError(403, 'Only whoever saved this template, or one of the workspace’s admins, can save over it.')
      const name = input.name?.trim() ? nameOf(input.name) : row.name
      await tx.update(boardTemplates).set({ name, content, updatedBy: me.id, updatedAt: new Date() }).where(eq(boardTemplates.id, row.id))
      await tx.insert(boardActivity).values(said(me.id, board.id, `saved this board over the board template “${name}”`, via))
      return row.id
    }
    const name = nameOf(input.name ?? data.board.name)
    const [{ n }] = await tx.select({ n: count() }).from(boardTemplates).where(whereOf(lib))
    if (n >= TEMPLATES_MAX) throw new HttpError(422, `There can be up to ${TEMPLATES_MAX} board templates here. Remove one first, or save over one.`)
    const made = newId()
    await tx.insert(boardTemplates).values({
      id: made,
      ownerId: board.workspaceId ? null : me.id,
      workspaceId: board.workspaceId,
      name,
      content,
      updatedBy: me.id,
    })
    await tx.insert(boardActivity).values(said(me.id, board.id, `saved this board as the board template “${name}”`, via))
    return made
  })
  return (await boardTemplatesOf(app.db, lib, me)).find((t) => t.id === id)!
}

/** Gives a board template another name, or (no name) removes it: for whoever may change it. */
export async function changeBoardTemplate(db: Db, me: { id: string }, id: string, name?: string) {
  const { row, admin } = await usable(db, id, me)
  if (!canChange(row, me.id, admin)) throw new HttpError(403, 'Only whoever saved this template, or one of the workspace’s admins, can change it.')
  if (name === undefined) await db.delete(boardTemplates).where(eq(boardTemplates.id, id))
  else
    await db
      .update(boardTemplates)
      .set({ name: nameOf(name), updatedAt: new Date() })
      .where(eq(boardTemplates.id, id))
}

const listed = (names: string[]) => names.map((n) => `“${n}”`).join(', ')

/**
 * Makes a board from a board template, where the person says (a workspace they are in, or Personal): its lists,
 * labels, rules and card templates, and its fields from the library of that place, as a starter's are (the ones the
 * library has, by name and kind, are used; the rest are added, which in a workspace only its admins may do, and
 * nothing is made when one can't be). No cards and no people but its maker. A rule that names people stays behind.
 */
export async function createFromTemplate(
  app: FastifyInstance,
  me: { id: string },
  templateId: string,
  opts: { name: string; background?: BoardBackground; workspaceId?: string | null; description?: string },
): Promise<{ id: string; added: string[]; leftOut: string[] }> {
  const { row } = await usable(app.db, templateId, me)
  const content = contentOf(row)
  const id = newId()
  const now = new Date().toISOString()
  const workspaceId = opts.workspaceId ?? null
  const lib: Library = workspaceId ? { workspaceId } : { ownerId: me.id }
  const fresh = <T extends Meta>(r: T): T => ({ ...r, createdAt: now, updatedAt: now, version: 1 })
  const base = emptyBoard(id, opts.name, now)
  const data: BoardData = {
    ...base,
    board: {
      ...base.board,
      mode: content.board.mode,
      ...((opts.background ?? content.board.background) ? { background: (opts.background ?? content.board.background) as BoardBackground } : {}),
      ...((opts.description?.trim() || content.board.description) && { description: opts.description?.trim() || content.board.description }),
    },
    columns: content.columns.map(fresh),
    labels: content.labels.map(fresh),
  }
  const made = await app.db.transaction(async (tx) => {
    const canAdd = workspaceId ? (await workspaceRole(tx, workspaceId, me.id)) === 'admin' : true
    const plan = await fitStarter(tx, lib, content.fields, canAdd)
    if (plan.cant.length) {
      if (plan.why === 'room')
        throw new HttpError(400, `There’s no room for this template’s fields (${listed(plan.cant)}). Archive some that are no longer used first.`)
      const [ws] = workspaceId ? await tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)) : []
      throw new HttpError(
        403,
        `This template needs fields that ${ws?.name ?? 'this workspace'} doesn’t have yet: ${listed(plan.cant)}. Only the workspace’s admins can add fields: ask one to make the first board from it.`,
      )
    }
    await applyAdoption(app, tx, lib, { add: plan.add, addOptions: new Map() })
    await insertBoard(tx, data, me.id, workspaceId)
    await replaceBoardFields(
      tx,
      id,
      content.fields.flatMap((f) => (plan.map.has(f.id) ? [{ id: plan.map.get(f.id)!.id, front: f.front, total: f.total }] : [])),
    )
    const people = new Set(content.fields.filter((f) => f.type === 'person').map((f) => f.id))
    await adoptRules(tx, id, content.rules, me.id, plan.map, (f) => people.has(f))
    // Its card templates come as copies, their values under the fields' ids in this library.
    const kept = (content.cardTemplates ?? []).slice(0, TEMPLATES_MAX).flatMap((t) => {
      const cards = readTemplateCards(t.cards)
      if (!cards) return []
      const fitted = cards.map((c): TemplateCard => {
        const { custom: held, ...rest } = c
        const custom = carryCustom(held, plan.map)
        return custom && Object.keys(custom).length ? { ...rest, custom } : rest
      })
      return [{ id: newId(), boardId: id, name: t.name, cards: fitted, updatedBy: me.id }]
    })
    if (kept.length) await tx.insert(cardTemplates).values(kept)
    return { added: plan.add.map((f) => f.name), leftOut: plan.leftOut }
  })
  return { id, ...made }
}
