import { LABEL_COLOR_CYCLE, type ColorName } from './colors'
import { IMPORT_MAX, type Command, type TaskFields } from './commands'
import { normalizeTaskDate } from './dates'
import {
  FIELD_LIMITS,
  checkValue,
  fieldIdOf,
  fieldKey,
  isFieldKey,
  nameKey,
  type BoardField,
  type FieldKey,
  type FieldOption,
  type FieldValue,
} from './fields'
import { guessCategory } from './listNames'
import { zoned } from './reminders'
import { dateOrderOf, isAmbiguousDate, readDate, readNumber, readPriority, readYes, type DateOrder } from './sheetValues'
import type { BoardData, Category } from './types'

/**
 * Cards from the rows of a spreadsheet. `guessColumns` says what each column probably is, from its name;
 * `planCardImport` reads every row against the board and returns what would be added (one `tasks.import` command),
 * and a report of it: how many cards, which lists and labels are new, which rows are left out and which cells
 * couldn't be read. Nothing is changed by planning: the same plan is the check before importing and the import.
 */

/** What a column of the sheet is: something every card has, one of the board's fields ("f:" and its id), or left out. */
export const IMPORT_ROLES = ['skip', 'title', 'description', 'list', 'due', 'start', 'labels', 'assignee', 'priority', 'parent'] as const
export type BuiltInRole = (typeof IMPORT_ROLES)[number]
export type ColumnRole = BuiltInRole | FieldKey
export const ROLE_LABEL: Record<BuiltInRole, string> = {
  skip: 'Leave out',
  title: 'Title',
  description: 'Description',
  list: 'List',
  due: 'Due date',
  start: 'Start date',
  labels: 'Labels',
  assignee: 'Assignee',
  priority: 'Priority',
  parent: 'Parent card',
}

/** Column names that say what a column is, English and Thai. */
const NAMES: [BuiltInRole, string[]][] = [
  ['title', ['title', 'name', 'task', 'task name', 'card', 'card name', 'subject', 'summary', 'ชื่อ', 'ชื่องาน', 'หัวข้อ', 'งาน', 'รายการ']],
  ['description', ['description', 'details', 'detail', 'notes', 'note', 'desc', 'รายละเอียด', 'หมายเหตุ', 'คำอธิบาย']],
  ['list', ['list', 'status', 'stage', 'column', 'state', 'สถานะ', 'ลิสต์']],
  ['due', ['due', 'due date', 'deadline', 'due on', 'end date', 'กำหนดส่ง', 'วันครบกำหนด', 'ครบกำหนด', 'วันที่ส่ง', 'วันสิ้นสุด']],
  ['start', ['start', 'start date', 'starts', 'begin', 'วันเริ่ม', 'วันที่เริ่ม', 'เริ่ม']],
  ['labels', ['labels', 'label', 'tags', 'tag', 'ป้าย', 'ป้ายกำกับ', 'แท็ก']],
  ['assignee', ['assignee', 'assigned to', 'assigned', 'owner', 'responsible', 'ผู้รับผิดชอบ', 'ผู้ดูแล', 'มอบหมายให้']],
  ['priority', ['priority', 'ความสำคัญ', 'ลำดับความสำคัญ']],
  ['parent', ['parent', 'parent card', 'parent task', 'การ์ดหลัก', 'งานหลัก']],
]

/**
 * What each column probably is, from the names in the first row. One of the board's fields of that name comes
 * first ("Stage" is the field, when the board has one); then the names above; anything else is left out. Without a
 * column that reads as the title, the first column nothing claimed is the title.
 */
export function guessColumns(header: string[], fields: BoardField[]): ColumnRole[] {
  const used = new Set<ColumnRole>()
  const take = (role: ColumnRole): ColumnRole => {
    if (used.has(role)) return 'skip'
    used.add(role)
    return role
  }
  const roles = header.map((name): ColumnRole => {
    const key = nameKey(name)
    if (!key) return 'skip'
    const field = fields.find((f) => nameKey(f.name) === key)
    if (field) return take(fieldKey(field.id))
    const builtIn = NAMES.find(([, names]) => names.includes(key))
    return builtIn ? take(builtIn[0]) : 'skip'
  })
  if (!used.has('title')) {
    const first = roles.findIndex((r) => r === 'skip')
    if (first !== -1) roles[first] = 'title'
  }
  return roles
}

