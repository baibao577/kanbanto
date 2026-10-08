import type { BoardBackground } from '@kanbanto/model/colors'
import { newId } from '@kanbanto/model/ids'
import { emptyBoard, exampleData } from '@kanbanto/model/sample'
import { isTimeZone } from '@kanbanto/model/dates'
import { carryCustom, FIELD_LIMITS, linkRef, nameKey, valueText, type CustomValues } from '@kanbanto/model/fields'
import { indexFor } from '@kanbanto/model/indexer'
import { remapPreset } from '@kanbanto/model/prefs'
import { INBOX_CODE, isCode, numbersFor, suggestCode } from '@kanbanto/model/refs'
import { CLIENT_FIELD, CLIENT_NAME, clientsBoard, EXAMPLE_CLIENTS, starterBoard, type Starter } from '@kanbanto/model/starters'
import type { BoardData, Meta, Task } from '@kanbanto/model/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db, Tx } from '../db'
import { boardMembers, boardPresets, boards, comments, tasks, timeEntries, workspaces, type Visibility } from '../db/schema'
import { HttpError } from '../http'
import { accessOf, workspaceRole } from './access'
import { adoptFields, applyAdoption, clientLink, fitStarter, replaceBoardFields, type Library } from './fields'
import { codesTaken, lockSpace } from './numbering'
import { creations } from './records'
import { writeChanges } from './store'
import { adoptRules } from './rules'

/** Every record stamped as new: version 1, created now (templates are built from fixed sample data). */
function freshMeta(data: BoardData, now: string): BoardData {
  const m = <T extends Meta>(r: T): T => ({ ...r, createdAt: now, updatedAt: now, version: 1 })
  return {
    board: m(data.board),
    members: [],
    columns: data.columns.map(m),
    labels: data.labels.map(m),
    fields: [],
    tasks: Object.fromEntries(Object.entries(data.tasks).map(([id, t]) => [id, m(t)])),
  }
}

/**
 * Saves a new board with `ownerId` as its owner: in a workspace (shared with everyone in it), or in Personal.
 * `inbox`: as their Inbox, private to them.
 *
 * It gets its letters here (the ones it brings, a file's, when no board in that space has them; else ones made from
 * its name), and its cards their numbers: a card that brings its own keeps it, the rest are counted on in the order
 * the outline shows them (see model/refs.ts).
 */
export async function insertBoard(tx: Tx, data: BoardData, ownerId: string, workspaceId: string | null = null, opts: { inbox?: boolean } = {}) {
  const now = new Date()
  const visibility: Visibility = opts.inbox ? 'private' : workspaceId ? 'workspace' : 'invited'
  const space = workspaceId ? { workspaceId } : { ownerIds: [ownerId] }
  if (!opts.inbox) await lockSpace(tx, space)
  const taken = opts.inbox ? null : await codesTaken(tx, space)
  const brought = data.board.code
  const code = !taken ? INBOX_CODE : brought && isCode(brought) && !taken.has(brought) ? brought : suggestCode(data.board.name, taken)
  const { numbers, next } = numbersFor([...Object.values(data.tasks), ...Object.values(data.archived ?? {})], indexFor(data).preorder)
  // (A board that's made whole has no files yet, so no card of it has a cover, whatever its record says.)
  const numbered = ({ cover: _file, ...t }: Task): Task => (t.number === numbers.get(t.id) ? t : { ...t, number: numbers.get(t.id) })
  await tx.insert(boards).values({
    id: data.board.id,
    name: data.board.name,
    mode: data.board.mode,
    background: data.board.background ?? null,
    description: data.board.description ?? null,
    visibility,
    workspaceId,
    createdBy: ownerId,
    createdAt: now,
    updatedAt: now,
    version: data.board.version,
    ...(opts.inbox && { inboxOf: ownerId }),
    code,
    nextNumber: next,
  })
  await tx.insert(boardMembers).values({ boardId: data.board.id, userId: ownerId, role: 'owner', createdAt: now, updatedAt: now, version: 1 })
  // Cards that arrive finished (the example board, an imported one) were done by their last change, as far as we know.
  const doneLists = new Set(data.columns.filter((c) => c.category === 'done').map((c) => c.id))
  const tasks = Object.fromEntries(
    Object.values(data.tasks).map((t) => [t.id, numbered(doneLists.has(t.status) && !t.doneAt ? { ...t, doneAt: t.activeAt ?? t.updatedAt } : t)]),
  )
  const archived = data.archived && Object.fromEntries(Object.values(data.archived).map((t) => [t.id, numbered(t)]))
  await writeChanges(tx, data.board.id, creations({ ...data, tasks, ...(archived && { archived }) }), null)
}

