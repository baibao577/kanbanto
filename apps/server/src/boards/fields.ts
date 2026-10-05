import type { ActivityItem } from '@kanbanto/model/activity'
import type { BoardFieldsView, FieldMerge, FieldUsage, FieldView } from '@kanbanto/model/api'
import { LABEL_COLOR_CYCLE, type ColorName } from '@kanbanto/model/colors'
import {
  carryCustom,
  FIELD_LIMITS,
  mergeCustom,
  mergeKeepsOne,
  mergeOptions,
  mergeProblem,
  nameKey,
  nameProblem,
  parseRef,
  planAdoption,
  planStarter,
  type Adoption,
  type BoardField,
  type FieldDef,
  type FieldMap,
  type FieldOption,
  type FieldSettings,
  type FieldType,
  type LibraryField,
  type LinkScope,
  type StarterPlan,
  type TextFormat,
} from '@kanbanto/model/fields'
import { newId } from '@kanbanto/model/ids'
import { remapPreset, type PresetSettings } from '@kanbanto/model/prefs'
import { PresetSettingsSchema } from '@kanbanto/model/schema'
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db, Tx } from '../db'
import { boardActivity, boardFieldRows, boardPresets, boards, libraryFields, tasks, users, workspaces } from '../db/schema'
import { dbErrorCode } from '../errors'
import { HttpError } from '../http'
import { workspaceRole, type Access, type BoardRow } from './access'
import { canLinkTo, linksAround } from './links'
import { fieldFromRow } from './records'
import { boardPeople, loadBoard } from './store'

/**
 * Custom fields on the server (the rules and the types are in model/fields.ts).
 *
 * A field lives in one library: a workspace's, managed by its admins, or a person's own, for their Personal boards.
 * A board's owners pick which of them the board uses. None of this goes through board commands: the definitions are
 * put into a board when it's loaded, so every change here raises the change counter of the boards that show the
 * field (inside the same transaction) and then has their open copies fetch the board again.
 */
export type Library = { workspaceId: string } | { ownerId: string }

type FieldRow = typeof libraryFields.$inferSelect

const inLibrary = (lib: Library) => ('workspaceId' in lib ? eq(libraryFields.workspaceId, lib.workspaceId) : eq(libraryFields.ownerId, lib.ownerId))
const isIn = (lib: Library, f: FieldRow) => ('workspaceId' in lib ? f.workspaceId === lib.workspaceId : f.ownerId === lib.ownerId)

/** The library a board's fields come from, for `userId` (one of its owners): its workspace's, or their own. */
export const libraryOf = (board: BoardRow, userId: string): Library => (board.workspaceId ? { workspaceId: board.workspaceId } : { ownerId: userId })

const textArray = (xs: string[]) =>
  sql`array[${sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  )}]::text[]`

/** One change to a library at a time, so two can't both squeeze past a limit or take the same name. */
async function lockLibrary(tx: Tx, lib: Library) {
  if ('workspaceId' in lib) await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, lib.workspaceId)).for('update')
  else await tx.select({ id: users.id }).from(users).where(eq(users.id, lib.ownerId)).for('update')
}

const rowsOf = (tx: Db | Tx, lib: Library) =>
  tx.select().from(libraryFields).where(inLibrary(lib)).orderBy(asc(libraryFields.createdAt), asc(libraryFields.id))

/** The boards that have a row for a field: the ones that show it, or (`all`) also the ones it was taken off. */
async function boardsWith(tx: Db | Tx, fieldId: string, all = false) {
  const rows = await tx
    .select({ id: boardFieldRows.boardId })
    .from(boardFieldRows)
    .where(and(eq(boardFieldRows.fieldId, fieldId), all ? undefined : isNull(boardFieldRows.removedAt)))
  return rows.map((r) => r.id)
}

/** A name two fields in one library were given at the same moment: the database says no. */
async function unique<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (dbErrorCode(e) === '23505') throw new HttpError(409, 'There’s already a field with that name.')
    throw e
  }
}

function cleanName(name: string) {
  const problem = nameProblem(name)
  if (problem) throw new HttpError(400, problem)
  return name.trim().normalize('NFC')
}

function nameFree(all: FieldRow[], name: string, except?: string) {
  const hit = all.find((r) => r.id !== except && nameKey(r.name) === nameKey(name))
  if (!hit) return
  throw new HttpError(
    409,
    hit.archivedAt
      ? `There’s an archived field called “${hit.name}”. Restore it, or pick another name.`
      : `There’s already a field called “${hit.name}”.`,
  )
}