/** What the planner needs to know that the board itself doesn't say. */
export interface ImportLookups {
  /** The board's people, with the address each signs in with (the board only has their names). */
  people: { id: string; name: string; email?: string }[]
  /** The cards a card link can point at, by field: a title (as `nameKey` has it) → the links to cards of that title. */
  linked?: Map<string, Map<string, string[]>>
  /** Whether the person importing may add options to this choice field (they manage its library). */
  canAddOption: (fieldId: string) => boolean
}

export interface ImportOptions {
  roles: ColumnRole[]
  /** The first row holds the columns' names, not a card. */
  header: boolean
  /** How to read dates written with numbers alone, in columns where nothing says (3/4/2026). */
  dateOrder?: DateOrder
  /** Also add rows whose title is already a card on the board. */
  addAnyway?: boolean
  /** The time zone a time of day in a date cell is read in. */
  zone: string
  /** The moment of the import (ISO): "15 Oct" is this year's. */
  now: string
  newId: () => string
}

export type ProblemKind = 'date' | 'number' | 'yes' | 'person' | 'priority' | 'option' | 'parent' | 'link' | 'long' | 'lists' | 'labels'

/** Cells of one column that couldn't be used: their cards are still added, without that value. */
export interface ImportProblem {
  column: string
  kind: ProblemKind
  /** Row numbers as the sheet has them (the first row is 1). */
  rows: number[]
  /** A few of the values, as written. */
  samples: string[]
}

export interface ImportReport {
  /** Cards that will be added, and how many of them go under another card. */
  cards: number
  subtasks: number
  /** Lists, labels and field options that will be made, by name. */
  lists: string[]
  labels: string[]
  options: { field: string; names: string[] }[]
  /** Rows left out: no title; a title that is already a card on the board (unless `addAnyway`). */
  noTitle: number[]
  duplicates: number[]
  problems: ImportProblem[]
  /** Dates that read both ways with nothing in their column to say which: `dateOrder` has to be said first. */
  askDateOrder?: { column: string; sample: string }
}

export type ImportCommand = Extract<Command, { type: 'tasks.import' }>

export interface ImportPlan {
  report: ImportReport
  command: ImportCommand
  /** Options to add to choice fields first: the cards' values already name them. */
  options: { fieldId: string; add: FieldOption[] }[]
}

/** New lists and labels one import can make: more than that, and the column is probably something else. */
export const IMPORT_NEW_LISTS = 30
export const IMPORT_NEW_LABELS = 100

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim()
const parts = (s: string, by: RegExp) =>
  s
    .split(by)
    .map((p) => p.trim())
    .filter(Boolean)