export type Template = 'empty' | 'example'

export async function createBoard(
  db: Db,
  ownerId: string,
  opts: { name: string; background?: BoardBackground; template: Template; workspaceId?: string | null; description?: string },
): Promise<string> {
  const id = newId()
  const now = new Date().toISOString()
  const base = opts.template === 'example' ? freshMeta(exampleData(id, ownerId), now) : emptyBoard(id, opts.name, now)
  const data: BoardData = {
    ...base,
    board: {
      ...base.board,
      name: opts.name,
      ...(opts.background ? { background: opts.background } : {}),
      ...(opts.description?.trim() ? { description: opts.description.trim() } : {}),
    },
  }
  await db.transaction((tx) => insertBoard(tx, data, ownerId, opts.workspaceId ?? null))
  return id
}

const listed = (names: string[]) => names.map((n) => `“${n}”`).join(', ')

/**
 * Makes a board from a starter (see model/starters.ts): its lists, a few example cards, saved filters, and its
 * fields, which come from the library of where it's made (the workspace's, or the person's own). Fields the library
 * already has, by name and kind, are used as they are; the rest are added to it, which in a workspace only its admins
 * may do. When a field has to be added and can't be, nothing is made and the answer says why. A field the library
 * has archived stays off the board (`leftOut`).
 */
