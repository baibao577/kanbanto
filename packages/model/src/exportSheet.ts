import { dayIn, hasTime } from './dates'
import { linksOf, optionsOf, parseRef, peopleOf, type BoardField, type FieldValue, type TitleOf } from './fields'
import { indexFor } from './indexer'
import { refOf } from './refs'
import { PRIORITY_LABEL, type BoardData, type Task } from './types'

// A board's cards as the rows of a spreadsheet: one card to a row, for a report, a pivot table, an invoice.
//
// The columns that say what a card is are named the way the import of a spreadsheet reads them (importCards.ts:
// Title, Parent, List, Assignee, Priority, Start, Due, Labels, Description, and the board's own fields by name), and
// their cells are written the way it reads them (dates as 2026-10-15, a ticked box as Yes), so a sheet can be saved,
// changed and brought back. The rest are for reading: the card's number, the time logged on it, when it was made,
// changed, done and archived. The import leaves those out.

export interface SheetOptions {
  /** The time zone a time of day is written in (the person saving the file's). */
  zone: string
  /** Minutes logged on each card, by its id, where that is known: gives the "Time logged (hours)" column. */
  minutes?: Record<string, number>
  /** A linked card's title, where it isn't one of this board's own cards (the links of another board). */
  titleOf?: TitleOf
}

/** A date as a sheet has it: a whole day as 2026-10-15, a moment as "2026-10-15 14:30" by the clock of `zone`. */
export function sheetDate(value: string | undefined, zone: string): string {
  if (!value) return ''
  if (!hasTime(value)) return value
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  return `${dayIn(d, zone)} ${time}`
}

/** Hours with at most two decimals, as a plain number a spreadsheet adds up: 90 minutes is 1.5. */
const hours = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100)

/**
 * The rows for these cards (ids of cards on the board, or in its archive), in the order given, under one row of
 * column names. A subtask names its parent by title, so list a parent before its subtasks (the outline's order
 * does). The "Archived" column is only there when one of the cards is archived.
 */
export function cardsSheet(data: BoardData, ids: readonly string[], opts: SheetOptions): string[][] {
  const idx = indexFor(data)
  const all: Record<string, Task | undefined> = { ...data.archived, ...data.tasks }
  const cards = ids.flatMap((id) => all[id] ?? [])
  const anyArchived = cards.some((t) => t.archivedAt)
  const nameOf = (userId: string | undefined) => (userId ? (data.members.find((m) => m.id === userId)?.name ?? '') : '')
  const labelOf = new Map(data.labels.map((l) => [l.id, l.name]))
  const listOf = new Map(data.columns.map((c) => [c.id, c.name]))
  // (A card on the board shows in the list the board gives it: a parent may follow its subtasks. An archived one
  // names the list it was in when it was put away.)
  const list = (t: Task) => (t.archivedAt ? (t.archivedList ?? listOf.get(t.status) ?? '') : (listOf.get(idx.status.get(t.id) ?? t.status) ?? ''))
  const linked = (ref: string) => {
    const to = parseRef(ref)
    return (to && to.boardId === data.board.id ? all[to.taskId]?.title : undefined) ?? opts.titleOf?.(ref)
  }
  const field = (def: BoardField, value: FieldValue | undefined): string => {
    if (value === undefined || value === null) return ''
    switch (def.type) {
      case 'text':
        return typeof value === 'string' ? value : ''
      case 'date':
        return typeof value === 'string' ? sheetDate(value, opts.zone) : ''
      case 'number':
        return typeof value === 'number' ? String(value) : ''
      case 'checkbox':
        return value === true ? 'Yes' : ''
      case 'choice':
        return optionsOf(def, value)
          .map((o) => o.name)
          .join(', ')
      case 'person':
        return peopleOf(value).map(nameOf).filter(Boolean).join(', ')
      case 'link':
        return linksOf(value)
          .flatMap((ref) => linked(ref) ?? [])
          .join(', ')
      default:
        return ''
    }
  }
  const done = (t: Task) => {
    const at = t.archivedAt ? (t.archivedDone ? (t.doneAt ?? t.archivedAt) : undefined) : idx.doneAt.get(t.id)
    return at === undefined ? '' : sheetDate(new Date(at).toISOString(), opts.zone)
  }
  const header = [
    'Card number',
    'Title',
    'Parent',
    'List',
    'Assignee',
    'Priority',
    'Start',
    'Due',
    'Labels',
    ...data.fields.map((f) => f.name),
    'Description',
    ...(opts.minutes ? ['Time logged (hours)'] : []),
    'Created',
    'Updated',
    'Done on',
    ...(anyArchived ? ['Archived'] : []),
  ]
  const rows = cards.map((t) => [
    refOf(data.board, t) ?? '',
    t.title,
    (t.parentId && all[t.parentId]?.title) || '',
    list(t),
    nameOf(t.assigneeId),
    t.priority ? PRIORITY_LABEL[t.priority] : '',
    sheetDate(t.start, opts.zone),
    sheetDate(t.due, opts.zone),
    t.labels.flatMap((id) => labelOf.get(id) || []).join(', '),
    ...data.fields.map((f) => field(f, t.custom?.[f.id])),
    t.description ?? '',
    ...(opts.minutes ? [opts.minutes[t.id] ? hours(opts.minutes[t.id]) : ''] : []),
    sheetDate(t.createdAt, opts.zone),
    sheetDate(t.updatedAt, opts.zone),
    done(t),
    ...(anyArchived ? [sheetDate(t.archivedAt, opts.zone)] : []),
  ])
  return [header, ...rows]
}

/** The columns of `cardsSheet` whose cells are a card's own words or names: text that someone on the board typed. */
const TYPED = new Set(['Title', 'Parent', 'List', 'Assignee', 'Labels', 'Description'])

/**
 * Rows as the text of a .csv file: commas, cells in quotes where they hold a comma, a quote or a line break, lines
 * ended the way spreadsheets expect, and a mark at the start that tells Excel the text is UTF-8 (without it, Thai
 * and accented letters come out wrong there).
 *
 * `guard`: the columns (by their name in the first row) whose cells are text someone typed. A cell of theirs that
 * starts like a formula (= + - @) gets an apostrophe in front, which a spreadsheet shows as plain text instead of
 * working it out: a card titled "=HYPERLINK(…)" mustn't run in the spreadsheet of whoever opens the file.
 */
export function toCsv(rows: readonly (readonly string[])[], guard: (column: string) => boolean = () => false): string {
  const guarded = (rows[0] ?? []).map((name) => guard(name))
  const cell = (text: string, i: number, first: boolean) => {
    const safe = !first && guarded[i] && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
  }
  return `﻿${rows.map((r, n) => r.map((c, i) => cell(c, i, n === 0)).join(',')).join('\r\n')}\r\n`
}

/** A board's cards as a .csv file's text (see `cardsSheet` and `toCsv`): what people typed can't act as a formula. */
export function cardsCsv(data: BoardData, ids: readonly string[], opts: SheetOptions): string {
  const fields = new Set(
    data.fields.filter((f) => f.type === 'text' || f.type === 'choice' || f.type === 'person' || f.type === 'link').map((f) => f.name),
  )
  return toCsv(cardsSheet(data, ids, opts), (column) => TYPED.has(column) || fields.has(column))
}
