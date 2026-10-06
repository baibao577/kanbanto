import type { TaskFields } from '@kanbanto/model/commands'
import { nameKey, parseRef, parseValue, type BoardField, type FieldValue } from '@kanbanto/model/fields'
import { newId } from '@kanbanto/model/ids'
import { indexFor, type TaskIndex } from '@kanbanto/model/indexer'
import { PRIORITIES, type BoardData, type Priority } from '@kanbanto/model/types'
import { dueOf, parseWhen, titleDate } from '@kanbanto/model/when'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SessionUser } from '../auth/sessions'
import { taskUrl } from '../calendar/items'
import { HttpError } from '../http'
import { requireAccess, type BoardRow } from './access'
import { ensureInbox } from './inbox'
import { pickCards } from './links'

/**
 * Cards as someone says them, in plain names: "in the list Doing, labelled bug, for Ann, Stage: Won". The one place
 * that turns those names into what a board holds, for an assistant's tools and for the calls apps make
 * (`POST /api/inbox/cards`, `POST /api/boards/:id/cards`). Every name is looked up before anything is added, so a
 * wrong one adds nothing, and the refusal says what there is.
 */

/** Finds a list, label, field or person by id or name (case doesn't matter), or says what there is. */
export function pick<T extends { id: string; name: string }>(items: T[], ref: string, what: string): T {
  const r = ref.trim().toLowerCase()
  const found = items.find((i) => i.id === ref) ?? items.find((i) => i.name.toLowerCase() === r)
  if (!found) throw new HttpError(400, `There’s no ${what} “${ref}”. The ${what}s are: ${items.map((i) => i.name).join(', ') || 'none'}.`)
  return found
}

/** What a card can be given by name (all optional; null clears, where there is something to clear). */
export interface CardSaid {
  description?: string
  start?: string | null
  due?: string | null
  assignee?: string | null
  priority?: Priority | null
  labels?: string[]
  list?: string
  fields?: Record<string, string | number | boolean | null | string[]>
}
export type NewCardSaid = CardSaid & { title: string }

/** A person on the board, by name or id; "me" is whoever is asking. (null and undefined stay what they are.) */
export const personSaid = (data: BoardData, ref: string | null | undefined, me: { id: string }) =>
  ref == null ? ref : ref.trim().toLowerCase() === 'me' ? me.id : pick(data.members, ref, 'person').id

/**
 * The cards a link field should hold, as they're said: by title (it has to be exactly one card the field may link,
 * among the ones this person can open) or as links.
 */
async function linksSaid(
  app: FastifyInstance,
  me: SessionUser,
  board: BoardRow,
  def: BoardField,
  said: string[],
  taskId?: string,
): Promise<string[]> {
  const refs: string[] = []
  for (const s of said) {
    if (parseRef(s)) {
      refs.push(s)
      continue
    }
    const { cards, problem } = await pickCards({ db: app.db, engine: app.engine }, me.id, board, def, s, taskId)
    const exact = cards.filter((c) => nameKey(c.title) === nameKey(s))
    if (exact.length === 1) refs.push(exact[0].ref)
    else if (exact.length)
      throw new HttpError(
        400,
        `${def.name}: more than one card is called “${s}”. Say which by its link: ${exact.map((c) => `${c.ref} (on ${c.board.name}${c.path.length ? `, under “${c.path.at(-1)}”` : ''})`).join('; ')}.`,
      )
    else
      throw new HttpError(
        400,
        `${def.name}: ${
          problem ??
          `there’s no card called “${s}” to link${
            cards.length
              ? ` (close: ${cards
                  .slice(0, 5)
                  .map((c) => `“${c.title}”`)
                  .join(', ')})`
              : ''
          }.`
        }`,
      )
  }
  return refs
}