export async function createStarter(
  app: FastifyInstance,
  owner: { id: string; timeZone?: string | null },
  kind: Starter,
  opts: { name?: string; background?: BoardBackground; workspaceId?: string | null; description?: string },
): Promise<{ id: string; added: string[]; leftOut: string[]; clients?: { id: string; made: boolean } }> {
  const ownerId = owner.id
  const id = newId()
  const now = new Date()
  const workspaceId = opts.workspaceId ?? null
  const lib: Library = workspaceId ? { workspaceId } : { ownerId }
  const made = await app.db.transaction(async (tx) => {
    const canAdd = workspaceId ? (await workspaceRole(tx, workspaceId, ownerId)) === 'admin' : true
    // Who the examples are for: cards of the board the library's "Client" field links to. The first starter made
    // in a space finds no such field, and a board of clients is made with it; the ones after use that board.
    const known = await clientLink(tx, lib, CLIENT_NAME)
    const [there] = known?.boardId ? await tx.select().from(boards).where(eq(boards.id, known.boardId)) : []
    // (A board that's gone or put away, or that this person can't open, has no cards for them to link.)
    const usable = there && !there.archivedAt && !!(await accessOf(tx, there, ownerId)) ? there.id : undefined
    const clientsId = known ? usable : newId()
    const starter = starterBoard(kind, id, { ownerId, zone: isTimeZone(owner.timeZone) ? owner.timeZone : 'UTC', now, clientsBoardId: clientsId })
    const base = freshMeta(starter.data, now.toISOString())
    // (Every example client, this starter's first: the starters made after it find theirs there.)
    const newClients = known
      ? null
      : freshMeta(clientsBoard(clientsId!, [...new Set([...Object.values(starter.clients), ...EXAMPLE_CLIENTS])]), now.toISOString())
    const wanted = [...starter.data.fields, ...(newClients ? clientsBoard(clientsId!, []).fields : [])]
    const plan = await fitStarter(tx, lib, wanted, canAdd)
    if (plan.cant.length) {
      if (plan.why === 'room')
        throw new HttpError(
          400,
          `There’s no room for this starter’s fields (${listed(plan.cant)}): a library holds ${FIELD_LIMITS.perSpace}. Archive some that are no longer used first.`,
        )
      const [ws] = workspaceId ? await tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)) : []
      throw new HttpError(
        403,
        `This starter needs fields that ${ws?.name ?? 'this workspace'} doesn’t have yet: ${listed(plan.cant)}. Only the workspace’s admins can add fields: ask one to make the first board from this starter, or make yours in Personal.`,
      )
    }
    await applyAdoption(app, tx, lib, { add: plan.add, addOptions: new Map() })
    const fitted = (data: BoardData, more: (t: Task) => CustomValues | undefined = () => undefined) =>
      Object.fromEntries(
        Object.values(data.tasks).map((t) => {
          const { custom: held, ...rest } = t
          const custom = carryCustom({ ...held, ...more(t) }, plan.map)
          return [t.id, custom && Object.keys(custom).length ? { ...rest, custom } : rest]
        }),
      )
    // The clients: the new board's cards, or the cards of the one that's there, by name. A client that isn't there
    // (the examples were cleared away, or it's another kind of starter's) just isn't linked: nothing is added to a
    // board people already use.
    const refOf = new Map<string, string>()
    if (newClients) {
      await insertBoard(tx, { ...newClients, tasks: fitted(newClients) }, ownerId, workspaceId)
      await replaceBoardFields(
        tx,
        clientsId!,
        clientsBoard(clientsId!, []).fields.flatMap((f) =>
          plan.map.has(f.id) ? [{ id: plan.map.get(f.id)!.id, front: f.front, total: f.total }] : [],
        ),
      )
      for (const t of Object.values(newClients.tasks)) refOf.set(nameKey(t.title), linkRef(clientsId!, t.id))
    } else if (clientsId) {
      const cards = await tx
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(and(eq(tasks.boardId, clientsId), isNull(tasks.archivedAt)))
      for (const c of cards) if (!refOf.has(nameKey(c.title))) refOf.set(nameKey(c.title), linkRef(clientsId, c.id))
    }
    const client = (t: Task) => {
      const ref = starter.clients[t.id] && refOf.get(nameKey(starter.clients[t.id]))
      return ref ? { [CLIENT_FIELD]: [ref] } : undefined
    }
    const cards = fitted(base, client)
    const board = {
      ...base.board,
      ...(opts.name?.trim() && { name: opts.name.trim() }),
      ...(opts.background && { background: opts.background }),
      ...(opts.description?.trim() && { description: opts.description.trim() }),
    }
    await insertBoard(tx, { ...base, board, tasks: cards }, ownerId, workspaceId)
    await replaceBoardFields(
      tx,
      id,
      starter.data.fields.flatMap((f) => (plan.map.has(f.id) ? [{ id: plan.map.get(f.id)!.id, front: f.front, total: f.total }] : [])),
    )
    // Its saved filters, about the fields it ended up with. One that has nothing left to say isn't made.
    const presets = starter.presets.flatMap((p) => {
      const settings = remapPreset(p.settings, plan.map, 'drop')
      return Object.keys(settings.filter).length || settings.outline.sort ? [{ name: p.name, settings }] : []
    })
    if (presets.length)
      await tx.insert(boardPresets).values(
        // (A millisecond apart: they're listed in the order they were made.)
        presets.map((p, i) => ({ id: newId(), boardId: id, ...p, updatedBy: ownerId, createdAt: new Date(now.getTime() + i) })),
      )
    return { added: plan.add.map((f) => f.name), leftOut: plan.leftOut, ...(clientsId && { clients: { id: clientsId, made: !!newClients } }) }
  })
  return { id, ...made }
}

/**
 * Saves an imported board as a new board. Its people aren't accounts here, so assignments are dropped
 * (except to the person importing, if the file came from their own export). Its fields become fields of the
 * importer's own library: the ones it has (by name and type) are used, the rest are added while there's room.
 * `lost`: what couldn't come along.
 *
 * A board that comes from another app (Trello) brings two more things. `comments`: what was said on its cards, saved
 * as the importer's with the dates they were written, telling nobody. `fieldText`: a field that can't come along is
 * written on each card that had a value for it, under the description, since the file can't be imported again
 * later to get it back.
 *
 * One of Kanbanto's own files can bring its comments too, and `time`: what was logged on its cards, each entry
 * the importer's own or nobody's (`userId` null: the people of the board it came from aren't accounts here, and
 * hours mustn't land in someone's week by a name; who logged it is in the entry's note).
 */
