import type { BoardBackground } from '@kanbanto/model/colors'
import { newId } from '@kanbanto/model/ids'
import { emptyBoard, exampleData } from '@kanbanto/model/sample'
import { carryCustom, FIELD_LIMITS } from '@kanbanto/model/fields'
import { remapPreset } from '@kanbanto/model/prefs'
import { starterBoard, type Starter } from '@kanbanto/model/starters'
import type { BoardData, Meta, Task } from '@kanbanto/model/types'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db, Tx } from '../db'
import { boardMembers, boardPresets, boards, workspaces, type Visibility } from '../db/schema'
import { HttpError } from '../http'
import { workspaceRole } from './access'
import { adoptFields, applyAdoption, fitStarter, replaceBoardFields, type Library } from './fields'
import { creations } from './records'
import { writeChanges } from './store'

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
 */
export async function insertBoard(tx: Tx, data: BoardData, ownerId: string, workspaceId: string | null = null, opts: { inbox?: boolean } = {}) {
  const now = new Date()
  const visibility: Visibility = opts.inbox ? 'private' : workspaceId ? 'workspace' : 'invited'
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
  })
  await tx.insert(boardMembers).values({ boardId: data.board.id, userId: ownerId, role: 'owner', createdAt: now, updatedAt: now, version: 1 })
  // Cards that arrive finished (the example board, an imported one) were done by their last change, as far as we know.
  const doneLists = new Set(data.columns.filter((c) => c.category === 'done').map((c) => c.id))
  const tasks = Object.fromEntries(
    Object.values(data.tasks).map((t) => [t.id, doneLists.has(t.status) && !t.doneAt ? { ...t, doneAt: t.activeAt ?? t.updatedAt } : t]),
  )
  await writeChanges(tx, data.board.id, creations({ ...data, tasks }), null)
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
  ownerId: string,
  kind: Starter,
  opts: { name?: string; background?: BoardBackground; workspaceId?: string | null; description?: string },
): Promise<{ id: string; added: string[]; leftOut: string[] }> {
  const id = newId()
  const now = new Date()
  const starter = starterBoard(kind, id)
  const base = freshMeta(starter.data, now.toISOString())
  const workspaceId = opts.workspaceId ?? null
  const lib: Library = workspaceId ? { workspaceId } : { ownerId }
  const made = await app.db.transaction(async (tx) => {
    const canAdd = workspaceId ? (await workspaceRole(tx, workspaceId, ownerId)) === 'admin' : true
    const plan = await fitStarter(tx, lib, starter.data.fields, canAdd)
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
    const tasks = Object.fromEntries(
      Object.values(base.tasks).map((t) => {
        const { custom: held, ...rest } = t
        const custom = carryCustom(held, plan.map)
        return [t.id, custom ? { ...rest, custom } : rest]
      }),
    )
    const board = {
      ...base.board,
      ...(opts.name?.trim() && { name: opts.name.trim() }),
      ...(opts.background && { background: opts.background }),
      ...(opts.description?.trim() && { description: opts.description.trim() }),
    }
    await insertBoard(tx, { ...base, board, tasks }, ownerId, workspaceId)
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
    return { added: plan.add.map((f) => f.name), leftOut: plan.leftOut }
  })
  return { id, ...made }
}

/**
 * Saves an imported board as a new board. Its people aren't accounts here, so assignments are dropped
 * (except to the person importing, if the file came from their own export). Its fields become fields of the
 * importer's own library: the ones it has (by name and type) are used, the rest are added while there's room.
 * `lost`: what couldn't come along.
 */
export async function importBoard(app: FastifyInstance, ownerId: string, data: BoardData): Promise<{ id: string; lost: string[] }> {
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
          const { custom: held, ...rest } = mine(t)
          // (People in its person fields aren't accounts here either: only the importer is kept.)
          const custom = carryCustom(held, plan.map, { isMember: (u) => u === ownerId })
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
    return plan.lose
  })
  app.engine.reloaded(touched)
  return { id, lost }
}