/** Reads the rows against the board. Throws, with words for the person, when the columns can't be used as said. */
export function planCardImport(data: BoardData, rows: string[][], opts: ImportOptions, look: ImportLookups): ImportPlan {
  const width = Math.max(0, ...rows.map((r) => r.length))
  const roles: ColumnRole[] = Array.from({ length: width }, (_, i) => opts.roles[i] ?? 'skip')
  const taken = roles.filter((r) => r !== 'skip')
  if (new Set(taken).size !== taken.length) throw new Error('Two columns are set to the same thing: each can only be used once.')
  const titleAt = roles.indexOf('title')
  if (titleAt === -1) throw new Error('Say which column is the title: every card needs one.')
  const fieldOf = new Map<number, BoardField>()
  roles.forEach((r, i) => {
    if (!isFieldKey(r)) return
    const f = data.fields.find((x) => x.id === fieldIdOf(r))
    if (!f) throw new Error('One of the columns is set to a field this board no longer has.')
    fieldOf.set(i, f)
  })
  const names = roles.map((r, i) => (opts.header && rows[0]?.[i]?.trim()) || (isFieldKey(r) ? fieldOf.get(i)!.name : ROLE_LABEL[r]))
  const body = rows.map((cells, i) => ({ n: i + 1, cells })).slice(opts.header ? 1 : 0)
  const filled = body.filter((r) => r.cells.some((c) => c.trim()))
  if (filled.length > IMPORT_MAX) throw new Error(`That’s more rows than can be added at once: ${IMPORT_MAX.toLocaleString('en')} at most.`)

  const report: ImportReport = { cards: 0, subtasks: 0, lists: [], labels: [], options: [], noTitle: [], duplicates: [], problems: [] }
  const flag = (column: number, kind: ProblemKind, row: number, sample: string) => {
    let p = report.problems.find((x) => x.column === names[column] && x.kind === kind)
    if (!p) report.problems.push((p = { column: names[column], kind, rows: [], samples: [] }))
    if (!p.rows.includes(row)) p.rows.push(row)
    const short = sample.length > 40 ? `${sample.slice(0, 39)}…` : sample
    if (p.samples.length < 3 && !p.samples.includes(short)) p.samples.push(short)
  }

  // Dates: which way round each column is written, settled from all its values.
  const isDate = (i: number) => roles[i] === 'due' || roles[i] === 'start' || fieldOf.get(i)?.type === 'date'
  const orderOf = new Map<number, DateOrder | undefined>()
  roles.forEach((_, i) => {
    if (!isDate(i)) return
    const values = filled.map((r) => r.cells[i] ?? '')
    const settled = dateOrderOf(values)
    if (settled === 'dmy' || settled === 'mdy') return orderOf.set(i, settled)
    // (A column that disagrees with itself: each date is read the only way it can be, the rest aren't read.)
    if (settled === 'mixed') return orderOf.set(i, undefined)
    const unsure = values.find(isAmbiguousDate)
    if (unsure && !opts.dateOrder) report.askDateOrder ??= { column: names[i], sample: unsure.trim() }
    orderOf.set(i, opts.dateOrder)
  })
  const thisYear = new Date(opts.now).getUTCFullYear()
  const dateOf = (i: number, text: string): string | null => {
    const read = readDate(text, orderOf.get(i), thisYear)
    if (!read) return null
    if (!read.time) return read.day
    const [h, m] = read.time.split(':').map(Number)
    return normalizeTaskDate(zoned(read.day, h, opts.zone, m).toISOString())
  }

  // What the board has, by name.
  const listOf = new Map(data.columns.map((c) => [nameKey(c.name), c.id]))
  const labelOf = new Map(data.labels.filter((l) => l.name.trim()).map((l) => [nameKey(l.name), l.id]))
  const newLists: NonNullable<ImportCommand['lists']> = []
  const newLabels: NonNullable<ImportCommand['labels']> = []
  const byName = new Map<string, string[]>()
  const byEmail = new Map<string, string>()
  for (const p of look.people) {
    byName.set(nameKey(p.name), [...(byName.get(nameKey(p.name)) ?? []), p.id])
    if (p.email) byEmail.set(p.email.trim().toLowerCase(), p.id)
  }
  const personOf = (text: string): string | null => {
    const t = text.trim()
    const named = byName.get(nameKey(t)) ?? []
    return byEmail.get(t.toLowerCase()) ?? (named.length === 1 ? named[0] : null)
  }
  const existing = new Map<string, string[]>()
  for (const t of Object.values(data.tasks)) existing.set(nameKey(t.title), [...(existing.get(nameKey(t.title)) ?? []), t.id])
  const newOptions = new Map<string, FieldOption[]>()

  /** A cell's value for one of the board's fields (undefined: nothing, or it couldn't be read and was flagged). */
  const valueOf = (i: number, f: BoardField, text: string, n: number): FieldValue | undefined => {
    const bad = (kind: ProblemKind) => {
      flag(i, kind, n, text)
      return undefined
    }
    switch (f.type) {
      case 'text': {
        const max = f.format === 'link' ? FIELD_LIMITS.link : FIELD_LIMITS.text
        if (text.length > max) flag(i, 'long', n, text)
        return text.slice(0, max)
      }
      case 'number':
        return readNumber(text) ?? bad('number')
      case 'date':
        return dateOf(i, text) ?? bad('date')
      case 'checkbox': {
        const yes = readYes(text)
        return yes === null ? bad('yes') : yes || undefined
      }
      case 'choice': {
        const key = nameKey(text)
        const added = newOptions.get(f.id) ?? []
        const has = (f.options ?? []).find((o) => !o.archived && nameKey(o.name) === key) ?? added.find((o) => nameKey(o.name) === key)
        if (has) return [has.id]
        const live = (f.options ?? []).filter((o) => !o.archived).length + added.length
        // (An option that was put away isn't made a second time: it can be brought back in the field's settings.)
        const putAway = (f.options ?? []).some((o) => o.archived && nameKey(o.name) === key)
        if (
          putAway ||
          !look.canAddOption(f.id) ||
          live >= FIELD_LIMITS.options ||
          (f.options?.length ?? 0) + added.length >= FIELD_LIMITS.options * 2
        )
          return bad('option')
        if (text.length > FIELD_LIMITS.name) return bad('option')
        const option: FieldOption = { id: opts.newId(), name: text, color: LABEL_COLOR_CYCLE[live % LABEL_COLOR_CYCLE.length] }
        newOptions.set(f.id, [...added, option])
        return [option.id]
      }
      case 'person': {
        const who = f.many ? parts(text, /[,;]/) : [text]
        const ids = who.flatMap((w) => personOf(w) ?? [])
        if (ids.length !== who.length) flag(i, 'person', n, text)
        const kept = [...new Set(ids)].slice(0, f.many ? FIELD_LIMITS.people : 1)
        return kept.length ? kept : undefined
      }
      case 'link': {
        const titles = look.linked?.get(f.id)
        const whole = titles?.get(nameKey(text))
        const wanted = whole || !f.many ? [text] : parts(text, text.includes(';') ? /;/ : /,/)
        const refs = wanted.flatMap((w) => {
          const hits = titles?.get(nameKey(w)) ?? []
          return hits.length === 1 ? hits : []
        })
        if (refs.length !== wanted.length) flag(i, 'link', n, text)
        const kept = [...new Set(refs)].slice(0, f.many ? FIELD_LIMITS.links : 1)
        return kept.length ? kept : undefined
      }
    }
  }

  interface Row {
    n: number
    id: string
    title: string
    parent?: { at: number; text: string }
    fields: TaskFields & { title: string }
  }
  const made: Row[] = []
  for (const { n, cells } of filled) {
    const cell = (i: number) => (cells[i] ?? '').trim()
    let title = oneLine(cell(titleAt))
    if (!title) {
      report.noTitle.push(n)
      continue
    }
    if (title.length > 500) {
      flag(titleAt, 'long', n, title)
      title = title.slice(0, 500)
    }
    if (!opts.addAnyway && existing.has(nameKey(title))) {
      report.duplicates.push(n)
      continue
    }
    const row: Row = { n, id: opts.newId(), title, fields: { title } }
    const custom: Record<string, FieldValue> = {}
    roles.forEach((role, i) => {
      const text = cell(i)
      if (!text || role === 'skip' || role === 'title') return
      const f = fieldOf.get(i)
      if (f) {
        const value = valueOf(i, f, text, n)
        if (value === undefined) return
        // (Checked as the field will be once the options this import adds are in it.)
        const def = newOptions.has(f.id) ? { ...f, options: [...(f.options ?? []), ...newOptions.get(f.id)!] } : f
        const checked = checkValue(def, value, false, { isMember: (u) => look.people.some((p) => p.id === u) })
        if ('value' in checked && checked.value !== undefined) custom[f.id] = checked.value
        return
      }
      switch (role) {
        case 'description':
          if (text.length > 50_000) flag(i, 'long', n, text)
          row.fields.description = (cells[i] ?? '').trim().slice(0, 50_000)
          break
        case 'list': {
          const name = oneLine(text).slice(0, 200)
          let id = listOf.get(nameKey(name))
          if (!id) {
            if (newLists.length >= IMPORT_NEW_LISTS) return flag(i, 'lists', n, text)
            id = opts.newId()
            const category: Category = guessCategory(name) ?? 'todo'
            newLists.push({ id, name, category })
            listOf.set(nameKey(name), id)
          }
          row.fields.status = id
          break
        }
        case 'due':
        case 'start': {
          const date = dateOf(i, text)
          if (date) row.fields[role] = date
          else flag(i, 'date', n, text)
          break
        }
        case 'labels': {
          const ids: string[] = []
          for (const raw of parts(text, /[,;|]/)) {
            const name = raw.slice(0, 200)
            let id = labelOf.get(nameKey(name))
            if (!id) {
              if (newLabels.length >= IMPORT_NEW_LABELS) {
                flag(i, 'labels', n, raw)
                continue
              }
              id = opts.newId()
              const color: ColorName = LABEL_COLOR_CYCLE[(data.labels.length + newLabels.length) % LABEL_COLOR_CYCLE.length]
              newLabels.push({ id, name, color })
              labelOf.set(nameKey(name), id)
            }
            if (!ids.includes(id)) ids.push(id)
          }
          if (ids.length) row.fields.labels = ids.slice(0, 200)
          break
        }
        case 'assignee': {
          const id = personOf(text)
          if (id) row.fields.assigneeId = id
          else flag(i, 'person', n, text)
          break
        }
        case 'priority': {
          const p = readPriority(text)
          if (p) row.fields.priority = p
          else flag(i, 'priority', n, text)
          break
        }
        case 'parent':
          row.parent = { at: i, text: oneLine(text) }
          break
      }
    })
    if (Object.keys(custom).length) row.fields.custom = custom
    made.push(row)
  }

  // Parents: a card of this sheet with that title, or one already on the board. More than one, and it isn't known which.
  const inSheet = new Map<string, Row[]>()
  for (const r of made) inSheet.set(nameKey(r.title), [...(inSheet.get(nameKey(r.title)) ?? []), r])
  const parentOf = new Map<string, string>()
  for (const r of made) {
    if (!r.parent) continue
    const key = nameKey(r.parent.text)
    const here = (inSheet.get(key) ?? []).filter((x) => x !== r)
    const there = existing.get(key) ?? []
    const id = here.length === 1 ? here[0].id : !here.length && there.length === 1 ? there[0] : null
    if (id) parentOf.set(r.id, id)
    else flag(r.parent.at, 'parent', r.n, r.parent.text)
  }
  // Parents before their subtasks, otherwise in the sheet's order; a loop (A under B under A) is cut where it closes.
  const rowOf = new Map(made.map((r) => [r.id, r]))
  const ordered: Row[] = []
  const state = new Map<string, 'open' | 'done'>()
  const visit = (r: Row) => {
    if (state.get(r.id) === 'done') return
    state.set(r.id, 'open')
    const up = rowOf.get(parentOf.get(r.id) ?? '')
    if (up && state.get(up.id) === 'open') {
      parentOf.delete(r.id)
      flag(r.parent!.at, 'parent', r.n, r.parent!.text)
    } else if (up) visit(up)
    state.set(r.id, 'done')
    ordered.push(r)
  }
  made.forEach(visit)

  const options = [...newOptions].map(([fieldId, add]) => ({ fieldId, add }))
  report.cards = ordered.length
  report.subtasks = ordered.filter((r) => parentOf.has(r.id)).length
  report.lists = newLists.map((l) => l.name)
  report.labels = newLabels.map((l) => l.name)
  report.options = options.map((o) => ({ field: data.fields.find((f) => f.id === o.fieldId)!.name, names: o.add.map((x) => x.name) }))
  return {
    report,
    options,
    command: {
      type: 'tasks.import',
      ...(newLists.length && { lists: newLists }),
      ...(newLabels.length && { labels: newLabels }),
      cards: ordered.map((r) => ({ id: r.id, parentId: parentOf.get(r.id) ?? null, fields: r.fields })),
    },
  }
}