export interface OptionInput {
  id?: string
  name: string
  color: ColorName
  archived?: boolean
}
export interface FieldInput {
  name?: string
  format?: TextFormat
  unit?: string
  decimals?: number | null
  sum?: boolean
  /** The whole list, in order. An option left out is deleted for good, which is only for archived ones. */
  options?: OptionInput[]
  /**
   * The options by name, in order, for whoever doesn't hold their ids (an assistant). A name that's new is added, one
   * the field has is kept (and back in use, if it was archived), and an option left out is archived, never deleted:
   * the cards that have it keep it. Read against the field as it is once its library is locked.
   */
  optionNames?: string[]
  /** One option renamed, by its name now. */
  renameOption?: { from: string; to: string }
  /** A card link: where its cards come from, the board (for `linkTo: 'board'`), one card or several, its name on the other card. */
  linkTo?: LinkScope
  board?: string
  /** (Also for a person field: one person or several.) */
  many?: boolean
  back?: string
  archived?: boolean
}

function tidyOptions(before: FieldOption[], asked: OptionInput[]): { options: FieldOption[]; removed: FieldOption[] } {
  const known = new Set(before.map((o) => o.id))
  const kept = new Set<string>()
  const names = new Set<string>()
  const options = asked.map((a): FieldOption => {
    const problem = nameProblem(a.name, 'option')
    if (problem) throw new HttpError(400, problem)
    const name = a.name.trim().normalize('NFC')
    if (names.has(nameKey(name))) throw new HttpError(400, `There are two options called “${name}”.`)
    names.add(nameKey(name))
    const id = a.id && known.has(a.id) && !kept.has(a.id) ? a.id : newId()
    kept.add(id)
    return { id, name, color: a.color, ...(a.archived && { archived: true }) }
  })
  const removed = before.filter((o) => !kept.has(o.id))
  const early = removed.find((o) => !o.archived)
  if (early) throw new HttpError(400, `Archive “${early.name}” first: the cards that have it keep it until it’s deleted.`)
  if (options.filter((o) => !o.archived).length > FIELD_LIMITS.options)
    throw new HttpError(400, `A field can have ${FIELD_LIMITS.options} options at most.`)
  if (options.length > FIELD_LIMITS.options * 2) throw new HttpError(400, 'Delete some archived options first.')
  return { options, removed }
}

/** `optionNames` and `renameOption` as the whole list of options they mean, for a field that has `before`. */
function saidOptions(type: FieldType, before: FieldOption[], input: FieldInput): OptionInput[] | undefined {
  if (!input.optionNames && !input.renameOption) return input.options
  if (type !== 'choice') throw new HttpError(400, 'Only a choice has options.')
  let list: OptionInput[] = before.map(({ id, name, color, archived }) => ({ id, name, color, ...(archived && { archived }) }))
  if (input.optionNames) {
    const listed = new Set<string>()
    const named = input.optionNames.map((raw, i): OptionInput => {
      const hit = before.find((o) => nameKey(o.name) === nameKey(raw))
      if (!hit) return { name: raw, color: LABEL_COLOR_CYCLE[(before.length + i) % LABEL_COLOR_CYCLE.length] }
      listed.add(hit.id)
      return { id: hit.id, name: hit.name, color: hit.color }
    })
    list = [...named, ...before.filter((o) => !listed.has(o.id)).map((o) => ({ id: o.id, name: o.name, color: o.color, archived: true }))]
  }
  if (input.renameOption) {
    const { from, to } = input.renameOption
    const hit = list.find((o) => o.id === from) ?? list.find((o) => nameKey(o.name) === nameKey(from))
    if (!hit) throw new HttpError(400, `There’s no option “${from}”. The options are: ${list.map((o) => o.name).join(', ') || 'none yet'}.`)
    list = list.map((o) => (o === hit ? { ...o, name: to } : o))
  }
  return list
}

/** What a field's type lets you set, after a change: only the settings that mean something for the type are kept. */
function settingsFor(type: FieldType, before: FieldSettings, input: FieldInput): { settings: FieldSettings; removed: FieldOption[] } {
  if (type === 'text') {
    const format = input.format ?? before.format
    return { settings: format && format !== 'plain' ? { format } : {}, removed: [] }
  }
  if (type === 'number') {
    const unit = (input.unit ?? before.unit ?? '').trim()
    if (unit.length > FIELD_LIMITS.unit) throw new HttpError(400, `A unit is short (${FIELD_LIMITS.unit} characters at most).`)
    const decimals = input.decimals === undefined ? before.decimals : (input.decimals ?? undefined)
    const sum = input.sum ?? before.sum
    return { settings: { ...(unit && { unit }), ...(decimals !== undefined && { decimals }), ...(sum && { sum }) }, removed: [] }
  }
  if (type === 'choice') {
    if (!input.options) return { settings: { options: before.options ?? [] }, removed: [] }
    const { options, removed } = tidyOptions(before.options ?? [], input.options)
    return { settings: { options }, removed }
  }
  if (type === 'link') {
    const linkTo = input.linkTo ?? before.linkTo ?? 'space'
    const board = linkTo === 'board' ? (input.board ?? before.board) : undefined
    if (linkTo === 'board' && !board) throw new HttpError(400, 'Choose the board its cards come from.')
    const many = input.many ?? before.many
    const back = (input.back ?? before.back ?? '').trim().normalize('NFC')
    if (back.length > FIELD_LIMITS.name) throw new HttpError(400, `That name is too long (${FIELD_LIMITS.name} characters at most).`)
    return { settings: { linkTo, ...(board && { board }), ...(many && { many }), ...(back && { back }) }, removed: [] }
  }
  if (type === 'person') return { settings: (input.many ?? before.many) ? { many: true } : {}, removed: [] }
  return { settings: {}, removed: [] }
}

