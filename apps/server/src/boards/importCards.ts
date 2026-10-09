import { isTimeZone } from '@kanbanto/model/dates'
import { fieldIdOf, fieldKey, isFieldKey, nameKey } from '@kanbanto/model/fields'
import { newId } from '@kanbanto/model/ids'
import { guessColumns, IMPORT_ROLES, planCardImport, type BuiltInRole, type ColumnRole, type ImportReport } from '@kanbanto/model/importCards'
import type { Change } from '@kanbanto/model/records'
import { parseSheet } from '@kanbanto/model/sheet'
import type { BoardData } from '@kanbanto/model/types'
import { inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { users } from '../db/schema'
import { HttpError } from '../http'
import type { BoardRow } from './access'
import { addOptions, fieldsToExtend } from './fields'
import { cardTitles } from './links'

/**
 * Cards from a spreadsheet: what was pasted or a .csv file's text, and what each of its columns is. `dryRun`: only
 * the check (what would be added, which rows are left out, which cells can't be read), changing nothing.
 */
export const ImportCardsBody = z
  .object({
    text: z.string().min(1).max(5_000_000),
    /**
     * What each column is, in order: title, description, list, due, start, labels, assignee, priority, parent, skip,
     * or one of the board's fields (its name, or "f:" and its id). Left out: read from the names in the first row.
     */
    columns: z.array(z.string().max(120)).max(100).optional(),
    /** The first row is the columns' names (the default), not a card. */
    header: z.boolean().optional(),
    /** How dates written with numbers alone are read where their column doesn't say: day first, or month first. */
    dateOrder: z.enum(['dmy', 'mdy']).optional(),
    /** Also add rows whose title is already a card on the board. */
    addAnyway: z.boolean().optional(),
    timeZone: z.string().max(64).refine(isTimeZone, 'That isn’t a time zone (one looks like Asia/Bangkok).').optional(),
    dryRun: z.boolean().optional(),
    /** Yours to choose: the same one sent again adds nothing twice. */
    mutationId: z.string().min(1).max(100).optional(),
  })
  .strict()

export interface ImportCardsResult {
  /** What each column was taken as. */
  columns: ColumnRole[]
  report: ImportReport
  /** How many cards were added (0 for a check). */
  added: number
  seq?: number
  changes?: Change[]
}

/** What the caller said each column is, as roles: a built-in one, or a field of the board by name or id. */
function rolesSaid(data: BoardData, said: string[]): ColumnRole[] {
  return said.map((raw): ColumnRole => {
    const text = raw.trim()
    if (isFieldKey(text)) {
      if (!data.fields.some((f) => f.id === fieldIdOf(text)))
        throw new HttpError(400, 'One of the columns is set to a field this board doesn’t have.')
      return text
    }
    const key = nameKey(text)
    const field = data.fields.find((f) => nameKey(f.name) === key)
    if (field) return fieldKey(field.id)
    if ((IMPORT_ROLES as readonly string[]).includes(key)) return key as BuiltInRole
    throw new HttpError(
      400,
      `“${text}” isn’t something a column can be. It’s one of: ${IMPORT_ROLES.join(', ')}${data.fields.length ? `, or a field of this board (${data.fields.map((f) => f.name).join(', ')})` : ''}.`,
    )
  })
}

export async function importCards(
  app: FastifyInstance,
  who: { me: { id: string; timeZone?: string | null }; via?: string; owner?: boolean },
  board: BoardRow,
  body: z.infer<typeof ImportCardsBody>,
): Promise<ImportCardsResult> {
  const { me } = who
  let sheet
  try {
    sheet = parseSheet(body.text)
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'That couldn’t be read as rows.')
  }
  const { data } = await app.engine.snapshot(board.id)
  const header = body.header ?? true
  const columns = body.columns ? rolesSaid(data, body.columns) : guessColumns(header ? sheet.rows[0] : [], data.fields)
  if (!columns.includes('title') && !body.columns) columns[0] = 'title'

  // What the board itself doesn't say: its people's addresses, the cards its link fields can point at, and which
  // choice fields this person may add options to.
  const used = columns.flatMap((c) => (isFieldKey(c) ? (data.fields.find((f) => f.id === fieldIdOf(c)) ?? []) : []))
  // (Addresses are the board's owners' to see: a sheet that names people by address is matched against them for an
  // owner. For anyone else only their own address is known, or a column of guessed addresses and a look at which
  // rows were taken would tell them who on the board has which.)
  const known = who.owner ? data.members.map((m) => m.id) : data.members.some((m) => m.id === me.id) ? [me.id] : []
  const emails = known.length ? await app.db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, known)) : []
  const people = data.members.map((m) => ({ id: m.id, name: m.name, email: emails.find((e) => e.id === m.id)?.email }))
  const linked = new Map<string, Map<string, string[]>>()
  for (const f of used) if (f.type === 'link') linked.set(f.id, await cardTitles({ db: app.db, engine: app.engine }, me.id, board, f))
  const extend = await fieldsToExtend(
    app.db,
    board,
    me.id,
    used.filter((f) => f.type === 'choice').map((f) => f.id),
  )

  let plan
  try {
    plan = planCardImport(
      data,
      sheet.rows,
      {
        roles: columns,
        header,
        dateOrder: body.dateOrder,
        addAnyway: body.addAnyway,
        zone: body.timeZone ?? (isTimeZone(me.timeZone) ? me.timeZone : 'UTC'),
        now: new Date().toISOString(),
        newId,
      },
      { people, linked, canAddOption: (id) => extend.has(id) },
    )
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'Those rows couldn’t be read.')
  }
  const { report } = plan
  if (body.dryRun) return { columns, report, added: 0 }
  if (report.askDateOrder)
    throw new HttpError(
      422,
      `Some dates could be read two ways (“${report.askDateOrder.sample}” in ${report.askDateOrder.column}). Say which with dateOrder: "dmy" (day first) or "mdy" (month first).`,
    )
  if (!plan.command.cards.length) return { columns, report, added: 0 }
  // Options first: the cards' values name them. (They stay if the cards are then refused, or undone.)
  await addOptions(app, board, me.id, plan.options)
  const done = await app.engine.mutate(board.id, body.mutationId ?? newId(), plan.command, me.id, who.via)
  return { columns, report, added: done.changes.filter((c) => c.entity === 'task' && !c.before).length, seq: done.seq, changes: done.changes }
}
