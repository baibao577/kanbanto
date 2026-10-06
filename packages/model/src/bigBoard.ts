import { LABEL_COLOR_CYCLE } from './colors'
import { fromDay, todayDay } from './dates'
import { linkRef, type BoardField, type CustomValues, type FieldOption, type FieldValue } from './fields'
import { positionsBetween } from './position'
import { emptyBoard } from './sample'
import { PRIORITIES, type BoardData, type LabelDef, type Member, type Task, type TaskMap } from './types'

/**
 * Big boards, made up: for measuring how the app holds up when a board has thousands of cards and many fields.
 *
 * `bigBoard` gives the same board for the same seed (on the same day: dates are spread around today), with lists,
 * labels, people, fields of every kind and a value for most of them on most cards. Nothing here is random in the
 * usual sense: a small generator of its own stands in for Math.random, so a slow case found once can be made again.
 */

/** A field as `bigFieldSpecs` describes it: what a library is asked to make, before it has ids. */
export type BigFieldSpec = Omit<BoardField, 'id' | 'options'> & { options?: Omit<FieldOption, 'id'>[] }

export interface BigBoardOptions {
  /** The same seed gives the same board. */
  seed?: number
  /** The board's id (a uuid, like every board's: its cards' links to each other name it). */
  boardId?: string
  name?: string
  /** Cards on the board. */
  cards?: number
  /** Archived cards, kept beside them. */
  archived?: number
  /** `nested`: about 5% of the cards are top level and the rest sit under them, three levels down at most. `flat`: none has a parent. */
  shape?: 'nested' | 'flat'
  /** The fields the board uses (20 at most). Left out: `bigFields`, twenty of them, of every kind. */
  fields?: BoardField[]
  /** The board's people: assignees and person fields are drawn from them. Left out: a dozen made-up people. */
  members?: { id: string; name: string }[]
  /**
   * Another board's cards, for links that leave this board (a link field that names that board, or one that takes
   * cards from anywhere in the space). Left out: 400 cards of a board that only exists as an id.
   */
  other?: { boardId: string; taskIds: string[] }
  /** How many cards hold a value for each field: 0.8 is four in five. */
  fill?: number
  /** What the cards are called: sentences about work, or names (for a board of companies). */
  titles?: 'work' | 'names'
  /** The day it is, as a day number (see dates.ts). Dates and timestamps are spread around it. */
  today?: number
}

export interface BigBoard {
  data: BoardData
  /**
   * One of the board's fields for each thing a measurement wants to sort, filter or edit by (undefined: the board has
   * none): the choice with the most options, a number that adds up, a link to one board, to the same board, and to
   * anywhere in the space, and the first field of each other kind.
   */
  pick: {
    text?: BoardField
    number?: BoardField
    date?: BoardField
    choice?: BoardField
    checkbox?: BoardField
    person?: BoardField
    toBoard?: BoardField
    toSame?: BoardField
    toSpace?: BoardField
  }
  /** How many different cards of other boards the cards on the board link to. */
  linksElsewhere: number
}

export const BIG_BOARD_ID = '0198c0de-0000-7000-8000-00000000b0a1'
export const BIG_OTHER_BOARD_ID = '0198c0de-0000-7000-8000-00000000c0c0'

const DAY_MS = 86_400_000
const PEOPLE = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jon', 'Kim', 'Lee']
const VERBS = ['Renew', 'Review', 'Draft', 'Send', 'Plan', 'Fix', 'Check', 'Update', 'Prepare', 'Follow up on', 'Close', 'Schedule']
const THINGS = [
  'contract',
  'proposal',
  'invoice',
  'onboarding',
  'pricing',
  'renewal',
  'demo',
  'report',
  'migration',
  'audit',
  'workshop',
  'handover',
  'budget',
  'roadmap',
  'survey',
  'launch',
]
const NAMES = [
  'Northwind',
  'Globex',
  'Acme',
  'Initech',
  'Umbra',
  'Hooli',
  'Vandelay',
  'Stark',
  'Wayne',
  'Wonka',
  'Tyrell',
  'Cyberdyne',
  'Soylent',
  'Aperture',
  'Monarch',
  'Pied Piper',
  'Oscorp',
  'Gringotts',
  'Duff',
  'Sirius',
]
const SUFFIXES = ['Traders', 'Group', 'Labs', 'Foods', 'Logistics', 'Studio', 'Partners', 'Works', 'Systems', 'Supply']
const WORDS = [
  'quarterly',
  'pilot',
  'north',
  'south',
  'retail',
  'wholesale',
  'priority',
  'legacy',
  'partner',
  'direct',
  'online',
  'regional',
  'annual',
  'trial',
  'key account',
  'referral',
  'inbound',
  'expansion',
]
const LABELS = ['bug', 'design', 'writing', 'sales', 'support', 'ops']