/**
 * A card link's board has to be one of the field's own space, and one the person setting it can open. Only checked
 * when it's chosen: a board that goes afterwards leaves the field as it was, with nothing to pick from.
 */
async function linkBoardOk(tx: Tx, lib: Library, settings: FieldSettings, before: FieldSettings, me: string | undefined) {
  if (!settings.board || settings.board === before.board) return
  if (!me || !(await canLinkTo(tx, lib, settings.board, me)))
    throw new HttpError(400, 'workspaceId' in lib ? 'Pick one of this workspace’s boards that you can open.' : 'Pick one of your own boards.')
}

/** A library's fields, oldest first, each with how many boards use it. */
export async function listLibrary(db: Db | Tx, lib: Library): Promise<FieldView[]> {
  const rows = await rowsOf(db, lib)
  if (!rows.length) return []
  const used = await db
    .select({ id: boardFieldRows.fieldId, n: sql<number>`count(*)::int` })
    .from(boardFieldRows)
    .where(
      and(
        inArray(
          boardFieldRows.fieldId,
          rows.map((r) => r.id),
        ),
        isNull(boardFieldRows.removedAt),
      ),
    )
    .groupBy(boardFieldRows.fieldId)
  const boards = new Map(used.map((u) => [u.id, u.n]))
  return rows.map((r) => ({ ...fieldFromRow(r), archivedAt: r.archivedAt?.toISOString() ?? null, boards: boards.get(r.id) ?? 0 }))
}

export async function createField(
  app: FastifyInstance,
  lib: Library,
  input: FieldInput & { name: string; type: FieldType },
  me?: string,
): Promise<string> {
  const name = cleanName(input.name)
  const { settings } = settingsFor(input.type, {}, { ...input, options: saidOptions(input.type, [], input) })
  return unique(() =>
    app.db.transaction(async (tx) => {
      await lockLibrary(tx, lib)
      await linkBoardOk(tx, lib, settings, {}, me)
      const all = await rowsOf(tx, lib)
      if (all.filter((r) => !r.archivedAt).length >= FIELD_LIMITS.perSpace)
        throw new HttpError(400, `There can be ${FIELD_LIMITS.perSpace} fields at most. Archive one that’s no longer used.`)
      nameFree(all, name)
      const id = newId()
      await tx.insert(libraryFields).values({
        id,
        workspaceId: 'workspaceId' in lib ? lib.workspaceId : null,
        ownerId: 'ownerId' in lib ? lib.ownerId : null,
        name,
        type: input.type,
        settings,
      })
      return id
    }),
  )
}

/**
 * Changes a field: its name, what its type lets you set, its options, or whether it's archived. Every board that
 * shows it gets the change. An option that's taken out (archived ones only) is cleared from the cards that had it.
 */
