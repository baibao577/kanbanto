import type { LinkedCard, LinkedFrom, LinkedFromGroup, LinkPick } from '@kanbanto/model/api'
import { FIELD_LIMITS, linkRef, linksOf, mapLinks, numberText, parseRef, type BoardField, type FieldDef } from '@kanbanto/model/fields'
import { indexFor, statusCol } from '@kanbanto/model/indexer'
import type { Change } from '@kanbanto/model/records'
import { hasWords, wordsOf } from '@kanbanto/model/search'
import { sumOf } from '@kanbanto/model/totals'
import type { BoardData, Task } from '@kanbanto/model/types'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import { boardFieldRows, boardMembers, boards, libraryFields, tasks } from '../db/schema'
import { openBoards, type BoardRow } from './access'
import type { BoardEngine } from './engine'
import { writeCustom } from './store'

/**
 * Links between cards (the card link field: see model/fields.ts for what a link is and what one board can check).
 *
 * What only the server can know is here: whether the card a link names is in the same space, may be opened by the
 * person, and exists. The rules are checked when a link is written (`checkLinks`) and again whenever it's read
 * (`resolveLinks`), so a link that slips past a clean-up just reads "A card you can't open" and does no harm. That
 * is what lets the clean-ups across boards (`relink`) run after the change that caused them, on their own.
 *
 * A space is where a field lives: a workspace, or one person's own boards. A workspace's field links cards of that
 * workspace's boards. A person's field links cards on the board it's used on, or between two boards that person
 * owns.
 */
type Space = { workspaceId: string } | { ownerId: string }
const spaceOf = (f: { workspaceId: string | null; ownerId: string | null }): Space =>
  f.workspaceId ? { workspaceId: f.workspaceId } : { ownerId: f.ownerId! }

interface BoardFact {
  id: string
  name: string
  background: string | null
  workspaceId: string | null
  archivedAt: Date | null
  owners: Set<string>
}

const textArray = (xs: string[]) =>
  sql`array[${sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  )}]::text[]`

