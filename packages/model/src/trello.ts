import type { ColorName } from './colors'
import { dayIn, normalizeTaskDate } from './dates'
import { FIELD_LIMITS, checkValue, nameKey, nameProblem, valueText, type BoardField, type CustomValues, type FieldOption } from './fields'
import { guessCategory } from './listNames'
import { positionBetween, positionsBetween } from './position'
import type { BoardData, Category, LabelDef, Meta, StatusColumn, Task, TaskMap } from './types'

/**
 * A Trello board, as its "Export as JSON" gives it, turned into a board here. Three steps, all without a server:
 * `isTrelloExport` tells the file apart, `slimTrello` keeps the parts that are used (the rest of the file is most of
 * its size, and nothing here trusts its shapes), and `fromTrello` makes the board, its comments, and a summary of
 * what came over and what stayed behind.
 */

// ── The parts of the file that are used ─────────────────

export interface TrelloList {
  id: string
  name: string
  closed: boolean
  pos: number
}
export interface TrelloLabel {
  id: string
  name: string
  color: string
}
export interface TrelloAttachment {
  name: string
  url: string
  isUpload: boolean
}
export interface TrelloFieldItem {
  idCustomField: string
  idValue: string
  /** Trello writes every value as text, under the name of its kind: `{ number: "12" }`, `{ checked: "true" }`. */
  value: Record<string, string>
}
export interface TrelloCard {
  id: string
  name: string
  desc: string
  closed: boolean
  idList: string
  idLabels: string[]
  idMembers: string[]
  pos: number
  due: string
  start: string
  dueComplete: boolean
  dateLastActivity: string
  /** How many comments Trello says it has: more than the file holds, when the older ones weren't exported. */
  comments: number
  attachments: TrelloAttachment[]
  customFieldItems: TrelloFieldItem[]
}
export interface TrelloCheckItem {
  name: string
  done: boolean
  pos: number
  due: string
}
export interface TrelloChecklist {
  idCard: string
  name: string
  pos: number
  items: TrelloCheckItem[]
}
export interface TrelloCustomField {
  id: string
  name: string
  type: string
  pos: number
  options: { id: string; name: string; color: string; pos: number }[]
}
export interface TrelloComment {
  idCard: string
  text: string
  date: string
  by: string
}
/** A Trello export, slimmed to what's used. `slim` marks it, so it isn't slimmed twice. */
export interface TrelloFile {
  slim: 'trello'
  name: string
  desc: string
  background: string
  lists: TrelloList[]
  cards: TrelloCard[]
  labels: TrelloLabel[]
  checklists: TrelloChecklist[]
  customFields: TrelloCustomField[]
  members: { id: string; name: string }[]
  comments: TrelloComment[]
}