export async function updateField(app: FastifyInstance, lib: Library, fieldId: string, input: FieldInput, me?: string) {
  let showing: string[] = []
  await unique(() =>
    app.db.transaction(async (tx) => {
      await lockLibrary(tx, lib)
      const all = await rowsOf(tx, lib)
      const row = all.find((r) => r.id === fieldId)
      if (!row) throw new HttpError(404, 'That field no longer exists.')
      const set: Partial<FieldRow> = { updatedAt: new Date() }
      if (input.name !== undefined) {
        set.name = cleanName(input.name)
        nameFree(all, set.name, fieldId)
      }
      const { settings, removed } = settingsFor(row.type, row.settings, {
        ...input,
        options: saidOptions(row.type, row.settings.options ?? [], input),
      })
      await linkBoardOk(tx, lib, settings, row.settings, me)
      set.settings = settings
      if (input.archived !== undefined && input.archived !== !!row.archivedAt) {
        if (input.archived && all.filter((r) => r.archivedAt).length >= FIELD_LIMITS.archived)
          throw new HttpError(400, 'That’s a lot of archived fields. Delete some for good first.')
        if (!input.archived && all.filter((r) => !r.archivedAt).length >= FIELD_LIMITS.perSpace)
          throw new HttpError(400, `There can be ${FIELD_LIMITS.perSpace} fields at most. Archive one that’s no longer used.`)
        set.archivedAt = input.archived ? new Date() : null
      }
      showing = await boardsWith(tx, fieldId)
      await app.engine.bump(tx, showing)
      if (removed.length)
        await tx
          .update(tasks)
          .set({ custom: sql`nullif(${tasks.custom} - ${fieldId}::text, '{}'::jsonb)`, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
          .where(
            and(
              inArray(tasks.boardId, await boardsWith(tx, fieldId, true)),
              sql`jsonb_exists_any(${tasks.custom} -> ${fieldId}::text, ${textArray(removed.map((o) => o.id))})`,
            ),
          )
      await tx.update(libraryFields).set(set).where(eq(libraryFields.id, fieldId))
    }),
  )
  app.engine.reloaded(showing)
}

async function fieldIn(tx: Db | Tx, lib: Library, fieldId: string) {
  const [row] = await tx
    .select()
    .from(libraryFields)
    .where(and(eq(libraryFields.id, fieldId), inLibrary(lib)))
  if (!row) throw new HttpError(404, 'That field no longer exists.')
  return row
}

/** What deleting a field for good would take away: the boards that use it now, and the cards that hold a value. */
export async function fieldUsage(db: Db, lib: Library, fieldId: string): Promise<FieldUsage> {
  await fieldIn(db, lib, fieldId)
  const held = await boardsWith(db, fieldId, true)
  const [{ cards }] = held.length
    ? await db
        .select({ cards: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(inArray(tasks.boardId, held), sql`jsonb_exists(${tasks.custom}, ${fieldId}::text)`))
    : [{ cards: 0 }]
  return { boards: (await boardsWith(db, fieldId)).length, cards }
}

/**
 * Deletes an archived field for good: its values are taken out of every card that held one, then the field goes.
 * An archived field is shown on no board, so no board in memory (or in anyone's undo history) holds those values:
 * nothing can bring them back.
 */
export async function deleteField(app: FastifyInstance, lib: Library, fieldId: string) {
  await app.db.transaction(async (tx) => {
    await lockLibrary(tx, lib)
    const row = await fieldIn(tx, lib, fieldId)
    if (!row.archivedAt) throw new HttpError(400, 'Archive it first: deleting for good is for fields nobody uses any more.')
    const held = await boardsWith(tx, fieldId, true)
    if (held.length)
      await tx
        .update(tasks)
        .set({ custom: sql`nullif(${tasks.custom} - ${fieldId}::text, '{}'::jsonb)` })
        .where(and(inArray(tasks.boardId, held), sql`jsonb_exists(${tasks.custom}, ${fieldId}::text)`))
    await tx.delete(libraryFields).where(eq(libraryFields.id, fieldId))
  })
}

const defOf = (r: FieldRow): LibraryField => ({ ...fieldFromRow(r), ...(r.archivedAt && { archived: true }) })

/** The two fields of a merge, from one library: 404 when either isn't there (any more). */
async function mergePair(tx: Db | Tx, lib: Library, fromId: string, intoId: string, lock = false) {
  const q = tx
    .select()
    .from(libraryFields)
    .where(and(inArray(libraryFields.id, [fromId, intoId]), inLibrary(lib)))
    .orderBy(asc(libraryFields.id))
  const rows = await (lock ? q.for('update') : q)
  const from = rows.find((r) => r.id === fromId)
  const into = rows.find((r) => r.id === intoId)
  if (!from || !into) throw new HttpError(404, 'That field no longer exists.')
  return { from: defOf(from), into: defOf(into) }
}

/** The option ids cards hold for a choice field, on the boards that have (or had) it. */
async function optionsHeld(tx: Db | Tx, fieldId: string, boardIds: string[]): Promise<Set<string>> {
  if (!boardIds.length) return new Set()
  const rows = await tx
    .selectDistinct({ id: sql<string>`jsonb_array_elements_text(${tasks.custom} -> ${fieldId}::text)` })
    .from(tasks)
    .where(and(inArray(tasks.boardId, boardIds), sql`jsonb_typeof(${tasks.custom} -> ${fieldId}::text) = 'array'`))
  return new Set(rows.map((r) => r.id))
}

/** What merging `fromId` into `intoId` would do, in numbers (see `mergeFields`). Nothing is changed. */
export async function mergePreview(db: Db, lib: Library, fromId: string, intoId: string): Promise<FieldMerge> {
  const { from, into } = await mergePair(db, lib, fromId, intoId)
  const held = await boardsWith(db, fromId, true)
  const has = (id: string) => sql`jsonb_exists(${tasks.custom}, ${id}::text)`
  const [n] = held.length
    ? await db
        .select({
          cards: sql<number>`count(*)::int`,
          boards: sql<number>`count(distinct ${tasks.boardId})::int`,
          both: sql<number>`count(*) filter (where ${has(intoId)})::int`,
        })
        .from(tasks)
        .where(and(inArray(tasks.boardId, held), has(fromId)))
    : [{ cards: 0, boards: 0, both: 0 }]
  const problem = mergeProblem(from, into)
  const options =
    from.type === 'choice' && !problem
      ? mergeOptions(from, into, newId, await optionsHeld(db, fromId, held))
          .add.filter((o) => !o.archived)
          .map((o) => o.name)
      : []
  const differs = (['unit', 'decimals', 'sum', 'format', 'many'] as const).filter((k) => (from[k] ?? false) !== (into[k] ?? false))
  return { cards: n.cards, boards: n.boards, both: mergeKeepsOne(into) ? n.both : 0, options, differs, ...(problem && { problem }) }
}

/**
 * Merges one field into another of the same library and kind: every card's value for `fromId` becomes its value for
 * `intoId` (see `mergeCustom` for a card that has both), boards that used `fromId` use `intoId` in its place, saved
 * filters follow, and `fromId` is gone. It can't be undone.
 *
 * One transaction, with locks taken in the order every other change here takes them: the library, the two fields,
 * then the boards (in id order, each with its change counter raised). Only then is it read which boards have which
 * of the two fields: a board that changed its fields a moment ago is seen as it is now.
 */
export async function mergeFields(app: FastifyInstance, lib: Library, fromId: string, intoId: string, me: { id: string }, via?: string) {
  let touched: string[] = []
  const cards = await app.db.transaction(async (tx) => {
    await lockLibrary(tx, lib)
    const { from, into } = await mergePair(tx, lib, fromId, intoId, true)
    const problem = mergeProblem(from, into)
    if (problem) throw new HttpError(400, problem)
    const both = [fromId, intoId]
    const before = await tx.selectDistinct({ id: boardFieldRows.boardId }).from(boardFieldRows).where(inArray(boardFieldRows.fieldId, both))
    touched = before.map((r) => r.id).sort()
    await app.engine.bump(tx, touched)
    const rows = touched.length
      ? await tx
          .select()
          .from(boardFieldRows)
          .where(and(inArray(boardFieldRows.boardId, touched), inArray(boardFieldRows.fieldId, both)))
      : []
    const rowOf = (boardId: string, fieldId: string) => rows.find((r) => r.boardId === boardId && r.fieldId === fieldId)
    const using = touched.filter((b) => rowOf(b, fromId))

    // A board can show fields of two libraries (a Personal board with two owners): it mustn't end with two of one name.
    const clash = using.length
      ? await tx
          .select({ board: boards.name })
          .from(boardFieldRows)
          .innerJoin(libraryFields, eq(libraryFields.id, boardFieldRows.fieldId))
          .innerJoin(boards, eq(boards.id, boardFieldRows.boardId))
          .where(
            and(
              inArray(boardFieldRows.boardId, using),
              isNull(boardFieldRows.removedAt),
              isNull(libraryFields.archivedAt),
              sql`${libraryFields.id} not in (${fromId}::uuid, ${intoId}::uuid)`,
              sql`lower(trim(${libraryFields.name})) = ${nameKey(into.name)}`,
            ),
          )
          .limit(1)
      : []
    if (clash.length)
      throw new HttpError(
        409,
        `The board “${clash[0].board}” already has another field called “${into.name}”. Take one of them off that board first.`,
      )

    const options = from.type === 'choice' ? mergeOptions(from, into, newId, await optionsHeld(tx, fromId, using)) : undefined
    if (options?.add.length) {
      const [row] = await tx.select({ settings: libraryFields.settings }).from(libraryFields).where(eq(libraryFields.id, intoId))
      await tx
        .update(libraryFields)
        .set({ settings: { ...row.settings, options: [...(row.settings.options ?? []), ...options.add] }, updatedAt: new Date() })
        .where(eq(libraryFields.id, intoId))
    }
    const totals = into.type === 'number' && !!into.sum
    const map: FieldMap = new Map([[fromId, { id: intoId, ...(options && { options: options.map }) }]])
    const now = new Date()
    let moved = 0
    for (const boardId of using) {
      const was = rowOf(boardId, fromId)!
      const kept = rowOf(boardId, intoId)
      // Where a card has both, the one its board shows stays: the kept field's, unless only the other is shown here.
      const fromShown = !was.removedAt && !(kept && !kept.removedAt)
      const held = await tx
        .select({ id: tasks.id, custom: tasks.custom })
        .from(tasks)
        .where(and(eq(tasks.boardId, boardId), sql`jsonb_exists(${tasks.custom}, ${fromId}::text)`))
      for (const t of held) {
        const custom = mergeCustom(t.custom ?? undefined, from, into, { options: options?.map, fromShown }) ?? null
        await tx
          .update(tasks)
          .set({ custom, updatedAt: now, version: sql`${tasks.version} + 1` })
          .where(and(eq(tasks.boardId, boardId), eq(tasks.id, t.id)))
      }
      moved += held.length
      // The board's own list of fields: the kept field takes the other's place, or stays where it was shown.
      if (!kept)
        await tx
          .update(boardFieldRows)
          .set({ fieldId: intoId, total: was.total && totals })
          .where(and(eq(boardFieldRows.boardId, boardId), eq(boardFieldRows.fieldId, fromId)))
      else {
        await tx.delete(boardFieldRows).where(and(eq(boardFieldRows.boardId, boardId), eq(boardFieldRows.fieldId, fromId)))
        if (kept.removedAt && !was.removedAt)
          await tx
            .update(boardFieldRows)
            .set({ position: was.position, front: was.front, total: was.total && totals, removedAt: null })
            .where(and(eq(boardFieldRows.boardId, boardId), eq(boardFieldRows.fieldId, intoId)))
      }
      // Saved filters that named the field that goes name the kept one.
      for (const p of await tx.select().from(boardPresets).where(eq(boardPresets.boardId, boardId))) {
        const read = PresetSettingsSchema.safeParse(p.settings)
        if (!read.success) continue
        const next = remapPreset(read.data as PresetSettings, map, 'keep')
        if (JSON.stringify(next) !== JSON.stringify(read.data)) await tx.update(boardPresets).set({ settings: next }).where(eq(boardPresets.id, p.id))
      }
      if (!was.removedAt)
        await tx.insert(boardActivity).values({
          id: newId(),
          boardId,
          actorId: me.id,
          command: 'board.fields',
          items: [{ text: `merged the field “${from.name}” into “${into.name}”` }],
          via: via ?? null,
        })
    }
    await tx.delete(libraryFields).where(eq(libraryFields.id, fromId))
    return moved
  })
  app.engine.reloaded(touched)
  return { cards }
}

/** A board's fields, and for its owners what they could add to them. */
export async function boardFieldsView(app: FastifyInstance, board: BoardRow, access: Access, userId: string | undefined): Promise<BoardFieldsView> {
  const { data } = await app.engine.snapshot(board.id)
  const owner = access.role === 'owner' && !!userId
  const used = new Set(data.fields.map((f) => f.id))
  const available = owner
    ? (await rowsOf(app.db, libraryOf(board, userId))).filter((r) => !r.archivedAt && !used.has(r.id)).map((r) => fieldFromRow(r))
    : []
  const [workspace] =
    board.workspaceId && access.via !== 'public'
      ? await app.db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, board.workspaceId))
      : []
  const canManage = board.workspaceId ? (await workspaceRole(app.db, board.workspaceId, userId)) === 'admin' : owner
  return { fields: data.fields, available, canPick: owner && !board.archivedAt, workspace: workspace ?? null, canManage }
}

/**
 * Sets which fields a board uses, in order, which show on the card front, and which numbers are totalled under each
 * list's name (its owners). A field taken off keeps
 * its row, marked removed: its values stay on the cards, unseen, until it's added again or deleted for good. Fields
 * come from the board's library: its workspace's, or for a Personal board the owner's own (ones another owner put
 * there stay).
 */
export async function setBoardFields(app: FastifyInstance, board: BoardRow, me: { id: string }, list: BoardPick[], via?: string): Promise<void> {
  await app.db.transaction(async (tx) => {
    await holdFields(
      tx,
      list.map((x) => x.id),
    )
    await app.engine.bump(tx, [board.id])
    await writeBoardFields(tx, board, me, list, via)
  })
  app.engine.reloaded([board.id])
}

/**
 * One field put on a board (at the end, or its "on the card" and "total" switches changed when it's there already),
 * or taken off it. For whoever doesn't hold the board's whole list of fields (an assistant): the list is read here,
 * once the board is locked, so a field someone else added a moment ago isn't taken off by leaving it out.
 */
export async function editBoardFields(
  app: FastifyInstance,
  board: BoardRow,
  me: { id: string },
  edit: { id: string; on: boolean; front?: boolean; total?: boolean },
  via?: string,
): Promise<void> {
  await app.db.transaction(async (tx) => {
    await holdFields(tx, [edit.id])
    await app.engine.bump(tx, [board.id])
    const rows = await tx
      .select({ id: boardFieldRows.fieldId, front: boardFieldRows.front, total: boardFieldRows.total })
      .from(boardFieldRows)
      .innerJoin(libraryFields, eq(libraryFields.id, boardFieldRows.fieldId))
      .where(and(eq(boardFieldRows.boardId, board.id), isNull(boardFieldRows.removedAt), isNull(libraryFields.archivedAt)))
      .orderBy(asc(boardFieldRows.position))
    const there = rows.find((r) => r.id === edit.id)
    if (!edit.on && !there) throw new HttpError(400, 'That field isn’t on this board.')
    const list: BoardPick[] = !edit.on
      ? rows.filter((r) => r.id !== edit.id)
      : there
        ? rows.map((r) => (r.id === edit.id ? { ...r, front: edit.front ?? r.front, total: edit.total ?? r.total } : r))
        : [...rows, { id: edit.id, front: !!edit.front, total: !!edit.total }]
    await writeBoardFields(tx, board, me, list, via)
  })
  app.engine.reloaded([board.id])
}

type BoardPick = { id: string; front?: boolean; total?: boolean }

/** The fields asked for are held as they are until the transaction is done: a merge of one of them waits, or goes first. */
async function holdFields(tx: Tx, ids: string[]) {
  if (ids.length)
    await tx
      .select({ id: libraryFields.id })
      .from(libraryFields)
      .where(inArray(libraryFields.id, ids))
      .orderBy(asc(libraryFields.id))
      .for('key share')
}

/** Writes a board's list of fields (see `setBoardFields`), inside a transaction that has locked the board. */
async function writeBoardFields(tx: Tx, board: BoardRow, me: { id: string }, list: BoardPick[], via?: string): Promise<void> {
  if (list.length > FIELD_LIMITS.perBoard) throw new HttpError(400, `A board can use ${FIELD_LIMITS.perBoard} fields at most.`)
  if (list.filter((x) => x.front).length > FIELD_LIMITS.front)
    throw new HttpError(400, `Up to ${FIELD_LIMITS.front} fields can show on the card front.`)
  if (list.filter((x) => x.total).length > FIELD_LIMITS.totals)
    throw new HttpError(400, `Up to ${FIELD_LIMITS.totals} fields can have a total in lists.`)
  if (new Set(list.map((x) => x.id)).size !== list.length) throw new HttpError(400, 'A field can only be on a board once.')
  const lib = libraryOf(board, me.id)
  const rows = await tx
    .select({ removedAt: boardFieldRows.removedAt, f: libraryFields })
    .from(boardFieldRows)
    .innerJoin(libraryFields, eq(libraryFields.id, boardFieldRows.fieldId))
    .where(eq(boardFieldRows.boardId, board.id))
  // (An archived field's row is left as it is: restoring the field puts it back on the board.)
  const shown = new Map(rows.filter((r) => !r.removedAt && !r.f.archivedAt).map((r) => [r.f.id, r.f]))
  const asked = list.length
    ? await tx
        .select()
        .from(libraryFields)
        .where(
          inArray(
            libraryFields.id,
            list.map((x) => x.id),
          ),
        )
    : []
  const byId = new Map(asked.map((f) => [f.id, f]))
  const names = new Set<string>()
  for (const x of list) {
    const f = byId.get(x.id)
    if (!f || f.archivedAt || !(isIn(lib, f) || shown.has(f.id))) throw new HttpError(400, 'One of those fields is no longer available.')
    if (names.has(nameKey(f.name))) throw new HttpError(400, `This board already has a field called “${f.name}”.`)
    names.add(nameKey(f.name))
    if (x.total && !(f.type === 'number' && f.settings.sum)) throw new HttpError(400, `“${f.name}” isn’t a number that adds up, so it has no total.`)
  }
  for (const [position, x] of list.entries())
    await tx
      .insert(boardFieldRows)
      .values({ boardId: board.id, fieldId: x.id, position, front: !!x.front, total: !!x.total })
      .onConflictDoUpdate({
        target: [boardFieldRows.boardId, boardFieldRows.fieldId],
        set: { position, front: !!x.front, total: !!x.total, removedAt: null },
      })
  const kept = new Set(list.map((x) => x.id))
  const gone = [...shown.keys()].filter((id) => !kept.has(id))
  if (gone.length)
    await tx
      .update(boardFieldRows)
      .set({ removedAt: new Date(), front: false, total: false })
      .where(and(eq(boardFieldRows.boardId, board.id), inArray(boardFieldRows.fieldId, gone)))
  const items: ActivityItem[] = [
    ...list.filter((x) => !shown.has(x.id)).map((x) => ({ text: `added the field “${byId.get(x.id)!.name}”` })),
    ...gone.map((id) => ({ text: `took the field “${shown.get(id)!.name}” off the board` })),
  ]
  if (items.length)
    await tx.insert(boardActivity).values({ id: newId(), boardId: board.id, actorId: me.id, command: 'board.fields', items, via: via ?? null })
}

/**
 * What bringing these fields into a library would do (a board moving to another space, a file being imported):
 * nothing is changed yet. `canAdd`: the person manages that library.
 */
export async function adoptFields(tx: Tx, lib: Library, incoming: BoardField[], canAdd: boolean, boardId?: string): Promise<Adoption> {
  await lockLibrary(tx, lib)
  const all = await rowsOf(tx, lib)
  const library: LibraryField[] = all.map((r) => ({ ...fieldFromRow(r), ...(r.archivedAt && { archived: true }) }))
  const defs = incoming.map(({ front: _front, total: _total, ...def }): FieldDef => def)
  return planAdoption(library, defs, {
    canAdd,
    room: FIELD_LIMITS.perSpace - all.filter((r) => !r.archivedAt).length,
    newId,
    // (A card link that named the board arriving keeps naming it; any other board stays behind.)
    ...(boardId && { self: { was: boardId, is: boardId } }),
  })
}

/**
 * What making a board from a starter would do to a library (nothing is changed yet): which of the starter's fields
 * it has, which are to be added, and which can't be. The library stays locked until the transaction ends, so two
 * boards made at the same moment don't both add the fields.
 */
export async function fitStarter(tx: Tx, lib: Library, wanted: BoardField[], canAdd: boolean): Promise<StarterPlan> {
  await lockLibrary(tx, lib)
  const all = await rowsOf(tx, lib)
  const library: LibraryField[] = all.map((r) => ({ ...fieldFromRow(r), ...(r.archivedAt && { archived: true }) }))
  const defs = wanted.map(({ front: _front, total: _total, ...def }): FieldDef => def)
  return planStarter(library, defs, { canAdd, room: FIELD_LIMITS.perSpace - all.filter((r) => !r.archivedAt).length, newId })
}

/** Makes an adoption's additions to the library. Returns the boards that show a field it changed (to reload). */
export async function applyAdoption(app: FastifyInstance, tx: Tx, lib: Library, plan: Pick<Adoption, 'add' | 'addOptions'>): Promise<string[]> {
  // (Added in one go, they'd all be "created" at the same moment: a millisecond apart keeps them in their order.)
  const now = Date.now()
  for (const [i, f] of plan.add.entries()) {
    const { id, name, type, ...settings } = f
    await tx.insert(libraryFields).values({
      id,
      workspaceId: 'workspaceId' in lib ? lib.workspaceId : null,
      ownerId: 'ownerId' in lib ? lib.ownerId : null,
      name: name.trim().normalize('NFC'),
      type,
      settings,
      createdAt: new Date(now + i),
    })
  }
  const touched: string[] = []
  for (const [fieldId, options] of plan.addOptions) {
    const row = await fieldIn(tx, lib, fieldId)
    const showing = await boardsWith(tx, fieldId)
    await app.engine.bump(tx, showing)
    touched.push(...showing)
    await tx
      .update(libraryFields)
      .set({ settings: { ...row.settings, options: [...(row.settings.options ?? []), ...options] }, updatedAt: new Date() })
      .where(eq(libraryFields.id, fieldId))
  }
  return touched
}

/** A board's field rows, replaced by this list (a new board, or one that moved to another space). */
export async function replaceBoardFields(tx: Tx, boardId: string, list: { id: string; front?: boolean; total?: boolean }[]) {
  await tx.delete(boardFieldRows).where(eq(boardFieldRows.boardId, boardId))
  const rows = list.slice(0, FIELD_LIMITS.perBoard)
  let front = 0
  let total = 0
  if (rows.length)
    await tx.insert(boardFieldRows).values(
      rows.map((x, position) => ({
        boardId,
        fieldId: x.id,
        position,
        front: !!x.front && ++front <= FIELD_LIMITS.front,
        total: !!x.total && ++total <= FIELD_LIMITS.totals,
      })),
    )
}

/**
 * A board is moving to another space (`to`: a workspace, or null for the mover's Personal boards): its fields belong
 * to the library it leaves. Each is matched in the library it goes to by name and type; the rest are added there if
 * the mover manages it, and otherwise can't come along. Anything added or lost is first put to the person (a 409
 * that lists both) and only done once `confirmed`. The cards' values are rewritten for the new fields; values that
 * were hidden (for fields taken off the board) don't move.
 *
 * Runs inside the move's transaction. Returns the other boards to reload (ones showing a field that got new options).
 */
export async function moveBoardFields(app: FastifyInstance, tx: Tx, board: BoardRow, userId: string, to: string | null, confirmed: boolean) {
  await app.engine.bump(tx, [board.id])
  const { data } = (await loadBoard(tx, board.id))!
  const lib: Library = to ? { workspaceId: to } : { ownerId: userId }
  const canAdd = to ? (await workspaceRole(tx, to, userId)) === 'admin' : true
  const plan = await adoptFields(tx, lib, data.fields, canAdd, board.id)
  const add = [
    ...plan.add.map((f) => f.name),
    ...[...plan.addOptions].flatMap(([id, options]) => options.map((o) => `${nameOf(data.fields, plan, id)}: ${o.name}`)),
  ]
  // Links never cross spaces: the ones between this board's cards and the boards it leaves go (see `unlinkBoard`).
  const links = await linksAround(tx, board)
  if (!confirmed && (add.length || plan.lose.length || links))
    throw new HttpError(409, 'Moving this board changes its fields.', 'fields', { add, lose: plan.lose, links })
  const touched = await applyAdoption(app, tx, lib, plan)
  await tx
    .update(tasks)
    .set({ custom: null })
    .where(and(eq(tasks.boardId, board.id), isNotNull(tasks.custom)))
  const own = (ref: string) => (parseRef(ref)?.boardId === board.id ? ref : null)
  // People in its person fields stay only if they're still on the board where it lands (the move changed that already).
  const [moved] = await tx.select().from(boards).where(eq(boards.id, board.id))
  const people = new Set((await boardPeople(tx, moved)).map((p) => p.userId))
  for (const t of [...Object.values(data.tasks), ...Object.values(data.archived ?? {})]) {
    const custom = carryCustom(t.custom, plan.map, { relink: own, isMember: (u) => people.has(u) })
    if (custom)
      await tx
        .update(tasks)
        .set({ custom })
        .where(and(eq(tasks.boardId, board.id), eq(tasks.id, t.id)))
  }
  await replaceBoardFields(
    tx,
    board.id,
    data.fields.flatMap((f) => (plan.map.has(f.id) ? [{ id: plan.map.get(f.id)!.id, front: f.front, total: f.total }] : [])),
  )
  return touched
}

/** The name of the board's field that becomes library field `id` (for saying which field gets a new option). */
const nameOf = (fields: BoardField[], plan: Adoption, id: string) => fields.find((f) => plan.map.get(f.id)?.id === id)?.name ?? 'A field'