export async function importBoard(
  app: FastifyInstance,
  ownerId: string,
  data: BoardData,
  from: {
    comments?: { taskId: string; body: string; at: string }[]
    time?: { taskId: string; userId: string | null; day: string; minutes: number; note: string; at: string }[]
    fieldText?: boolean
  } = {},
): Promise<{ id: string; lost: string[] }> {
  // (The id the file was read under: its cards' links to each other already name it. See `readBoardFile`.)
  const id = data.board.id
  // (The same goes for who set a reminder, which is who it goes to on an unassigned card: the importer now.)
  const mine = (t: Task): Task => {
    const { assigneeId, ...rest } = t
    const kept = assigneeId === ownerId ? t : rest
    return kept.reminders?.some((r) => r.by && r.by !== ownerId)
      ? { ...kept, reminders: kept.reminders.map((r) => (r.by ? { ...r, by: ownerId } : r)) }
      : kept
  }
  let touched: string[] = []
  const lost = await app.db.transaction(async (tx) => {
    const lib = { ownerId }
    const plan = await adoptFields(tx, lib, data.fields, true, id)
    touched = await applyAdoption(app, tx, lib, plan)
    const all = (tasks: Record<string, Task>) =>
      Object.fromEntries(
        Object.values(tasks).map((t) => {
          const { custom: held, ...kept } = mine(t)
          // (People in its person fields aren't accounts here either: only the importer is kept.)
          const custom = carryCustom(held, plan.map, { isMember: (u) => u === ownerId })
          const said = from.fieldText
            ? data.fields.flatMap((f) => (!plan.map.has(f.id) && held?.[f.id] !== undefined ? [`${f.name}: ${valueText(f, held[f.id])}`] : []))
            : []
          const rest = said.length
            ? { ...kept, description: [kept.description, said.join('\n')].filter(Boolean).join('\n\n').slice(0, 50_000) }
            : kept
          return [t.id, custom ? { ...rest, custom } : rest]
        }),
      )
    const tasks = all(data.tasks)
    const archived = data.archived && all(data.archived)
    await insertBoard(tx, { ...data, board: { ...data.board, id }, members: [], fields: [], tasks, ...(archived ? { archived } : {}) }, ownerId)
    await replaceBoardFields(
      tx,
      id,
      data.fields.flatMap((f) => (plan.map.has(f.id) ? [{ id: plan.map.get(f.id)!.id, front: f.front, total: f.total }] : [])),
    )
    // Its rules come with it, under new ids and by its fields' new ones (see boards/rules.ts).
    const people = new Set(data.fields.filter((f) => f.type === 'person').map((f) => f.id))
    await adoptRules(tx, id, data.rules, ownerId, plan.map, (f) => people.has(f))
    // (Many rows to a statement: a board can arrive with thousands of comments.)
    const said = (from.comments ?? []).filter((c) => tasks[c.taskId] || archived?.[c.taskId])
    for (let i = 0; i < said.length; i += 500)
      await tx
        .insert(comments)
        .values(
          said
            .slice(i, i + 500)
            .map((c) => ({ id: newId(), boardId: id, taskId: c.taskId, authorId: ownerId, body: c.body, createdAt: new Date(c.at) })),
        )
    const logged = (from.time ?? []).filter((e) => tasks[e.taskId] || archived?.[e.taskId])
    for (let i = 0; i < logged.length; i += 500)
      await tx.insert(timeEntries).values(
        logged.slice(i, i + 500).map((e) => ({
          id: newId(),
          boardId: id,
          taskId: e.taskId,
          userId: e.userId,
          day: e.day,
          minutes: e.minutes,
          note: e.note,
          createdAt: new Date(e.at),
          updatedAt: new Date(e.at),
        })),
      )
    return plan.lose
  })
  app.engine.reloaded(touched)
  return { id, lost }
}