/** Cards and checklist items one imported board can hold. */
export const TRELLO_MAX_TASKS = 10_000

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
// (PostgreSQL text can't hold a NUL character.)
const str = (v: unknown): string => (typeof v === 'string' ? v.replaceAll('\u0000', '') : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string')

/** Whether a parsed file is a Trello board export (and not one of Kanbanto's own). */
export function isTrelloExport(raw: unknown): boolean {
  const f = obj(raw)
  if (f.slim === 'trello') return true
  return typeof f.name === 'string' && Array.isArray(f.lists) && Array.isArray(f.cards) && !('tasks' in f) && !('format' in f)
}

/** The parts of a Trello export that are used, in known shapes: anything missing or odd becomes empty. */
export function slimTrello(raw: unknown): TrelloFile {
  const f = obj(raw)
  const members = arr(f.members).map((m) => ({ id: str(obj(m).id), name: str(obj(m).fullName ?? obj(m).name) || str(obj(m).username) }))
  return {
    slim: 'trello',
    name: str(f.name),
    desc: str(f.desc),
    background: str(obj(f.prefs).background ?? f.background),
    lists: arr(f.lists).map((l) => ({ id: str(obj(l).id), name: str(obj(l).name), closed: obj(l).closed === true, pos: num(obj(l).pos) })),
    cards: arr(f.cards).map((c) => {
      const card = obj(c)
      return {
        id: str(card.id),
        name: str(card.name),
        desc: str(card.desc),
        closed: card.closed === true,
        idList: str(card.idList),
        idLabels: strs(card.idLabels),
        idMembers: strs(card.idMembers),
        pos: num(card.pos),
        due: str(card.due),
        start: str(card.start),
        dueComplete: card.dueComplete === true,
        dateLastActivity: str(card.dateLastActivity),
        comments: num(card.comments ?? obj(card.badges).comments),
        attachments: arr(card.attachments).map((a) => ({ name: str(obj(a).name), url: str(obj(a).url), isUpload: obj(a).isUpload === true })),
        customFieldItems: arr(card.customFieldItems).map((i) => ({
          idCustomField: str(obj(i).idCustomField),
          idValue: str(obj(i).idValue),
          value: Object.fromEntries(Object.entries(obj(obj(i).value)).map(([k, v]) => [k, str(v)])),
        })),
      }
    }),
    labels: arr(f.labels).map((l) => ({ id: str(obj(l).id), name: str(obj(l).name), color: str(obj(l).color) })),
    checklists: arr(f.checklists).map((c) => ({
      idCard: str(obj(c).idCard),
      name: str(obj(c).name),
      pos: num(obj(c).pos),
      items: arr(obj(c).items ?? obj(c).checkItems).map((i) => ({
        name: str(obj(i).name),
        done: obj(i).done === true || obj(i).state === 'complete',
        pos: num(obj(i).pos),
        due: str(obj(i).due),
      })),
    })),
    customFields: arr(f.customFields).map((c) => ({
      id: str(obj(c).id),
      name: str(obj(c).name),
      type: str(obj(c).type),
      pos: num(obj(c).pos),
      options: arr(obj(c).options).map((o) => ({
        id: str(obj(o).id),
        name: str(obj(o).name) || str(obj(obj(o).value).text),
        color: str(obj(o).color),
        pos: num(obj(o).pos),
      })),
    })),
    members,
    comments: Array.isArray(f.comments)
      ? arr(f.comments).map((c) => ({ idCard: str(obj(c).idCard), text: str(obj(c).text), date: str(obj(c).date), by: str(obj(c).by) }))
      : arr(f.actions).flatMap((a) => {
          const action = obj(a)
          if (action.type !== 'commentCard' && action.type !== 'copyCommentCard') return []
          const data = obj(action.data)
          const who = obj(action.memberCreator)
          return [
            {
              idCard: str(obj(data.card).id) || str(data.idCard),
              text: str(data.text),
              date: str(action.date),
              by: str(who.fullName) || str(who.username) || members.find((m) => m.id === str(action.idMemberCreator))?.name || '',
            },
          ]
        }),
  }
}

// ── Making the board ────────────────────────────────────

export interface TrelloOptions {
  boardId: string
  /** The moment of the import (ISO). */
  now: string
  newId: () => string
  /** What a list counts as, by its Trello id, where the guess from its name isn't wanted. */
  categories?: Record<string, Category>
  /** The time zone a start day is read in (Trello keeps a moment; a start has no time of day here). */
  zone?: string
}

export interface TrelloSummary {
  name: string
  /** The lists that are made, in order: what each counts as, and whether its name said so. */
  lists: { id: string; name: string; category: Category; guessed: boolean; cards: number }[]
  cards: number
  /** Cards that arrive archived: archived in Trello, or in a list that was. */
  archived: number
  subtasks: number
  labels: number
  comments: number
  /** Trello's custom fields that become fields. */
  fields: string[]
  left: {
    /** Archived lists, which aren't made. */
    closedLists: string[]
    /** Files uploaded to Trello: they stay there, and each card links to its own. */
    files: number
    /** Cards that had people on them: their names are written on the card. */
    people: number
    /** Comments Trello didn't put in the file (it exports the newest 1,000 actions). */
    missingComments: number
    /** Custom fields past what one board holds: written on the cards as text. */
    fieldsAsText: string[]
    /** A "Done" list was added for ticked checklist items, since no list counts as done. */
    doneListAdded: boolean
    /** Cards marked complete in Trello that aren't in a done list: they get the label "Complete in Trello". */
    completeLabel: number
    /** Texts shortened to fit (a title, a description, a comment). */
    cut: number
  }
}

export interface TrelloImport {
  data: BoardData
  /** Comments, oldest first, for cards of `data` (archived ones too). */
  comments: { taskId: string; body: string; at: string }[]
  summary: TrelloSummary
}

export const COMPLETE_IN_TRELLO = 'Complete in Trello'
const COMMENT_MAX = 10_000
const DESCRIPTION_MAX = 50_000

/** Trello's colours as the nearest of ours (its light and dark shades are one colour here). */
const COLOR: Record<string, ColorName> = {
  green: 'green',
  yellow: 'yellow',
  orange: 'orange',
  red: 'red',
  purple: 'violet',
  blue: 'blue',
  sky: 'sky',
  lime: 'lime',
  pink: 'pink',
  black: 'gray',
  grey: 'gray',
  gray: 'gray',
}
const colorOf = (trello: string): ColorName => COLOR[trello.replace(/_(light|dark)$/, '')] ?? 'gray'

/** A Trello id starts with the second it was made (like a MongoDB id). */
function madeAt(id: string, fallback: string): string {
  const s = /^[0-9a-f]{24}$/i.test(id) ? parseInt(id.slice(0, 8), 16) * 1000 : NaN
  return s > Date.UTC(2010, 0, 1) && s <= Date.parse(fallback) ? new Date(s).toISOString() : fallback
}
const moment = (v: string, fallback: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback)

/** A link written in Markdown: the name can't close the brackets, the address can't close the link. */
function mdLink(name: string, url: string): string {
  const text = (name || url).replace(/[\r\n]+/g, ' ').replace(/([\\[\]])/g, '\\$1')
  return /^https?:\/\//i.test(url)
    ? `[${text}](${url.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`
    : text
}

/**
 * A Trello export as a board. Lists keep their order (archived ones aren't made: their cards arrive archived),
 * checklists become subtasks, comments keep their dates, custom fields become fields. What has no place here is
 * written on the card (who it was assigned to, links to its files) and counted in the summary.
 */
export function fromTrello(file: TrelloFile, opts: TrelloOptions): TrelloImport {
  const { now, newId } = opts
  const meta = (at = now): Meta => ({ createdAt: at, updatedAt: at, version: 1 })
  let cut = 0
  const fit = (text: string, max: number) => {
    if (text.length <= max) return text
    cut++
    return `${text.slice(0, max - 1)}…`
  }

  // Lists.
  const open = file.lists.filter((l) => l.id && !l.closed).sort((a, b) => a.pos - b.pos)
  const closed = file.lists.filter((l) => l.id && l.closed)
  const categoryOf = (l: TrelloList): { category: Category; guessed: boolean } => {
    const said = opts.categories?.[l.id]
    const guess = guessCategory(l.name)
    return { category: said ?? guess ?? 'todo', guessed: !said && !!guess }
  }
  const keys = positionsBetween(null, null, Math.max(open.length, 1))
  const columns: StatusColumn[] = open.length
    ? open.map((l, i) => ({
        id: newId(),
        name: fit(l.name.trim() || 'Untitled list', 200),
        category: categoryOf(l).category,
        position: keys[i],
        ...meta(),
      }))
    : [{ id: newId(), name: 'To Do', category: 'todo', position: keys[0], ...meta() }]
  const columnOf = new Map(open.map((l, i) => [l.id, columns[i]]))
  const closedList = new Map(closed.map((l) => [l.id, l]))
  const firstOpen = columns.find((c) => c.category !== 'done') ?? columns[0]
  let doneListAdded = false
  const doneColumn = (): StatusColumn => {
    let col = columns.find((c) => c.category === 'done')
    if (!col) {
      col = { id: newId(), name: 'Done', category: 'done', position: positionBetween(columns[columns.length - 1].position, null), ...meta() }
      columns.push(col)
      doneListAdded = true
    }
    return col
  }

  // The cards that come over: on a list of this board, archived or not.
  const listIndex = new Map(open.map((l, i) => [l.id, i]))
  const cards = file.cards
    .filter((c) => c.id && (columnOf.has(c.idList) || closedList.has(c.idList)))
    .sort((a, b) => (listIndex.get(a.idList) ?? open.length) - (listIndex.get(b.idList) ?? open.length) || a.pos - b.pos)

  // Labels: the ones with a name, and the ones a card wears.
  const worn = new Set(cards.flatMap((c) => c.idLabels))
  const labels: LabelDef[] = []
  const labelOf = new Map<string, string>()
  for (const l of file.labels) {
    if (!l.id || labelOf.has(l.id) || !(l.name.trim() || worn.has(l.id))) continue
    const id = newId()
    labels.push({ id, name: fit(l.name.trim(), 200), color: colorOf(l.color), ...meta() })
    labelOf.set(l.id, id)
  }
  let completeLabel = 0
  const completeId = () => {
    let l = labels.find((x) => x.name === COMPLETE_IN_TRELLO)
    if (!l) labels.push((l = { id: newId(), name: COMPLETE_IN_TRELLO, color: 'green', ...meta() }))
    return l.id
  }

  // Custom fields: as many as one board holds become fields, the rest are written on the cards.
  const kinds: Record<string, BoardField['type']> = { text: 'text', number: 'number', date: 'date', checkbox: 'checkbox', list: 'choice' }
  const fields: BoardField[] = []
  const fieldOf = new Map<string, { def: BoardField; options: Map<string, string> }>()
  const asText = new Map<string, TrelloCustomField>()
  const taken = new Set<string>()
  for (const cf of [...file.customFields].sort((a, b) => a.pos - b.pos)) {
    const type = kinds[cf.type]
    if (!cf.id || !type || fieldOf.has(cf.id) || asText.has(cf.id)) continue
    if (fields.length >= FIELD_LIMITS.perBoard) {
      asText.set(cf.id, cf)
      continue
    }
    // (A name every card already has, "Priority", can't be a field's: it says where it came from instead.)
    let name = cf.name.trim().slice(0, FIELD_LIMITS.name) || 'Field'
    if (nameProblem(name)) name = `${name.slice(0, FIELD_LIMITS.name - 9)} (Trello)`
    for (let n = 2; taken.has(nameKey(name)); n++) name = `${name.replace(/ \(\d+\)$/, '').slice(0, FIELD_LIMITS.name - 5)} (${n})`
    taken.add(nameKey(name))
    const options = new Map<string, string>()
    const made: FieldOption[] = []
    if (type === 'choice')
      for (const o of [...cf.options].sort((a, b) => a.pos - b.pos)) {
        const optionName = o.name.trim().slice(0, FIELD_LIMITS.name)
        if (!o.id || !optionName) continue
        const same = made.find((m) => nameKey(m.name) === nameKey(optionName))
        if (same) options.set(o.id, same.id)
        else if (made.length < FIELD_LIMITS.options) {
          made.push({ id: newId(), name: optionName, color: colorOf(o.color) })
          options.set(o.id, made[made.length - 1].id)
        }
      }
    const def: BoardField = { id: newId(), name, type, ...(type === 'choice' && { options: made }) }
    fields.push(def)
    fieldOf.set(cf.id, { def, options })
  }
  /** What a card holds for a Trello field, in the form its kind here takes (undefined: nothing). */
  const valueOf = (type: string, item: TrelloFieldItem, options?: Map<string, string>): unknown => {
    if (type === 'list') return options?.get(item.idValue)
    if (type === 'number') return item.value.number && Number.isFinite(Number(item.value.number)) ? Number(item.value.number) : undefined
    if (type === 'checkbox') return item.value.checked === 'true' ? true : undefined
    if (type === 'date') return normalizeTaskDate(item.value.date ?? '') ?? undefined
    return (item.value.text ?? '').trim().slice(0, FIELD_LIMITS.text) || undefined
  }

  const memberName = new Map(file.members.filter((m) => m.id && m.name).map((m) => [m.id, m.name]))
  const checklistsOf = new Map<string, TrelloChecklist[]>()
  for (const c of file.checklists) {
    if (!c.items.length) continue
    const of = checklistsOf.get(c.idCard)
    if (of) of.push(c)
    else checklistsOf.set(c.idCard, [c])
  }
  const count = cards.length + cards.reduce((n, c) => n + (checklistsOf.get(c.id) ?? []).reduce((m, l) => m + l.items.length + 1, 0), 0)
  if (count > TRELLO_MAX_TASKS)
    throw new Error(
      `That board is too big to import: ${count.toLocaleString('en')} cards and checklist items (${TRELLO_MAX_TASKS.toLocaleString('en')} at most).`,
    )

  const tasks: TaskMap = {}
  const archived: TaskMap = {}
  const taskOf = new Map<string, string>()
  const perList = new Map<string, number>()
  let files = 0
  let people = 0
  let subtasks = 0
  let archivedCards = 0
  const ranks = positionsBetween(null, null, cards.length)

  cards.forEach((card, at) => {
    const away = card.closed || closedList.has(card.idList)
    const column = columnOf.get(card.idList)
    const list = column ?? firstOpen
    const fromList = file.lists.find((l) => l.id === card.idList)!
    const created = madeAt(card.id, now)
    const touched = moment(card.dateLastActivity, created)
    const id = newId()
    taskOf.set(card.id, id)

    // What has no place of its own is written under the description.
    const notes: string[] = []
    const who = card.idMembers.flatMap((m) => memberName.get(m) ?? [])
    if (who.length) {
      people++
      notes.push(`Assigned in Trello: ${who.join(', ')}`)
    }
    const links = card.attachments.filter((a) => !a.isUpload && a.url)
    if (links.length) notes.push(['Links:', ...links.map((a) => `- ${mdLink(a.name === a.url ? '' : a.name, a.url)}`)].join('\n'))
    const uploads = card.attachments.filter((a) => a.isUpload)
    if (uploads.length) {
      files += uploads.length
      notes.push(['Files left in Trello (they open while you’re signed in there):', ...uploads.map((a) => `- ${mdLink(a.name, a.url)}`)].join('\n'))
    }
    const custom: CustomValues = {}
    const said: string[] = []
    for (const item of card.customFieldItems) {
      const field = fieldOf.get(item.idCustomField)
      const loose = asText.get(item.idCustomField)
      if (field) {
        const cf = file.customFields.find((c) => c.id === item.idCustomField)!
        const checked = checkValue(field.def, valueOf(cf.type, item, field.options))
        if ('value' in checked && checked.value !== undefined) custom[field.def.id] = checked.value
      } else if (loose) {
        const v = loose.type === 'list' ? loose.options.find((o) => o.id === item.idValue)?.name : valueOf(loose.type, item)
        if (v !== undefined && v !== '') said.push(`${loose.name.trim() || 'Field'}: ${v === true ? 'Yes' : String(v)}`)
      }
    }
    if (said.length) notes.push(said.join('\n'))
    const extra = notes.join('\n\n')
    const body = fit(card.desc.trim(), Math.max(0, DESCRIPTION_MAX - extra.length - 2))
    const description = [body, extra].filter(Boolean).join('\n\n')

    const due = normalizeTaskDate(card.due)
    const start = card.start && !Number.isNaN(Date.parse(card.start)) ? dayIn(new Date(card.start), opts.zone ?? 'UTC') : null
    const cardLabels = [...new Set(card.idLabels.flatMap((l) => labelOf.get(l) ?? []))]
    const fromCategory = column ? column.category : categoryOf(fromList).category
    if (card.dueComplete && !away && fromCategory !== 'done') {
      cardLabels.push(completeId())
      completeLabel++
    }
    const done = fromCategory === 'done' || card.dueComplete
    const task: Task = {
      id,
      title: fit(card.name.trim().replace(/\s*[\r\n]+\s*/g, ' ') || 'Untitled card', 500),
      parentId: null,
      // (An archived card needs a list that exists: the one it would come back to.)
      status: column ? column.id : done ? (columns.find((c) => c.category === 'done') ?? firstOpen).id : firstOpen.id,
      order: ranks[at],
      rank: ranks[at],
      labels: cardLabels,
      blockedBy: [],
      ...(description && { description }),
      ...(due && { due }),
      ...(start && { start }),
      ...(Object.keys(custom).length && { custom }),
      createdAt: created,
      updatedAt: touched,
      activeAt: touched,
      version: 1,
      ...(away && { archivedAt: touched, archivedList: fit(fromList.name.trim() || list.name, 200), archivedDone: done }),
    }
    ;(away ? archived : tasks)[id] = task
    if (away) archivedCards++
    else perList.set(card.idList, (perList.get(card.idList) ?? 0) + 1)

    // Checklists: one checklist's items sit under the card; several get a subtask each, with their items under it.
    const lists = [...(checklistsOf.get(card.id) ?? [])].sort((a, b) => a.pos - b.pos)
    const child = (parentId: string, title: string, isDone: boolean, order: string, itemDue?: string): string => {
      const subId = newId()
      // An unticked item waits where its card is, unless that is a done list: then in the first list that isn't.
      const col = isDone ? doneColumn() : list.category === 'done' ? firstOpen : list
      const sub: Task = {
        id: subId,
        title: fit(title.trim().replace(/\s*[\r\n]+\s*/g, ' ') || 'Untitled', 500),
        parentId,
        status: col.id,
        order,
        labels: [],
        blockedBy: [],
        ...(itemDue && normalizeTaskDate(itemDue) && { due: normalizeTaskDate(itemDue)! }),
        createdAt: created,
        updatedAt: touched,
        activeAt: touched,
        version: 1,
        ...(away && { archivedAt: touched, archivedList: col.name, archivedDone: isDone }),
      }
      ;(away ? archived : tasks)[subId] = sub
      subtasks++
      return subId
    }
    const items = (parentId: string, l: TrelloChecklist) => {
      const sorted = [...l.items].sort((a, b) => a.pos - b.pos)
      const order = positionsBetween(null, null, sorted.length)
      sorted.forEach((item, i) => child(parentId, item.name, item.done, order[i], item.due))
    }
    if (lists.length === 1) items(id, lists[0])
    else {
      const order = positionsBetween(null, null, lists.length)
      lists.forEach((l, i) =>
        items(
          child(
            id,
            l.name || 'Checklist',
            l.items.every((x) => x.done),
            order[i],
          ),
          l,
        ),
      )
    }
  })

  // Comments, oldest first, under the name of whoever wrote them in Trello (here they are the importer's).
  const found = new Map<string, number>()
  const comments = file.comments
    .flatMap((c) => {
      const taskId = taskOf.get(c.idCard)
      if (!taskId || !c.text.trim()) return []
      found.set(c.idCard, (found.get(c.idCard) ?? 0) + 1)
      const head = c.by ? `**${c.by.replace(/([\\*_[\]])/g, '\\$1')}** wrote in Trello:\n\n` : 'Written in Trello:\n\n'
      return [{ taskId, body: head + fit(c.text.trim(), COMMENT_MAX - head.length), at: moment(c.date, now) }]
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const missingComments = cards.reduce((n, c) => n + Math.max(0, c.comments - (found.get(c.id) ?? 0)), 0)

  const background = COLOR[file.background]
  const name = fit(file.name.trim() || 'Trello board', 200)
  const description = fit(file.desc.trim(), 1000)
  const data: BoardData = {
    board: { id: opts.boardId, name, mode: 'manual', ...(background && { background }), ...(description && { description }), ...meta() },
    members: [],
    columns,
    labels,
    fields,
    tasks,
    ...(Object.keys(archived).length && { archived }),
  }
  return {
    data,
    comments,
    summary: {
      name,
      lists: open.map((l, i) => ({ id: l.id, name: columns[i].name, ...categoryOf(l), cards: perList.get(l.id) ?? 0 })),
      cards: cards.length - archivedCards,
      archived: archivedCards,
      subtasks,
      labels: labels.length,
      comments: comments.length,
      fields: fields.map((f) => f.name),
      left: {
        closedLists: closed.map((l) => l.name.trim() || 'Untitled list'),
        files,
        people,
        missingComments,
        fieldsAsText: [...asText.values()].map((f) => f.name.trim() || 'Field'),
        doneListAdded,
        completeLabel,
        cut,
      },
    },
  }
}

/** What a card's value for a field reads as, for a field that couldn't come along and is written on the card. */
export const fieldLine = (def: BoardField, value: CustomValues[string]) => `${def.name}: ${valueText(def, value)}`