/**
 * Twenty fields of every kind, as a library would be asked for them: three numbers that add up, a choice with 50
 * options and a short one, a person field that holds several people and one that holds one, three card links (to
 * the board `otherBoardId`, to the same board, to any board of the space), text (two plain ones alike, "Contact" and
 * "Contact name", to merge; a link, an email, notes), three dates and two checkboxes.
 */
export function bigFieldSpecs(otherBoardId: string = BIG_OTHER_BOARD_ID): BigFieldSpec[] {
  const options = (n: number, name: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => ({ name: name(i), color: LABEL_COLOR_CYCLE[i % LABEL_COLOR_CYCLE.length] }))
  return [
    { name: 'Amount', type: 'number', unit: '$', decimals: 0, sum: true, front: true, total: true },
    { name: 'Hours', type: 'number', unit: 'h', decimals: 1, sum: true, total: true },
    { name: 'Seats', type: 'number', decimals: 0, sum: true, total: true },
    { name: 'Stage', type: 'choice', front: true, options: options(50, (i) => `Stage ${i + 1}`) },
    { name: 'Region', type: 'choice', options: options(6, (i) => ['North', 'South', 'East', 'West', 'Central', 'Abroad'][i]) },
    { name: 'Owners', type: 'person', many: true },
    { name: 'Reviewer', type: 'person' },
    { name: 'Company', type: 'link', linkTo: 'board', board: otherBoardId, back: 'Deals', front: true },
    { name: 'Related', type: 'link', linkTo: 'same', many: true },
    { name: 'See also', type: 'link', linkTo: 'space', many: true },
    { name: 'Contact', type: 'text' },
    { name: 'Contact name', type: 'text' },
    { name: 'Website', type: 'text', format: 'link' },
    { name: 'Email', type: 'text', format: 'email' },
    { name: 'Notes', type: 'text' },
    { name: 'Close date', type: 'date' },
    { name: 'Renewal', type: 'date' },
    { name: 'Kickoff', type: 'date' },
    { name: 'Signed', type: 'checkbox' },
    { name: 'Paid', type: 'checkbox' },
  ]
}

/** The same twenty with ids, as a board uses them (ids shaped like the real ones, and always the same). */
export function bigFields(otherBoardId: string = BIG_OTHER_BOARD_ID): BoardField[] {
  const id = (field: number, option = 0) => `0198c0de-f1e1-7000-8000-${field.toString(16).padStart(6, '0')}${option.toString(16).padStart(6, '0')}`
  return bigFieldSpecs(otherBoardId).map(({ options, ...spec }, i) => ({
    ...spec,
    id: id(i + 1),
    ...(options && { options: options.map((o, k) => ({ ...o, id: id(i + 1, k + 1) })) }),
  }))
}