const some = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** A problem in words: "Due date: 2 dates couldn’t be read". The rows are said by `rowsText`. */
export function problemText(p: ImportProblem): string {
  const n = p.rows.length
  const what: Record<ProblemKind, string> = {
    date: `${some(n, 'date')} couldn’t be read`,
    number: `${some(n, 'number')} couldn’t be read`,
    yes: `${some(n, 'value')} ${n === 1 ? 'isn’t' : 'aren’t'} yes or no`,
    person: `${some(n, 'name')} ${n === 1 ? 'isn’t someone' : 'aren’t people'} on this board`,
    priority: `${some(n, 'value')} ${n === 1 ? 'isn’t' : 'aren’t'} a priority (urgent, high, medium or low)`,
    option: `${some(n, 'value')} ${n === 1 ? 'isn’t one' : 'aren’t'} of this field’s options`,
    parent: `${some(n, 'parent card')} couldn’t be found (or more than one card has that title)`,
    link: `${some(n, 'card')} couldn’t be found (or more than one has that title)`,
    long: `${some(n, 'text')} too long to hold ${n === 1 ? 'is' : 'are'} shortened`,
    lists: `${some(n, 'row')} ${n === 1 ? 'names' : 'name'} more new lists than can be made at once (${IMPORT_NEW_LISTS})`,
    labels: `${some(n, 'row')} ${n === 1 ? 'names' : 'name'} more new labels than can be made at once (${IMPORT_NEW_LABELS})`,
  }
  return `${p.column}: ${what[p.kind]}`
}

/** "row 17", "rows 17 and 40", "rows 3, 4, 5, 6, 7 and 12 more". */
export function rowsText(rows: number[]): string {
  if (rows.length === 1) return `row ${rows[0]}`
  const shown = rows.slice(0, 5)
  const more = rows.length - shown.length
  return more ? `rows ${shown.join(', ')} and ${more.toLocaleString('en')} more` : `rows ${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}