/** What deciding about a link needs to know of a board: where it lives, and who owns it. Boards that don't exist are left out. */
async function boardFacts(tx: Db | Tx, ids: string[]): Promise<Map<string, BoardFact>> {
  const wanted = [...new Set(ids)]
  if (!wanted.length) return new Map()
  const rows = await tx
    .select({ id: boards.id, name: boards.name, background: boards.background, workspaceId: boards.workspaceId, archivedAt: boards.archivedAt })
    .from(boards)
    .where(inArray(boards.id, wanted))
  const owners = await tx
    .select({ boardId: boardMembers.boardId, userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(inArray(boardMembers.boardId, wanted), eq(boardMembers.role, 'owner')))
  const out = new Map(rows.map((r) => [r.id, { ...r, owners: new Set<string>() }]))
  for (const o of owners) out.get(o.boardId)?.owners.add(o.userId)
  return out
}

/** May a field of this space, used on `holder`, link a card on `target`? */
function inSpace(space: Space, holder: BoardFact, target: BoardFact): boolean {
  if (holder.id === target.id) return true
  if ('workspaceId' in space) return holder.workspaceId === space.workspaceId && target.workspaceId === space.workspaceId
  return !holder.workspaceId && !target.workspaceId && holder.owners.has(space.ownerId) && target.owners.has(space.ownerId)
}

/** May a link field of `space` take its cards from this board, as far as `userId` (who is setting it up) can open it? */
export async function canLinkTo(tx: Db | Tx, space: Space, boardId: string, userId: string): Promise<boolean> {
  const fact = (await boardFacts(tx, [boardId])).get(boardId)
  if (!fact) return false
  const near = 'workspaceId' in space ? fact.workspaceId === space.workspaceId : !fact.workspaceId && fact.owners.has(space.ownerId)
  return near && (await openBoards(tx, userId)).some((b) => b.id === boardId)
}

/** The spaces of these fields, by field id (a field that's gone is left out). */
async function spacesOf(tx: Db | Tx, fieldIds: string[]): Promise<Map<string, Space>> {
  const ids = [...new Set(fieldIds)]
  if (!ids.length) return new Map()
  const rows = await tx
    .select({ id: libraryFields.id, workspaceId: libraryFields.workspaceId, ownerId: libraryFields.ownerId })
    .from(libraryFields)
    .where(inArray(libraryFields.id, ids))
  return new Map(rows.map((r) => [r.id, spaceOf(r)]))
}

export interface GainedLink {
  taskId: string
  fieldId: string
  ref: string
}

/** The links these changes add to cards: the ones a card has after and didn't have before. */
export function gainedLinks(fields: FieldDef[], changes: Change[]): GainedLink[] {
  const links = fields.filter((f) => f.type === 'link')
  if (!links.length) return []
  const out: GainedLink[] = []
  for (const c of changes) {
    if (c.entity !== 'task' || !c.after) continue
    const after = (c.after as Task).custom
    if (!after) continue
    const before = (c.before as Task | null)?.custom
    for (const f of links) {
      const held = new Set(linksOf(before?.[f.id]))
      for (const ref of linksOf(after[f.id])) if (!held.has(ref)) out.push({ taskId: c.id, fieldId: f.id, ref })
    }
  }
  return out
}

/**
 * Checks links being added on `boardId` by `userId`, with what one board can't know: the card's board is in the
 * field's space, the person can open it (as a member or through its workspace: a public link isn't enough), and the
 * card is there. Runs on the open transaction, by primary keys. Returns the ones that fail, with why in words.
 *
 * The two answers give nothing away: a board outside the space reads the same whether it exists or not, and so does
 * a card on a board the person can't open.
 */
export async function checkLinks(
  tx: Tx,
  boardId: string,
  userId: string,
  fields: FieldDef[],
  gained: GainedLink[],
): Promise<(GainedLink & { error: string })[]> {
  // (A card on this board was checked by the board itself, which has it in hand.)
  const elsewhere = gained.flatMap((g) => {
    const to = parseRef(g.ref)
    return to && to.boardId !== boardId ? [{ ...g, to }] : []
  })
  if (!elsewhere.length) return []
  const facts = await boardFacts(tx, [boardId, ...elsewhere.map((g) => g.to.boardId)])
  const spaces = await spacesOf(
    tx,
    elsewhere.map((g) => g.fieldId),
  )
  const open = new Set((await openBoards(tx, userId)).map((b) => b.id))
  const pairs = elsewhere.filter((g) => open.has(g.to.boardId))
  const there = pairs.length
    ? await tx
        .select({ boardId: tasks.boardId, id: tasks.id })
        .from(tasks)
        .where(
          sql`(${tasks.boardId}, ${tasks.id}) in (${sql.join(
            pairs.map((g) => sql`(${g.to.boardId}, ${g.to.taskId})`),
            sql`, `,
          )})`,
        )
    : []
  const exists = new Set(there.map((t) => linkRef(t.boardId, t.id)))
  const holder = facts.get(boardId)
  const name = (id: string) => fields.find((f) => f.id === id)?.name ?? 'That field'
  return elsewhere.flatMap(({ to, ...g }) => {
    const space = spaces.get(g.fieldId)
    const target = facts.get(to.boardId)
    if (!holder || !space || !target || !inSpace(space, holder, target))
      return [{ ...g, error: `${name(g.fieldId)}: a link stays inside one ${space && 'ownerId' in space ? 'person’s own boards' : 'workspace'}.` }]
    if (!open.has(to.boardId) || !exists.has(g.ref))
      return [{ ...g, error: `${name(g.fieldId)}: that card doesn’t exist, or you can’t open its board.` }]
    return []
  })
}

/** These changes without the links that failed `checkLinks` (an undo that would bring one back keeps the rest). */
export function withoutLinks(changes: Change[], bad: GainedLink[]): Change[] {
  const drop = new Map<string, Map<string, Set<string>>>()
  for (const b of bad) {
    const byField = drop.get(b.taskId) ?? new Map<string, Set<string>>()
    byField.set(b.fieldId, (byField.get(b.fieldId) ?? new Set<string>()).add(b.ref))
    drop.set(b.taskId, byField)
  }
  return changes.map((c) => {
    const byField = c.entity === 'task' && c.after ? drop.get(c.id) : undefined
    if (!byField) return c
    const t = c.after as Task
    let custom = t.custom
    for (const [fieldId, refs] of byField) custom = mapLinks(custom, new Set([fieldId]), (ref) => (refs.has(ref) ? null : ref))
    const { custom: _held, ...rest } = t
    return { ...c, after: custom ? { ...rest, custom } : rest } as Change
  })
}

// ── Reading ────────────────────────────────────────────────────────────────────

/** Links a board's answer resolves with it; the rest are asked for as they're needed. */
const MAX_RESOLVED = 2000

/**
 * The links held by a board's cards that the board itself can't show: cards on other boards, and ones that aren't
 * among its active cards any more (archived, or deleted).
 */
export function linksToResolve(data: BoardData): string[] {
  const links = data.fields.filter((f) => f.type === 'link')
  if (!links.length) return []
  const out = new Set<string>()
  for (const t of Object.values(data.tasks)) {
    if (!t.custom) continue
    for (const f of links)
      for (const ref of linksOf(t.custom[f.id])) {
        const to = parseRef(ref)
        if (to && !(to.boardId === data.board.id && to.taskId in data.tasks)) out.add(ref)
        if (out.size >= MAX_RESOLVED) return [...out]
      }
  }
  return [...out]
}

function cardFor(data: BoardData, taskId: string): LinkedCard {
  const board = { id: data.board.id, name: data.board.name }
  const t = data.tasks[taskId]
  if (t) {
    // (From the index: a parent's list may follow its subtasks.)
    const col = statusCol(indexFor(data), taskId)
    return { title: t.title, board, list: col.name, kind: col.category, done: col.category === 'done' }
  }
  const put = data.archived?.[taskId]
  if (!put) return { gone: true }
  return { title: put.title, board, list: put.archivedList ?? null, kind: null, done: !!put.archivedDone, archived: true }
}

/**
 * What these links point at, for one viewer of `holder`: each card's title, board and list. A card on a board the
 * viewer can't open, outside the holder's space, or on a board that doesn't exist is `hidden`, without a look at
 * whether the card is there: nothing can be found out by asking. `userId` undefined: a visitor with a public link,
 * who sees only cards of the board in front of them.
 */
export async function resolveLinks(
  env: { db: Db; engine: BoardEngine },
  userId: string | undefined,
  holder: BoardRow,
  data: BoardData,
  refs: string[],
): Promise<Record<string, LinkedCard>> {
  const out: Record<string, LinkedCard> = {}
  const elsewhere = new Map<string, string[]>()
  for (const ref of refs.slice(0, MAX_RESOLVED)) {
    const to = parseRef(ref)
    if (!to) continue
    if (to.boardId === holder.id) out[ref] = cardFor(data, to.taskId)
    else if (!userId) out[ref] = { hidden: true }
    else elsewhere.set(to.boardId, [...(elsewhere.get(to.boardId) ?? []), ref])
  }
  if (!elsewhere.size || !userId) return out
  const open = new Set((await openBoards(env.db, userId)).map((b) => b.id))
  const facts = await boardFacts(env.db, [holder.id, ...elsewhere.keys()])
  const here = facts.get(holder.id)
  // Same space, as far as a reader can tell without the field: the same workspace, or two boards of one owner.
  const near = (b: BoardFact) =>
    !!here && (here.workspaceId ? b.workspaceId === here.workspaceId : !b.workspaceId && [...here.owners].some((o) => b.owners.has(o)))
  const visible = [...elsewhere.keys()].filter((id) => open.has(id) && facts.has(id) && near(facts.get(id)!))
  const loaded = await env.engine.snapshots(visible)
  for (const [boardId, list] of elsewhere) {
    const other = loaded.get(boardId)
    for (const ref of list) out[ref] = other ? cardFor(other, parseRef(ref)!.taskId) : { hidden: true }
  }
  return out
}

/** The link fields that are in use somewhere in a board's space: (board, field) pairs, and each field's space. */
async function linkFieldsNear(tx: Db | Tx, holder: BoardFact, opts: { removed?: boolean } = {}) {
  if (!holder.workspaceId && !holder.owners.size) return []
  const space = holder.workspaceId ? eq(libraryFields.workspaceId, holder.workspaceId) : inArray(libraryFields.ownerId, [...holder.owners])
  return tx
    .select({
      boardId: boardFieldRows.boardId,
      fieldId: boardFieldRows.fieldId,
      workspaceId: libraryFields.workspaceId,
      ownerId: libraryFields.ownerId,
    })
    .from(boardFieldRows)
    .innerJoin(libraryFields, eq(libraryFields.id, boardFieldRows.fieldId))
    .where(and(eq(libraryFields.type, 'link'), space, ...(opts.removed ? [] : [isNull(boardFieldRows.removedAt), isNull(libraryFields.archivedAt)])))
}

/** Could a card of this board be linked from somewhere? (So a card only asks who links to it when someone might.) */
export async function canBeLinked(db: Db, holder: BoardRow): Promise<boolean> {
  const fact = (await boardFacts(db, [holder.id])).get(holder.id)
  return !!fact && (await linkFieldsNear(db, fact)).length > 0
}

/** Cards shown in one "Linked from" group; the rest are counted. */
const MAX_LISTED = 50

/**
 * The cards that link to `taskIds` of `holder` (one card; or a card and its subtasks, to say what a move would
 * undo), for one viewer: grouped by the board and field they're linked from, each group with the totals of that
 * board's numbers that add up. Linking cards on boards the viewer can't open are only counted.
 */
export async function linkedFrom(
  env: { db: Db; engine: BoardEngine },
  userId: string | undefined,
  holder: BoardRow,
  taskIds: string[],
): Promise<LinkedFrom> {
  const fact = (await boardFacts(env.db, [holder.id])).get(holder.id)
  if (!fact || !taskIds.length) return { groups: [], hidden: 0 }
  const pairs = await linkFieldsNear(env.db, fact)
  if (!pairs.length) return { groups: [], hidden: 0 }
  const wanted = new Set(taskIds.map((id) => linkRef(holder.id, id)))
  const open = userId ? new Set((await openBoards(env.db, userId)).map((b) => b.id)) : new Set([holder.id])
  const facts = await boardFacts(
    env.db,
    pairs.map((p) => p.boardId),
  )
  const fieldsOn = new Map<string, string[]>()
  for (const p of pairs) {
    const from = facts.get(p.boardId)
    if (from && inSpace(spaceOf(p), from, fact)) fieldsOn.set(p.boardId, [...(fieldsOn.get(p.boardId) ?? []), p.fieldId])
  }
  const seen = [...fieldsOn.keys()].filter((id) => open.has(id))
  const loaded = await env.engine.snapshots(seen)
  const groups: LinkedFromGroup[] = []
  for (const boardId of seen) {
    const data = loaded.get(boardId)
    if (!data) continue
    const idx = indexFor(data)
    for (const f of data.fields) {
      if (f.type !== 'link' || !fieldsOn.get(boardId)!.includes(f.id)) continue
      const from = idx.preorder.filter(
        (id) => !(boardId === holder.id && taskIds.includes(id)) && linksOf(data.tasks[id].custom?.[f.id]).some((r) => wanted.has(r)),
      )
      if (!from.length) continue
      groups.push({
        board: { id: boardId, name: data.board.name, background: data.board.background ?? null },
        field: { id: f.id, name: f.name, ...(f.back && { back: f.back }) },
        cards: from.slice(0, MAX_LISTED).map((id) => {
          const col = statusCol(idx, id)
          return { id, title: data.tasks[id].title, list: col.name, kind: col.category, done: col.category === 'done' }
        }),
        count: from.length,
        totals: totalsOf(data, from),
      })
    }
  }
  // On boards the viewer can't open: how many, and nothing else.
  const unseen = [...fieldsOn.entries()].filter(([id]) => !open.has(id))
  let hidden = 0
  for (const [boardId, fieldIds] of unseen) {
    const rows = await env.db
      .select({ custom: tasks.custom })
      .from(tasks)
      .where(and(eq(tasks.boardId, boardId), isNull(tasks.archivedAt), sql`jsonb_exists_any(${tasks.custom}, ${textArray(fieldIds)})`))
    hidden += rows.filter((r) => fieldIds.some((f) => linksOf(r.custom?.[f]).some((ref) => wanted.has(ref)))).length
  }
  return { groups, hidden }
}

/** What these cards add up to, for the board's numbers that add up (the ones totalled in lists first; three at most). */
function totalsOf(data: BoardData, ids: string[]): { name: string; text: string }[] {
  const sums = data.fields.filter((f) => f.type === 'number' && f.sum).sort((a, b) => Number(!!b.total) - Number(!!a.total))
  return sums
    .flatMap((f) => {
      const numbers = ids.flatMap((id) => {
        const v = data.tasks[id].custom?.[f.id]
        return typeof v === 'number' ? [v] : []
      })
      return numbers.length ? [{ name: f.name, text: numberText(f, sumOf(f, numbers)) }] : []
    })
    .slice(0, FIELD_LIMITS.totals)
}

/** Cards the picker offers at once, and boards it looks through. */
const MAX_PICKS = 30
const MAX_PICK_BOARDS = 50

/**
 * Cards to pick for a link field on `holder`, by words in their titles (the latest ones, with no words): from the
 * board the field names, this board, or the boards of the field's space, kept to the ones the person can open.
 * `problem` says why there's nothing to pick from, when the field's board is gone or out of reach.
 */
export async function pickCards(
  env: { db: Db; engine: BoardEngine },
  userId: string,
  holder: BoardRow,
  field: BoardField,
  q: string,
  except?: string,
): Promise<{ cards: LinkPick[]; problem?: string }> {
  const space = (await spacesOf(env.db, [field.id])).get(field.id)
  if (!space) return { cards: [], problem: 'This field no longer exists.' }
  const open = await openBoards(env.db, userId)
  const scope = field.linkTo ?? 'space'
  const ids =
    scope === 'same' ? [holder.id] : scope === 'board' ? (field.board ? [field.board] : []) : open.filter((b) => !b.archivedAt).map((b) => b.id)
  const facts = await boardFacts(env.db, [holder.id, ...ids])
  const here = facts.get(holder.id)
  const allowed = ids.filter(
    (id) => here && facts.has(id) && inSpace(space, here, facts.get(id)!) && (id === holder.id || open.some((b) => b.id === id)),
  )
  if (scope === 'board' && !allowed.length)
    return { cards: [], problem: 'The board this field’s cards come from is gone, or you can’t open it. Its settings say which board that is.' }
  // This board first, then the others by name.
  const order = [...allowed].sort((a, b) => Number(b === holder.id) - Number(a === holder.id) || facts.get(a)!.name.localeCompare(facts.get(b)!.name))
  const loaded = await env.engine.snapshots(order.slice(0, MAX_PICK_BOARDS))
  const words = wordsOf(q)
  const hits: (LinkPick & { at: number; starts: boolean })[] = []
  const needle = q.trim().toLowerCase()
  for (const boardId of order) {
    const data = loaded.get(boardId)
    if (!data) continue
    const idx = indexFor(data)
    for (const id of idx.preorder) {
      const t = data.tasks[id]
      const title = t.title.toLowerCase()
      if ((boardId === holder.id && id === except) || !hasWords(words, title)) continue
      const col = statusCol(idx, id)
      hits.push({
        ref: linkRef(boardId, id),
        title: t.title,
        board: { id: boardId, name: data.board.name },
        list: col.name,
        kind: col.category,
        done: col.category === 'done',
        path: pathOf(data, t),
        at: Date.parse(t.activeAt ?? t.updatedAt),
        starts: !!needle && title.startsWith(needle),
      })
    }
  }
  // Typed: titles that start with it first, then by name. Nothing typed: the cards last worked on.
  hits.sort((a, b) => (needle ? Number(b.starts) - Number(a.starts) || a.title.localeCompare(b.title) : b.at - a.at))
  return { cards: hits.slice(0, MAX_PICKS).map(({ at: _at, starts: _starts, ...c }) => c) }
}

function pathOf(data: BoardData, t: Task): string[] {
  const out: string[] = []
  const seen = new Set([t.id])
  let p = t.parentId
  while (p && !seen.has(p) && data.tasks[p]) {
    out.unshift(data.tasks[p].title)
    seen.add(p)
    p = data.tasks[p].parentId
  }
  return out
}

// ── When what a link points at moves or goes ───────────────────────────────────

/**
 * Rewrites links on the boards around `near` (the ones that use, or used, a link field of its space; hidden values
 * too): `change` says what each link becomes (the same, another, or null: it goes), given the field's space and the
 * board holding it. Runs in a transaction of its own, after the change that made it necessary: the boards are locked
 * in id order with nothing else held, so it can't deadlock with a command or a move; cards and boards that changed
 * are bumped, and their open copies reload. Returns how many links were removed.
 *
 * Best effort by design: if it never ran, the links it would have fixed read "A card you can't open".
 */
export async function relink(
  env: { db: Db; engine: BoardEngine },
  near: BoardFact,
  change: (ref: string, at: { space: Space; holder: BoardFact }) => string | null,
): Promise<number> {
  const pairs = await linkFieldsNear(env.db, near, { removed: true })
  if (!pairs.length) return 0
  const boardIds = [...new Set(pairs.map((p) => p.boardId))].sort()
  const fieldIds = [...new Set(pairs.map((p) => p.fieldId))]
  const spaces = new Map(pairs.map((p) => [p.fieldId, spaceOf(p)]))
  let removed = 0
  const changed = new Set<string>()
  await env.db.transaction(async (tx) => {
    for (const id of boardIds) await tx.select({ id: boards.id }).from(boards).where(eq(boards.id, id)).for('update')
    const facts = await boardFacts(tx, boardIds)
    const rows = await tx
      .select({ boardId: tasks.boardId, id: tasks.id, custom: tasks.custom })
      .from(tasks)
      .where(and(inArray(tasks.boardId, boardIds), sql`jsonb_exists_any(${tasks.custom}, ${textArray(fieldIds)})`))
    const rewritten: { boardId: string; id: string; custom: object | null }[] = []
    for (const row of rows) {
      const holder = facts.get(row.boardId)
      if (!holder || !row.custom) continue
      let custom = row.custom
      for (const fieldId of fieldIds) {
        if (!(fieldId in custom)) continue
        const before = linksOf(custom[fieldId]).length
        custom = mapLinks(custom, new Set([fieldId]), (ref) => change(ref, { space: spaces.get(fieldId)!, holder })) ?? {}
        removed += before - linksOf(custom[fieldId]).length
      }
      if (custom === row.custom) continue
      changed.add(row.boardId)
      rewritten.push({ boardId: row.boardId, id: row.id, custom: Object.keys(custom).length ? custom : null })
    }
    await writeCustom(tx, rewritten, new Date())
    await env.engine.bump(tx, [...changed])
  })
  env.engine.reloaded([...changed])
  return removed
}

/** A board, as `relink` needs to know it (before it's deleted, say). */
export const factOf = async (tx: Db | Tx, boardId: string) => (await boardFacts(tx, [boardId])).get(boardId)

/**
 * After cards moved from one board to another (`ids`: old id to new): links to them follow, where the field that
 * holds the link may reach the board they went to; the others are removed. Returns how many were removed.
 */
export async function followMoved(env: { db: Db; engine: BoardEngine }, fromId: string, toId: string, ids: Map<string, string>): Promise<number> {
  const facts = await boardFacts(env.db, [fromId, toId])
  const from = facts.get(fromId)
  const to = facts.get(toId)
  if (!from || !to) return 0
  return relink(env, from, (ref, at) => {
    const link = parseRef(ref)
    if (!link || link.boardId !== fromId || !ids.has(link.taskId)) return ref
    return inSpace(at.space, at.holder, to) ? linkRef(toId, ids.get(link.taskId)!) : null
  })
}

/** After a board is deleted, or has left `was` (its space before): every link to its cards from the boards there goes. */
export const unlinkBoard = (env: { db: Db; engine: BoardEngine }, was: BoardFact) =>
  relink(env, was, (ref, at) => (parseRef(ref)?.boardId === was.id && at.holder.id !== was.id ? null : ref))

/**
 * How many links a board leaving its space would undo: links to its cards from the other boards there, and its own
 * cards' links to cards on those boards. (Counted from what's stored, hidden values included.)
 */
export async function linksAround(tx: Db | Tx, board: Pick<BoardRow, 'id' | 'workspaceId'>): Promise<number> {
  const boardId = board.id
  // (The space is the one it's in as `board` says: inside the move's own transaction, the row already says the new one.)
  const now = await factOf(tx, boardId)
  const fact = now && { ...now, workspaceId: board.workspaceId }
  if (!fact) return 0
  const pairs = await linkFieldsNear(tx, fact, { removed: true })
  if (!pairs.length) return 0
  const fieldIds = [...new Set(pairs.map((p) => p.fieldId))]
  const rows = await tx
    .select({ boardId: tasks.boardId, custom: tasks.custom })
    .from(tasks)
    .where(and(inArray(tasks.boardId, [...new Set(pairs.map((p) => p.boardId))]), sql`jsonb_exists_any(${tasks.custom}, ${textArray(fieldIds)})`))
  let n = 0
  for (const row of rows)
    for (const fieldId of fieldIds)
      for (const ref of linksOf(row.custom?.[fieldId])) {
        const to = parseRef(ref)
        if (to && (row.boardId === boardId) !== (to.boardId === boardId)) n++
      }
  return n
}