/** Values for the board's own fields, by the fields' names. */
async function customSaid(
  app: FastifyInstance,
  me: SessionUser,
  board: BoardRow,
  data: BoardData,
  given: NonNullable<CardSaid['fields']>,
  taskId?: string,
) {
  const out: Record<string, FieldValue | null> = {}
  for (const [name, value] of Object.entries(given)) {
    const def = pick(data.fields, name, 'field')
    if (def.type === 'link' && value !== null && value !== '') {
      const refs = await linksSaid(app, me, board, def, Array.isArray(value) ? value : [String(value)], taskId)
      out[def.id] = refs.length ? refs : null
      continue
    }
    if (def.type === 'person' && value !== null && value !== '') {
      const said = Array.isArray(value) ? value : [String(value)]
      if (said.length > 1 && !def.many) throw new HttpError(400, `${def.name} holds one person.`)
      out[def.id] = [...new Set(said.map((who) => personSaid(data, who, me)!))]
      continue
    }
    if (Array.isArray(value)) throw new HttpError(400, `${def.name}: that takes one value, not a list.`)
    const r = parseValue(def, value)
    if ('error' in r) throw new HttpError(400, `${def.name}: ${r.error}`)
    out[def.id] = r.value ?? null
  }
  return out
}

/** What was said about a card, as the fields a command takes. `taskId`: the card it's about, when it exists already. */
export async function fieldsSaid(
  app: FastifyInstance,
  me: SessionUser,
  board: BoardRow,
  data: BoardData,
  idx: TaskIndex,
  a: CardSaid,
  taskId?: string,
): Promise<TaskFields> {
  return {
    ...(a.description !== undefined && { description: a.description }),
    // (null takes a date off: to a command, that's an empty one.)
    ...(a.start !== undefined && { start: a.start ?? '' }),
    ...(a.due !== undefined && { due: a.due ?? '' }),
    ...(a.assignee !== undefined && { assigneeId: personSaid(data, a.assignee, me) ?? null }),
    ...(a.priority !== undefined && { priority: a.priority }),
    ...(a.labels && { labels: a.labels.map((l) => pick(data.labels, l, 'label').id) }),
    ...(a.list && { status: pick(idx.columns, a.list, 'list').id }),
    ...(a.fields && Object.keys(a.fields).length > 0 && { custom: await customSaid(app, me, board, data, a.fields, taskId) }),
  }
}

export interface Created {
  id: string
  title: string
  subtasks?: { id: string; title: string }[]
}

/**
 * Adds cards to a board `me` can edit, each with its subtasks, at the top level or under `parentId`. `via`: the app
 * they came through, for the board's activity.
 *
 * Refused part-way (a date that isn't one, say): the refusal says what was added before that, so it isn't added twice.
 */
export async function addCards(
  app: FastifyInstance,
  who: { me: SessionUser; via?: string | null },
  boardId: string,
  cards: (NewCardSaid & { subtasks?: NewCardSaid[] })[],
  parentId?: string | null,
): Promise<{ board: { id: string; name: string }; created: Created[] }> {
  const { me } = who
  const { board } = await requireAccess(app.db, me, boardId, 'editor')
  const { data } = await app.engine.snapshot(boardId)
  const idx = indexFor(data)
  if (parentId && !data.tasks[parentId]) throw new HttpError(404, 'There’s no such parent task on this board.')
  // Every list, label and person is looked up before anything is added, so a wrong name adds nothing.
  const plan: { id: string; title: string; fields: TaskFields; subtasks: { id: string; title: string; fields: TaskFields }[] }[] = []
  for (const t of cards) {
    const subtasks = []
    for (const k of t.subtasks ?? []) subtasks.push({ id: newId(), title: k.title, fields: await fieldsSaid(app, me, board, data, idx, k) })
    plan.push({ id: newId(), title: t.title, fields: await fieldsSaid(app, me, board, data, idx, t), subtasks })
  }
  const run = (id: string, parent: string | null, title: string, fields: TaskFields) =>
    app.engine.mutate(boardId, newId(), { type: 'task.create', id, parentId: parent, fields: { title, ...fields } }, me.id, who.via ?? undefined)
  const created: Created[] = []
  try {
    for (const t of plan) {
      await run(t.id, parentId ?? null, t.title, t.fields)
      const row: Created = { id: t.id, title: t.title }
      created.push(row)
      for (const k of t.subtasks) {
        await run(k.id, t.id, k.title, k.fields)
        ;(row.subtasks ??= []).push({ id: k.id, title: k.title })
      }
    }
  } catch (e) {
    const n = created.reduce((sum, t) => sum + 1 + (t.subtasks?.length ?? 0), 0)
    if (!(e instanceof HttpError) || !n) throw e
    throw new HttpError(
      e.status,
      `${e.message} ${n} of them ${n === 1 ? 'was' : 'were'} added before that (don’t add ${n === 1 ? 'it' : 'them'} again): ${created.map((t) => `“${t.title}” (${t.id})`).join(', ')}.`,
    )
  }
  return { board: { id: boardId, name: data.board.name }, created }
}