/** A generator of numbers from 0 up to (not including) 1 that always gives the same run for the same seed (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function bigBoard(opts: BigBoardOptions = {}): BigBoard {
  const rand = seeded(opts.seed ?? 1)
  const int = (n: number) => Math.floor(rand() * n)
  const one = <T>(xs: readonly T[]): T => xs[int(xs.length)]
  const chance = (p: number) => rand() < p
  /** `n` different items of `xs` (fewer when it hasn't that many). */
  const some = <T>(xs: readonly T[], n: number): T[] => {
    const out = new Set<T>()
    for (let tries = 0; out.size < Math.min(n, xs.length) && tries < n * 8; tries++) out.add(one(xs))
    return [...out]
  }

  const boardId = opts.boardId ?? BIG_BOARD_ID
  const today = opts.today ?? todayDay()
  // (The start of yesterday, UTC: in the past in whatever time zone this runs, so no card is changed "later today".)
  const now = (today - 1) * DAY_MS
  const iso = (ms: number) => new Date(ms).toISOString()
  const nowIso = iso(now)
  const cards = opts.cards ?? 3000
  const fill = opts.fill ?? 0.8
  const other = opts.other ?? { boardId: BIG_OTHER_BOARD_ID, taskIds: Array.from({ length: 400 }, (_, i) => `c${i + 1}`) }
  const fields = (opts.fields ?? bigFields(other.boardId)).slice(0, 20)
  const base = emptyBoard(boardId, opts.name ?? 'Big board', nowIso)
  const meta = { createdAt: nowIso, updatedAt: nowIso, version: 1 }
  const members: Member[] = (opts.members ?? PEOPLE.map((name) => ({ id: `u-${name.toLowerCase()}`, name }))).map((m) => ({ ...m, ...meta }))
  const labels: LabelDef[] = LABELS.map((name, i) => ({ id: `l-${name}`, name, color: LABEL_COLOR_CYCLE[i], ...meta }))
  const people = members.map((m) => m.id)
  const lists = base.columns.map((c) => c.id)
  const done = new Set(base.columns.filter((c) => c.category === 'done').map((c) => c.id))

  /** An id shaped like a real card's (a uuid that starts with when it was made), from the generator. */
  const hex = (n: number) => Array.from({ length: n }, () => int(16).toString(16)).join('')
  const cardId = (made: number) => {
    const at = made.toString(16).padStart(12, '0')
    return `${at.slice(0, 8)}-${at.slice(8)}-7${hex(3)}-${one(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`
  }
  const title = () =>
    opts.titles === 'names' ? `${one(NAMES)} ${one(SUFFIXES)} ${1 + int(900)}` : `${one(VERBS)} the ${one(WORDS)} ${one(THINGS)} for ${one(NAMES)}`

  // The cards first, without their values: a link needs to know which cards there are.
  const total = cards + (opts.archived ?? 0)
  const roots = opts.shape === 'flat' ? cards : Math.max(1, Math.round(cards * 0.05))
  const list: Task[] = []
  const depth: number[] = []
  /** Cards that can still take a subtask (the third level down can't). */
  const open: number[] = []
  const kids = new Map<string, number[]>()
  for (let i = 0; i < total; i++) {
    const put = i >= cards
    // On the board: under one of the cards made before it. Archived: mostly on its own, sometimes under the one before.
    let parent = -1
    if (!put && i >= roots) parent = one(open)
    else if (put && i > cards && chance(0.2) && list[i - 1].parentId === null) parent = i - 1
    depth.push(parent < 0 ? 0 : depth[parent] + 1)
    if (!put && depth[i] < 3) open.push(i)
    const made = now - DAY_MS - int(180 * DAY_MS)
    const changed = made + int(now - made)
    const status = one(lists)
    const t: Task = {
      id: cardId(made),
      title: title(),
      parentId: parent < 0 ? null : list[parent].id,
      status,
      order: '',
      labels: chance(0.3) ? some(labels, chance(0.3) ? 2 : 1).map((l) => l.id) : [],
      blockedBy: [],
      createdAt: iso(made),
      updatedAt: iso(changed),
      version: 1 + int(6),
      activeAt: iso(changed),
    }
    if (chance(0.6) && people.length) t.assigneeId = one(people)
    if (chance(0.4)) t.priority = one(PRIORITIES)
    if (chance(0.35)) {
      const due = today - 30 + int(90)
      t.due = fromDay(due)
      if (chance(0.5)) t.start = fromDay(due - 1 - int(14))
    }
    if (chance(0.15)) t.description = Array.from({ length: 1 + int(3) }, () => `${title()}.`).join(' ')
    if (done.has(status)) t.doneAt = t.activeAt
    if (put) {
      // (Putting a card away is the last thing that happened to it.)
      const away = iso(changed + int(now - changed))
      Object.assign(t, { archivedAt: away, updatedAt: away, activeAt: away, archivedList: base.columns.find((c) => c.id === status)!.name })
      t.archivedDone = done.has(status)
    }
    list.push(t)
    const group = `${put ? 'put' : 'on'}:${t.parentId ?? ''}`
    const beside = kids.get(group)
    if (beside) beside.push(i)
    else kids.set(group, [i])
  }
  // Each card's place among the cards beside it, in the order they were made.
  for (const group of kids.values()) positionsBetween(null, null, group.length).forEach((key, k) => (list[group[k]].order = key))

  const active = list.slice(0, cards)
  if (cards > 1) for (const t of active) if (chance(0.02)) t.blockedBy = some(active, 1).flatMap((b) => (b.id === t.id ? [] : [b.id]))

  // A fifth of the links to another board go to its first ten cards: a few cards that many cards point at.
  const busy = other.taskIds.slice(0, 10)
  const elsewhere = () => linkRef(other.boardId, chance(0.2) ? one(busy) : one(other.taskIds))
  const here = (t: Task) => some(active, 1).flatMap((c) => (c.id === t.id ? [] : [linkRef(boardId, c.id)]))
  const round = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals
  const valueFor = (f: BoardField, t: Task): FieldValue | undefined => {
    switch (f.type) {
      case 'text':
        if (f.format === 'link') return `https://example.com/${one(THINGS)}/${1 + int(9000)}`
        if (f.format === 'email') return `${one(PEOPLE).toLowerCase()}.${one(THINGS)}@example.com`
        if (f.format === 'phone') return `+1 555 01${String(int(100)).padStart(2, '0')}`
        return `${one(NAMES)} ${one(WORDS)} ${one(THINGS)}`
      case 'number':
        return round(rand() * (f.decimals ? 200 : 20_000), f.decimals ?? 0)
      case 'date':
        return fromDay(today - 60 + int(121))
      case 'choice': {
        const pickable = (f.options ?? []).filter((o) => !o.archived)
        return pickable.length ? [one(pickable).id] : undefined
      }
      case 'checkbox':
        return true
      case 'person': {
        const who = some(people, f.many ? 1 + int(3) : 1)
        return who.length ? who : undefined
      }
      case 'link': {
        const n = f.many ? 1 + int(3) : 1
        const scope = f.linkTo ?? 'space'
        const refs = new Set<string>()
        for (let k = 0; k < n; k++) {
          if (scope === 'same' || (scope === 'board' && f.board === boardId)) here(t).forEach((r) => refs.add(r))
          else if (scope === 'board') {
            if (f.board === other.boardId && other.taskIds.length) refs.add(elsewhere())
          } else if (other.taskIds.length && chance(0.5)) refs.add(elsewhere())
          else here(t).forEach((r) => refs.add(r))
        }
        return refs.size ? [...refs] : undefined
      }
    }
  }
  const byId = [...fields].sort((a, b) => (a.id < b.id ? -1 : 1))
  const seen = new Set<string>()
  for (const [i, t] of list.entries()) {
    // (Keys in a fixed order, as stored values always are: see `tidyCustom`.)
    const custom: CustomValues = {}
    for (const f of byId) {
      if (!chance(fill)) continue
      const v = valueFor(f, t)
      if (v === undefined) continue
      custom[f.id] = v
      if (f.type === 'link' && i < cards) for (const ref of v as string[]) if (!ref.startsWith(`${boardId}:`)) seen.add(ref)
    }
    if (Object.keys(custom).length) t.custom = custom
  }

  const map = (xs: Task[]): TaskMap => Object.fromEntries(xs.map((t) => [t.id, t]))
  const first = (test: (f: BoardField) => boolean) => fields.find(test)
  const scope = (f: BoardField) => (f.type === 'link' ? (f.linkTo ?? 'space') : undefined)
  return {
    data: { ...base, members, labels, fields, tasks: map(active), ...(total > cards && { archived: map(list.slice(cards)) }) },
    pick: {
      text: first((f) => f.type === 'text' && !f.format),
      number: first((f) => f.type === 'number' && !!f.sum) ?? first((f) => f.type === 'number'),
      date: first((f) => f.type === 'date'),
      choice: fields.filter((f) => f.type === 'choice').sort((a, b) => (b.options?.length ?? 0) - (a.options?.length ?? 0))[0],
      checkbox: first((f) => f.type === 'checkbox'),
      person: first((f) => f.type === 'person' && !!f.many) ?? first((f) => f.type === 'person'),
      toBoard: first((f) => scope(f) === 'board'),
      toSame: first((f) => scope(f) === 'same'),
      toSpace: first((f) => scope(f) === 'space'),
    },
    linksElsewhere: seen.size,
  }
}