// ── One card, in one call (for apps) ───────────────────────────────────────────

const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}
const said = {
  description: z.string().max(20_000).optional(),
  list: z.string().max(100).optional(),
  // (A day, a moment with its time zone, or words: see `whenSaid`.)
  due: z.string().max(100).nullable().optional(),
  start: z.string().max(100).nullable().optional(),
  assignee: z.string().max(200).nullable().optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
  fields: z
    .record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.null(), z.array(z.string().max(500)).max(20)]))
    .optional(),
}
const title = z.string().trim().min(1, 'A card needs a title.').max(500)
/** What `POST /api/inbox/cards` and `POST /api/boards/:id/cards` take. */
export const NewCardBody = z
  .object({
    title,
    ...said,
    subtasks: z
      .array(z.object({ title, ...said }).strict())
      .max(50)
      .optional(),
    /** Under this card (a board's cards only). */
    parentId: z.string().max(100).optional(),
    /** A time written in the title ("call Sam tomorrow 3pm") is taken out of it and becomes the due date. */
    datesInTitle: z.boolean().optional(),
    /** Where "tomorrow 3pm" is read (an IANA name). Left out: the time zone of the account. */
    timeZone: z.string().max(64).refine(validZone, 'That isn’t a time zone (one looks like Asia/Bangkok).').optional(),
  })
  .strict()

/**
 * A date as an app may give it: a whole day (2026-10-31), a moment (2026-10-31T14:30:00+07:00), or words read on
 * the person's clock ("tomorrow 3pm", "friday").
 */
function whenSaid(value: string | null | undefined, zone: string, what: string): string | null | undefined {
  if (value == null || value === '' || /^\d{4}-\d{2}-\d{2}/.test(value.trim())) return value === '' ? null : value?.trim()
  const when = parseWhen(value, new Date(), zone)
  if (!when)
    throw new HttpError(400, `${what}: “${value}” isn’t a date I can read. Use 2026-10-31, 2026-10-31T14:30:00+07:00, or words like “tomorrow 3pm”.`)
  return dueOf(when)
}

/**
 * Adds one card (with its subtasks) as an app asks for it: to a board, or with no board to the person's Inbox, made
 * now if this is the first time it's needed. `site`: the site's address, for the card's own (null: not known).
 */
export async function addCardSaid(
  app: FastifyInstance,
  who: { me: SessionUser; via?: string | null },
  boardId: string | null,
  body: z.infer<typeof NewCardBody>,
  site: string | null,
) {
  const { datesInTitle, timeZone, parentId, subtasks, ...card } = body
  const zone = timeZone ?? (who.me.timeZone && validZone(who.me.timeZone) ? who.me.timeZone : 'UTC')
  const dated = (c: NewCardSaid): NewCardSaid => ({
    ...c,
    ...(c.due !== undefined && { due: whenSaid(c.due, zone, 'due') }),
    ...(c.start !== undefined && { start: whenSaid(c.start, zone, 'start') }),
  })
  let top = dated(card)
  // (Only where nothing says when it's due: a date given outright wins over words in the title.)
  const found = datesInTitle && top.due === undefined ? titleDate(top.title, new Date(), zone) : null
  if (found) top = { ...top, title: found.title, due: found.due }
  const inbox = boardId === null
  const id = boardId ?? (await ensureInbox(app.db, who.me.id))
  if (inbox && parentId) throw new HttpError(400, 'parentId is for a card on a board: say which board.')
  const { board, created } = await addCards(app, who, id, [{ ...top, subtasks: subtasks?.map(dated) }], parentId)
  const [made] = created
  return { board: { ...board, ...(inbox && { inbox: true }) }, card: { ...made, url: site ? taskUrl(site, id, made.id) : null } }
}
