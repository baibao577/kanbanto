import type { ColorName } from './colors'
import { normalizeTaskDate, sortTime, toDay } from './dates'

/**
 * Custom fields: what a space's library defines, what a board uses, and what a card holds.
 *
 * A field is defined once, in the library of a workspace or of a person (for their Personal boards). A board picks
 * the fields it uses; a card holds a value per field id (`Task.custom`). This file is the one place that knows the
 * types: everything else asks here how to check a value, show it, compare it, or carry it over to another field.
 */
export const FIELD_TYPES = ['text', 'number', 'date', 'choice', 'checkbox', 'link', 'person'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  choice: 'Choice',
  checkbox: 'Checkbox',
  link: 'Card link',
  person: 'Person',
}
export const FIELD_TYPE_HINT: Record<FieldType, string> = {
  text: 'A few words, a link, an email or a phone number',
  number: 'An amount, with a unit if you like',
  date: 'A day, with a time if it matters',
  choice: 'One of the options you list',
  checkbox: 'Yes or no',
  link: 'Another card: a company, a contact, a related task',
  person: 'Someone on the board: a reviewer, an account owner',
}

/** How a text field's value is shown (it never refuses what's already there). */
export const TEXT_FORMATS = ['plain', 'link', 'email', 'phone'] as const
export type TextFormat = (typeof TEXT_FORMATS)[number]

/** One thing a choice field can be. An archived option stays on the cards that have it, but can't be picked. */
export interface FieldOption {
  id: string
  name: string
  color: ColorName
  archived?: boolean
}

/**
 * Where a card link's cards come from: one board (`FieldSettings.board`), any board of the field's space, or the
 * board that uses the field (each board links within itself: "Related to").
 */
export const LINK_SCOPES = ['board', 'space', 'same'] as const
export type LinkScope = (typeof LINK_SCOPES)[number]

/**
 * What a field's type lets you set: text has a format, a number a unit and decimals, a choice its options, a card
 * link where its cards come from and how many it holds, a person whether it holds one or several.
 */
export interface FieldSettings {
  format?: TextFormat
  unit?: string
  decimals?: number
  /** Numbers that make sense added up (a parent's subtasks, a list). */
  sum?: boolean
  options?: FieldOption[]
  /** A card link: where its cards come from (any board of the space, when not said). */
  linkTo?: LinkScope
  /** The board they come from, for `linkTo: 'board'`. One that's gone leaves the field with nothing to pick from. */
  board?: string
  /** A card link that holds several cards, not one; a person field that holds several people. */
  many?: boolean
  /** What the list of cards pointing at a card is called on that card ("Deals"). */
  back?: string
}

/** A field, as its library defines it. Its type never changes. */
export interface FieldDef extends FieldSettings {
  id: string
  name: string
  type: FieldType
}

/**
 * A field a board uses, in the board's order. `front`: shown on the card front too. `total`: a number that adds up,
 * whose total shows under each list's name on the Board.
 */
export interface BoardField extends FieldDef {
  front?: boolean
  total?: boolean
}

/** A field's column in the Outline, and what it's sorted by: "f:" and the field's id. */
export type FieldKey = `f:${string}`
export const fieldKey = (id: string): FieldKey => `f:${id}`
export const isFieldKey = (key: string): key is FieldKey => key.startsWith('f:')
export const fieldIdOf = (key: FieldKey) => key.slice(2)

/**
 * What a card holds for a field: text, a number, a date (a day or a moment, like `due`), true for a ticked checkbox,
 * a list of option ids for a choice, a list of links for a card link (see `linkRef`), or a list of people (their
 * ids) for a person. Empty is never stored: no value is no key.
 */
export type FieldValue = string | number | boolean | string[]
export type CustomValues = Record<string, FieldValue>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A link to a card: its board's id, a colon, its own id. Always with the board, even for a card on the same one: a
 * card's id is only unique on its board, and it gets a new one when it moves to another.
 */
export const linkRef = (boardId: string, taskId: string) => `${boardId}:${taskId}`

/** The board and card a link names, or null when it isn't one. (A board's id has no colon; a card's may.) */
export function parseRef(ref: string): { boardId: string; taskId: string } | null {
  const at = ref.indexOf(':')
  if (at < 1 || at === ref.length - 1 || ref.length > FIELD_LIMITS.ref) return null
  const boardId = ref.slice(0, at)
  return UUID.test(boardId) ? { boardId, taskId: ref.slice(at + 1) } : null
}

/** The links a value holds (none, for anything that isn't a list). */
export const linksOf = (value: FieldValue | undefined): string[] => (Array.isArray(value) ? value : [])

/** The people a value holds, by id (none, for anything that isn't a list). */
export const peopleOf = linksOf

/**
 * Looks up what one item of a list value is called: a linked card's title, a person's name (undefined: not known, or
 * not for this reader to see). One lookup serves both: a link has a colon in it and a person's id doesn't.
 */
export type TitleOf = (item: string) => string | undefined

/** A person's id, as far as its shape goes (whether they're on the board is for whoever knows its people). */
const isPersonId = (id: string) => id.length > 0 && id.length <= 100 && !id.includes(':')

/** What someone who is no longer on the board reads as, wherever a name would be. */
export const SOMEONE_GONE = 'someone who left'

export const FIELD_LIMITS = {
  /** Fields in use in one library, and archived ones kept beside them. */
  perSpace: 50,
  archived: 100,
  perBoard: 20,
  front: 3,
  /** Fields whose total shows under a list's name. */
  totals: 3,
  options: 50,
  name: 60,
  unit: 8,
  text: 500,
  link: 2000,
  /** Values one card can hold. */
  values: 50,
  /** Cards one card link can hold, and how long one link can be (two ids and a colon). */
  links: 20,
  ref: 240,
  /** People one person field can hold. */
  people: 20,
}

/** Names a field can't take: the things every card already has. */
const RESERVED = [
  'title',
  'name',
  'status',
  'list',
  'parent',
  'assignee',
  'priority',
  'start',
  'due',
  'reminders',
  'time',
  'labels',
  'description',
  'subtasks',
  'progress',
  'comments',
  'files',
]

/** What two names are compared by: same letters, whatever the case or the spaces around. */
export const nameKey = (name: string) => name.trim().normalize('NFC').toLowerCase()

/** Why a field (or option) can't be called this, or null if it can. */
export function nameProblem(name: string, what: 'field' | 'option' = 'field'): string | null {
  const n = name.trim()
  if (!n) return `A${what === 'option' ? 'n' : ''} ${what} needs a name.`
  if (n.length > FIELD_LIMITS.name) return `That name is too long (${FIELD_LIMITS.name} characters at most).`
  if (what === 'field' && RESERVED.includes(nameKey(n))) return `Every card already has “${n}”: pick another name.`
  return null
}

export type Checked = { value: FieldValue | undefined } | { error: string }

const DATE_HINT = 'Dates look like 2026-10-31, or 2026-10-31T14:30:00Z with a time.'

/**
 * What checking a value needs to know about where it's being set: the board and card, what the card held before,
 * whether a card is on this board (card links) and whether someone is one of its people (person fields). All
 * optional: without them only the value's shape is checked.
 */
export interface ValueContext {
  boardId?: string
  taskId?: string
  held?: FieldValue
  exists?: (taskId: string) => boolean
  isMember?: (userId: string) => boolean
}

/**
 * Checks a value for a field and tidies it. `undefined` means empty (the key goes). Lenient is for values that were
 * valid once (undo, an imported file): an archived option is kept, and what no longer fits is dropped, not refused.
 *
 * A card link is only half checked here, with what one board knows: its shape, how many, the right board for a
 * field that names one, and that a card on this board exists. Whether a card on ANOTHER board exists, is in the same
 * space and may be opened is for the server (see `checkLinks` there). Links the card already held are never refused.
 *
 * A person has to be one of the board's people (`ctx.isMember`). Someone new who isn't is refused; someone the card
 * already held who has left since is quietly dropped, so the others can still be changed.
 */
export function checkValue(def: FieldDef, raw: unknown, lenient = false, ctx: ValueContext = {}): Checked {
  if (raw === null || raw === undefined) return { value: undefined }
  switch (def.type) {
    case 'text': {
      if (typeof raw !== 'string') return { error: 'That isn’t text.' }
      const v = raw.trim()
      const max = lenient || def.format === 'link' ? FIELD_LIMITS.link : FIELD_LIMITS.text
      if (v.length > max) return { error: `That’s too long (${max} characters at most).` }
      if (v.includes('\u0000')) return { error: 'Text can’t contain NUL characters.' }
      return { value: v || undefined }
    }
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 1e15) return { error: 'That isn’t a number.' }
      return { value: raw }
    case 'date': {
      if (typeof raw !== 'string') return { error: DATE_HINT }
      if (!raw) return { value: undefined }
      const v = normalizeTaskDate(raw)
      return v ? { value: v } : { error: DATE_HINT }
    }
    case 'choice': {
      const ids =
        typeof raw === 'string' ? [raw] : Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? [...new Set(raw as string[])] : null
      if (!ids) return { error: 'Pick one of its options.' }
      const options = def.options ?? []
      const known = ids.filter((id) => options.some((o) => o.id === id))
      if (lenient) return { value: known.length ? known.slice(0, 1) : undefined }
      if (known.length !== ids.length) return { error: 'That option no longer exists.' }
      if (known.length > 1) return { error: 'Pick one option.' }
      const gone = options.find((o) => o.id === known[0] && o.archived)
      if (gone) return { error: `“${gone.name}” can’t be picked any more.` }
      return { value: known.length ? known : undefined }
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') return { error: 'That’s either on or off.' }
      return { value: raw || undefined }
    case 'link': {
      const refs =
        typeof raw === 'string' ? [raw] : Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? [...new Set(raw as string[])] : null
      if (!refs) return { error: 'Pick a card.' }
      const known = refs.filter((r) => parseRef(r))
      // (Every well-formed link is kept: whether its card is still there is found out when it's shown.)
      if (lenient) return { value: known.length ? known.slice(0, FIELD_LIMITS.links) : undefined }
      if (known.length !== refs.length) return { error: 'That isn’t a card.' }
      if (known.length > FIELD_LIMITS.links) return { error: `That’s too many cards (${FIELD_LIMITS.links} at most).` }
      const held = new Set(linksOf(ctx.held))
      const added = known.filter((r) => !held.has(r))
      if (!def.many && known.length > 1 && added.length) return { error: 'This field holds one card.' }
      for (const r of added) {
        const { boardId, taskId } = parseRef(r)!
        const here = ctx.boardId !== undefined && boardId === ctx.boardId
        if (def.linkTo === 'same' && ctx.boardId !== undefined && !here) return { error: 'This field links cards on the same board.' }
        if (def.linkTo === 'board' && boardId !== def.board) return { error: 'That card isn’t on the board this field links to.' }
        if (here && taskId === ctx.taskId) return { error: 'A card can’t link to itself.' }
        if (here && ctx.exists && !ctx.exists(taskId)) return { error: 'That card isn’t on this board any more.' }
      }
      return { value: known.length ? known : undefined }
    }
    case 'person': {
      const ids =
        typeof raw === 'string' ? [raw] : Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? [...new Set(raw as string[])] : null
      if (!ids) return { error: 'Pick someone on this board.' }
      const shaped = ids.filter(isPersonId)
      const here = ctx.isMember ? shaped.filter(ctx.isMember) : shaped
      if (lenient) return { value: here.length ? here.slice(0, FIELD_LIMITS.people) : undefined }
      if (shaped.length !== ids.length) return { error: 'That isn’t a person.' }
      const held = new Set(peopleOf(ctx.held))
      const added = shaped.filter((id) => !held.has(id))
      if (ctx.isMember && added.some((id) => !ctx.isMember!(id))) return { error: 'That person isn’t on this board.' }
      if (!def.many && here.length > 1 && added.length) return { error: 'This field holds one person.' }
      if (here.length > FIELD_LIMITS.people) return { error: `That’s too many people (${FIELD_LIMITS.people} at most).` }
      return { value: here.length ? here : undefined }
    }
  }
}

/**
 * A value as someone typed or said it (an assistant, a text box): a number written as text, an option by its name,
 * "yes" for a checkbox. Checked like any new value.
 */
export function parseValue(def: FieldDef, input: string | number | boolean | null): Checked {
  if (input === null || input === '') return { value: undefined }
  switch (def.type) {
    case 'text':
      return checkValue(def, String(input))
    case 'number': {
      const n = typeof input === 'number' ? input : typeof input === 'string' ? Number(input.replace(/[,\s]/g, '')) : NaN
      return checkValue(def, n)
    }
    case 'date':
      return checkValue(def, String(input))
    case 'choice': {
      const key = nameKey(String(input))
      const options = (def.options ?? []).filter((o) => !o.archived)
      const hit = options.find((o) => o.id === input) ?? options.find((o) => nameKey(o.name) === key)
      if (!hit) return { error: `There’s no option “${input}”. The options are: ${options.map((o) => o.name).join(', ') || 'none yet'}.` }
      return { value: [hit.id] }
    }
    case 'checkbox': {
      if (typeof input === 'boolean') return { value: input || undefined }
      const key = String(input).trim().toLowerCase()
      if (['yes', 'true', 'on', '1'].includes(key)) return { value: true }
      if (['no', 'false', 'off', '0'].includes(key)) return { value: undefined }
      return { error: 'That’s either yes or no.' }
    }
    case 'link':
      // (One link, as it's stored. A card said by its title is looked up by whoever can see the other boards.)
      return checkValue(def, String(input))
    case 'person':
      // (One person, by id. Someone said by name is looked up by whoever knows the board's people.)
      return checkValue(def, String(input))
  }
}

/** The options a value names, in the field's order (ones that are gone are left out). */
export const optionsOf = (def: FieldDef, value: FieldValue | undefined): FieldOption[] =>
  Array.isArray(value) ? (def.options ?? []).filter((o) => value.includes(o.id)) : []

/** A number with its decimals and unit: "฿12,000", "50%", "3.5 h". */
export function numberText(def: Pick<FieldDef, 'unit' | 'decimals'>, n: number): string {
  const d = def.decimals
  const text = new Intl.NumberFormat(
    'en-US',
    d === undefined ? { maximumFractionDigits: 6 } : { minimumFractionDigits: d, maximumFractionDigits: d },
  ).format(n)
  const unit = def.unit?.trim()
  if (!unit) return text
  if (/^\p{Sc}$/u.test(unit)) return `${unit}${text}`
  return unit === '%' ? `${text}%` : `${text} ${unit}`
}

/**
 * A value in words, for the activity log and anywhere that just reads it out. A card link reads as its cards' titles
 * when `titleOf` knows them all, and never as the links themselves: otherwise "a card", "3 cards". People read as
 * their names, and never as their ids: one `titleOf` doesn't know is "someone who left".
 */
export function valueText(def: FieldDef, value: FieldValue, titleOf?: TitleOf): string {
  switch (def.type) {
    case 'text':
    case 'date':
      return typeof value === 'string' ? value : ''
    case 'number':
      return typeof value === 'number' ? numberText(def, value) : ''
    case 'choice':
      return optionsOf(def, value)
        .map((o) => o.name)
        .join(', ')
    case 'checkbox':
      return 'yes'
    case 'link': {
      const refs = linksOf(value)
      const titles = refs.flatMap((r) => titleOf?.(r) ?? [])
      return titles.length === refs.length && refs.length ? titles.join(', ') : refs.length === 1 ? 'a card' : `${refs.length} cards`
    }
    case 'person':
      return peopleOf(value)
        .map((id) => titleOf?.(id) ?? SOMEONE_GONE)
        .join(', ')
    default:
      // (A kind this code doesn't know: say nothing rather than print what it holds.)
      return ''
  }
}

/** A value for programs (assistants, the API by name): names instead of ids, the rest as stored. */
export function valuePlain(def: FieldDef, value: FieldValue, titleOf?: TitleOf): string | number | boolean {
  if (def.type === 'choice' || def.type === 'link' || def.type === 'person' || Array.isArray(value)) return valueText(def, value, titleOf)
  return value
}

/**
 * Orders two values of a field. Empty always goes last (the caller flips the rest for descending). Card links go by
 * the first card's title (`titleOf`), people by the first person's name; one that isn't known is like none at all.
 */
export function compareValues(def: FieldDef, a: FieldValue | undefined, b: FieldValue | undefined, titleOf?: TitleOf): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  switch (def.type) {
    case 'link': {
      const [ta, tb] = [a, b].map((v) => titleOf?.(linksOf(v)[0] ?? ''))
      if (ta === undefined || tb === undefined) return ta === tb ? 0 : ta === undefined ? 1 : -1
      return ta.localeCompare(tb)
    }
    case 'person': {
      const first = (v: FieldValue) => peopleOf(v).flatMap((id) => titleOf?.(id) ?? [])[0]
      const [ta, tb] = [first(a), first(b)]
      if (ta === undefined || tb === undefined) return ta === tb ? 0 : ta === undefined ? 1 : -1
      return ta.localeCompare(tb)
    }
    case 'number':
      return (a as number) - (b as number)
    case 'date':
      return sortTime(a as string) - sortTime(b as string)
    case 'choice': {
      // By the options' order. An option that's gone is like no option at all: last.
      const at = (v: FieldValue) => (def.options ?? []).findIndex((o) => Array.isArray(v) && v.includes(o.id))
      const [ia, ib] = [at(a), at(b)]
      if (ia < 0 || ib < 0) return ia === ib ? 0 : ia < 0 ? 1 : -1
      return ia - ib
    }
    case 'checkbox':
      return 0
    case 'text':
      return String(a).localeCompare(String(b))
    default:
      return 0
  }
}

export const sameValue = (a: FieldValue | undefined, b: FieldValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Values with their keys in a fixed order, so the same values always read (and compare) the same. */
const sorted = (values: CustomValues): CustomValues | undefined => {
  const keys = Object.keys(values).sort()
  return keys.length ? Object.fromEntries(keys.map((k) => [k, values[k]])) : undefined
}

/**
 * A card's values, kept to the fields its board uses and to what still fits them (see `checkValue`, lenient).
 * For records that come back from somewhere: undo, un-archiving, a file. `isMember`: who is on the board, so a
 * person field keeps only them (without it, as for a file whose people aren't known yet, every id is kept).
 */
export function tidyCustom(custom: CustomValues | undefined, fields: FieldDef[], isMember?: (userId: string) => boolean): CustomValues | undefined {
  if (!custom) return undefined
  const out: CustomValues = {}
  for (const f of fields) {
    if (!(f.id in custom)) continue
    const r = checkValue(f, custom[f.id], true, { isMember })
    if ('value' in r && r.value !== undefined) out[f.id] = r.value
  }
  return sorted(out)
}

/**
 * A card's values after an edit: `patch` sets the fields it names (null clears one) and leaves the others. Every
 * field named has to be one the board uses, and every value has to fit it.
 */
export function patchCustom(
  fields: FieldDef[],
  current: CustomValues | undefined,
  patch: Record<string, FieldValue | null>,
  where: Omit<ValueContext, 'held'> = {},
): { custom: CustomValues | undefined } | { error: string } {
  const out: CustomValues = { ...current }
  for (const [id, raw] of Object.entries(patch)) {
    const def = fields.find((f) => f.id === id)
    if (!def) return { error: 'That field is no longer on this board.' }
    const r = checkValue(def, raw, false, { ...where, held: current?.[id] })
    if ('error' in r) return { error: `${def.name}: ${r.error}` }
    if (r.value === undefined) delete out[id]
    else out[id] = r.value
  }
  if (Object.keys(out).length > FIELD_LIMITS.values) return { error: 'That’s more values than one card can hold.' }
  return { custom: sorted(out) }
}

/**
 * Where a field's values go when they're carried to another set of fields: the field there, its options, and
 * whether it's a card link or a person field (whose items may need changing on the way: see `carryCustom`).
 */
export type FieldMap = Map<string, { id: string; options?: Map<string, string>; link?: boolean; people?: boolean }>

/** What a field's kind adds to its `FieldMap` entry. */
const kindOf = (f: FieldDef) => ({ ...(f.type === 'link' && { link: true }), ...(f.type === 'person' && { people: true }) })

/** What happens to the items of list values on the way (see `carryCustom`). */
export interface CarryOn {
  /** What each link of a card link becomes on the other side: the same link, another one, or null (it can't come along). */
  relink?: (ref: string) => string | null
  /** Whether someone in a person field is one of the people on the other side (those who aren't stay behind). */
  isMember?: (userId: string) => boolean
}

/** A card's values carried over by a `FieldMap`: what has nowhere to go is left behind. */
export function carryCustom(custom: CustomValues | undefined, map: FieldMap, on: CarryOn = {}): CustomValues | undefined {
  if (!custom) return undefined
  const out: CustomValues = {}
  for (const [id, v] of Object.entries(custom)) {
    const to = map.get(id)
    if (!to) continue
    if (Array.isArray(v) && to.options) {
      const next = v.flatMap((o) => (to.options!.has(o) ? [to.options!.get(o)!] : []))
      if (next.length) out[to.id] = next
    } else if (Array.isArray(v) && to.link && on.relink) {
      const next = [...new Set(v.flatMap((r) => on.relink!(r) ?? []))]
      if (next.length) out[to.id] = next
    } else if (Array.isArray(v) && to.people && on.isMember) {
      const next = v.filter(on.isMember)
      if (next.length) out[to.id] = next
    } else out[to.id] = v
  }
  return sorted(out)
}

/** How many people a card's person fields would leave behind when carried by `map` to where `isMember` says who is. */
export function peopleLeftBehind(custom: CustomValues | undefined, map: FieldMap, isMember: (userId: string) => boolean): number {
  let n = 0
  for (const [id, v] of Object.entries(custom ?? {})) if (map.get(id)?.people) n += peopleOf(v).filter((p) => !isMember(p)).length
  return n
}

/**
 * A card's values with every link of its card links put through `change` (the same link, another one, or null: it
 * goes). `links`: the ids of the fields that are card links. The same object comes back when nothing changed.
 */
export function mapLinks(
  custom: CustomValues | undefined,
  links: ReadonlySet<string>,
  change: (ref: string) => string | null,
): CustomValues | undefined {
  if (!custom) return undefined
  let out: CustomValues | null = null
  for (const [id, v] of Object.entries(custom)) {
    if (!links.has(id) || !Array.isArray(v)) continue
    const next = [...new Set(v.flatMap((r) => change(r) ?? []))]
    if (next.length === v.length && next.every((r, i) => r === v[i])) continue
    out ??= { ...custom }
    if (next.length) out[id] = next
    else delete out[id]
  }
  return out ? sorted(out) : custom
}

/**
 * How one choice field's options map onto another's: the option of the same name, else the very same option under
 * another name (by id, when no other option was matched to it: two unrelated options can share an id).
 * Only onto options that can still be picked, unless `shelved`: then archived ones count too, so a value arrives on
 * the archived option it already was (greyed, as on any card that has one) and no second option of that name is made.
 */
function optionMap(from: FieldDef, to: FieldDef, shelved = false): Map<string, string> {
  const map = new Map<string, string>()
  const there = (to.options ?? []).filter((x) => shelved || !x.archived)
  const taken = new Set<string>()
  const match = (o: FieldOption, hit: FieldOption | undefined) => {
    if (!hit) return
    map.set(o.id, hit.id)
    taken.add(hit.id)
  }
  for (const o of from.options ?? [])
    match(o, there.find((x) => !x.archived && nameKey(x.name) === nameKey(o.name)) ?? there.find((x) => nameKey(x.name) === nameKey(o.name)))
  for (const o of from.options ?? [])
    if (!map.has(o.id))
      match(
        o,
        there.find((x) => x.id === o.id && !taken.has(x.id)),
      )
  return map
}

/**
 * Where one board's fields go on another board (a card moving between them): the same field if that board uses it,
 * else a field there with the same name and type. `unmatched`: the ones with nowhere to go. A card link only goes to
 * the very same field: one that's merely named alike belongs to another space, and links never cross spaces.
 */
export function matchFields(from: FieldDef[], to: FieldDef[]): { map: FieldMap; unmatched: FieldDef[] } {
  const map: FieldMap = new Map()
  const unmatched: FieldDef[] = []
  for (const f of from) {
    const same = to.find((t) => t.id === f.id)
    const alike = same ?? (f.type === 'link' ? undefined : to.find((t) => t.type === f.type && nameKey(t.name) === nameKey(f.name)))
    if (same) map.set(f.id, { id: same.id, ...kindOf(f) })
    else if (alike) map.set(f.id, { id: alike.id, ...kindOf(f), ...(f.type === 'choice' && { options: optionMap(f, alike) }) })
    else unmatched.push(f)
  }
  return { map, unmatched }
}

/** A field in a library, for deciding what happens to fields that arrive from somewhere else. */
export interface LibraryField extends FieldDef {
  archived?: boolean
}

/** What bringing fields into a library would do: nothing is changed by working this out. */
export interface Adoption {
  map: FieldMap
  /** Fields to add to the library, as they'd be added (new ids; a taken name gets a number after it). */
  add: FieldDef[]
  /** Options to add to choice fields the library already has. */
  addOptions: Map<string, FieldOption[]>
  /** What can't come along, in words: a field's name, or "Stage: Won" for one option. */
  lose: string[]
}

/**
 * Brings fields into another library (a board moving to another space, a file being imported). A field the library
 * has under the same name and type is used as it is; the rest are added when `canAdd` (the person manages that
 * library) and there's `room`, otherwise their values can't come along.
 *
 * A card link that's added keeps the board its cards come from only when that is the board arriving (`self`, under
 * the id it has there): any other board is in the space left behind, and the field is added with none to pick from.
 */
export function planAdoption(
  library: LibraryField[],
  incoming: FieldDef[],
  opts: { canAdd: boolean; room: number; newId: () => string; self?: { was: string; is: string } },
): Adoption {
  const plan: Adoption = { map: new Map(), add: [], addOptions: new Map(), lose: [] }
  let room = opts.room
  const taken = new Set(library.map((l) => nameKey(l.name)))
  const free = (name: string) => {
    if (!taken.has(nameKey(name))) return name
    for (let n = 2; ; n++) if (!taken.has(nameKey(`${name} (${n})`))) return `${name} (${n})`
  }
  for (const f of incoming) {
    const own = library.find((l) => l.id === f.id && !l.archived)
    // The field of that name and type; failing that, one this gave a number to last time ("Value (2)"), so bringing
    // the same fields in twice doesn't add them twice.
    const alike = library.filter((l) => !l.archived && l.type === f.type)
    const named =
      own ?? alike.find((l) => nameKey(l.name) === nameKey(f.name)) ?? alike.find((l) => nameKey(l.name).replace(/ \(\d+\)$/, '') === nameKey(f.name))
    if (own) {
      plan.map.set(f.id, { id: own.id, ...kindOf(f) })
      continue
    }
    if (named) {
      if (f.type !== 'choice') {
        plan.map.set(f.id, { id: named.id, ...kindOf(f) })
        continue
      }
      // (An option the library archived is the one a value goes to: never a second option of the same name.)
      const options = optionMap(f, named, true)
      const missing = (f.options ?? []).filter((o) => !o.archived && !options.has(o.id))
      const has = named.options ?? []
      const fits =
        has.filter((o) => !o.archived).length + missing.length <= FIELD_LIMITS.options && has.length + missing.length <= FIELD_LIMITS.options * 2
      if (missing.length && opts.canAdd && fits) {
        const used = new Set((named.options ?? []).map((o) => o.id))
        const added = missing.map((o) => ({ id: used.has(o.id) ? opts.newId() : o.id, name: o.name, color: o.color }))
        plan.addOptions.set(named.id, added)
        missing.forEach((o, i) => options.set(o.id, added[i].id))
      } else for (const o of missing) plan.lose.push(`${f.name}: ${o.name}`)
      plan.map.set(f.id, { id: named.id, options })
      continue
    }
    // (A field nobody could make by hand, "Priority", isn't made this way either.)
    if (!opts.canAdd || room <= 0 || nameProblem(f.name)) {
      plan.lose.push(f.name)
      continue
    }
    room--
    const name = free(f.name)
    taken.add(nameKey(name))
    const { id: _old, board, ...rest } = f
    const added: FieldDef = { ...rest, id: opts.newId(), name, ...(board !== undefined && board === opts.self?.was && { board: opts.self.is }) }
    plan.add.push(added)
    plan.map.set(f.id, { id: added.id, ...kindOf(f) })
  }
  return plan
}

/** What making a board from a starter would do to a library: nothing is changed by working this out. */
export interface StarterPlan {
  map: FieldMap
  /** Fields to add to the library, as they'd be added (new ids; a taken name gets a number after it). */
  add: FieldDef[]
  /** The starter's fields that the library has archived: they stay off the new board. */
  leftOut: string[]
  /** Fields that would have to be added and can't be. */
  cant: string[]
  /** Why they can't: the person doesn't manage the library, or it's full. */
  why?: 'manage' | 'room'
}

/**
 * Fits a starter's fields to a library. A field the library has under that name and kind is used as it is, and never
 * changed (a choice's options are matched by name, then by id; an example value for an option that isn't there just
 * doesn't arrive). One it has archived is left out: someone put it away. The rest are added, when `canAdd` (the
 * person manages the library) and there's `room`: otherwise the board can't be made (`cant`).
 */
export function planStarter(library: LibraryField[], wanted: FieldDef[], opts: { canAdd: boolean; room: number; newId: () => string }): StarterPlan {
  const plan: StarterPlan = { map: new Map(), add: [], leftOut: [], cant: [] }
  let room = opts.room
  const taken = new Set(library.map((l) => nameKey(l.name)))
  for (const f of wanted) {
    const alike = library.filter((l) => l.type === f.type)
    const active = alike.filter((l) => !l.archived)
    // (The second look finds a field this added before under a numbered name, "Customer (2)".)
    const named =
      active.find((l) => nameKey(l.name) === nameKey(f.name)) ?? active.find((l) => nameKey(l.name).replace(/ \(\d+\)$/, '') === nameKey(f.name))
    if (named) {
      plan.map.set(f.id, { id: named.id, ...kindOf(f), ...(f.type === 'choice' && { options: optionMap(f, named) }) })
      continue
    }
    if (alike.some((l) => l.archived && nameKey(l.name) === nameKey(f.name))) {
      plan.leftOut.push(f.name)
      continue
    }
    if (!opts.canAdd || room <= 0) {
      plan.cant.push(f.name)
      plan.why ??= opts.canAdd ? 'room' : 'manage'
      continue
    }
    room--
    let name = f.name
    for (let n = 2; taken.has(nameKey(name)); n++) name = `${f.name} (${n})`
    taken.add(nameKey(name))
    const added: FieldDef = { ...f, id: opts.newId(), name }
    plan.add.push(added)
    plan.map.set(f.id, { id: added.id, ...kindOf(f) })
  }
  return plan
}

// ── Merging two fields ─────────────────────────────────────────────────────────

/**
 * Why one field can't be merged into another, or null when it can. Only fields of the same kind merge; two card
 * links only when their cards come from the same place (a link kept under a field it couldn't have been made in
 * would be a rule broken quietly).
 */
export function mergeProblem(from: LibraryField, into: LibraryField): string | null {
  if (from.id === into.id) return 'Pick another field to merge it into.'
  if (from.archived || into.archived) return 'Restore the archived field first: only fields in use can be merged.'
  if (from.type !== into.type)
    return `“${from.name}” is a ${FIELD_TYPE_LABEL[from.type].toLowerCase()} and “${into.name}” a ${FIELD_TYPE_LABEL[into.type].toLowerCase()}: only fields of the same kind can be merged.`
  if (from.type === 'link' && ((from.linkTo ?? 'space') !== (into.linkTo ?? 'space') || from.board !== into.board))
    return 'Their cards come from different places, so they can’t be merged.'
  if (from.type === 'choice') {
    const { add } = mergeOptions(from, into, () => '')
    const all = into.options ?? []
    if (
      all.filter((o) => !o.archived).length + add.filter((o) => !o.archived).length > FIELD_LIMITS.options ||
      all.length + add.length > FIELD_LIMITS.options * 2
    )
      return `Together they’d have more options than a field can hold (${FIELD_LIMITS.options}).`
  }
  return null
}

/**
 * What merging a choice field into another does with its options: each goes to the kept field's option of the same
 * name (an archived one too: the kept field's settings stand), and the ones it has no name for are added to it, as
 * they are. `used`: the options cards actually hold, when that's known: an archived option nobody has isn't added.
 */
export function mergeOptions(
  from: FieldDef,
  into: FieldDef,
  newId: () => string,
  used?: ReadonlySet<string>,
): { map: Map<string, string>; add: FieldOption[] } {
  const map = new Map<string, string>()
  const add: FieldOption[] = []
  const there = into.options ?? []
  const taken = new Set(there.map((o) => o.id))
  for (const o of from.options ?? []) {
    const hit = there.find((x) => !x.archived && nameKey(x.name) === nameKey(o.name)) ?? there.find((x) => nameKey(x.name) === nameKey(o.name))
    if (hit) {
      map.set(o.id, hit.id)
      continue
    }
    if (o.archived && used && !used.has(o.id)) continue
    const id = taken.has(o.id) ? newId() : o.id
    taken.add(id)
    add.push({ id, name: o.name, color: o.color, ...(o.archived && { archived: true }) })
    map.set(o.id, id)
  }
  return { map, add }
}

/** Whether a card that has a value for both fields ends up with only one of them (and not both, joined). */
export const mergeKeepsOne = (into: FieldDef) => !(into.type === 'checkbox' || ((into.type === 'link' || into.type === 'person') && into.many))

/**
 * One card's values after the field `from` is merged into `into`: what it held for `from` is now held for `into`.
 * Where it had both, the value people can see on its board stays: the kept field's, unless the board shows only the
 * other one (`fromShown`). Lists that hold several (cards, people) are joined instead, and a checkbox is ticked if
 * either was. `options`: where a choice's options go (see `mergeOptions`). The same object comes back when the card
 * had nothing for `from`.
 */
export function mergeCustom(
  custom: CustomValues | undefined,
  from: FieldDef,
  into: FieldDef,
  opts: { options?: Map<string, string>; fromShown?: boolean } = {},
): CustomValues | undefined {
  if (!custom || !(from.id in custom)) return custom
  const { [from.id]: was, ...rest } = custom
  const held = rest[into.id]
  const list = into.type === 'link' || into.type === 'person'
  let moved: FieldValue | undefined = was
  if (into.type === 'choice') {
    const ids = linksOf(was).flatMap((o) => opts.options?.get(o) ?? [])
    moved = ids.length ? ids.slice(0, 1) : undefined
  } else if (list) {
    const all = linksOf(was)
    moved = all.length ? (into.many ? all : all.slice(0, 1)) : undefined
  }
  let next: FieldValue | undefined
  if (held === undefined) next = moved
  else if (moved === undefined) next = held
  else if (into.type === 'checkbox') next = true
  else if (list && into.many) {
    const [first, second] = opts.fromShown ? [moved, held] : [held, moved]
    next = [...new Set([...linksOf(first), ...linksOf(second)])].slice(0, into.type === 'link' ? FIELD_LIMITS.links : FIELD_LIMITS.people)
  } else next = opts.fromShown ? moved : held
  const out: CustomValues = { ...rest }
  if (next === undefined) delete out[into.id]
  else out[into.id] = next
  return sorted(out)
}

// ── Filtering by a field ───────────────────────────────────────────────────────

/**
 * What a card's value for a field has to be to pass a filter. Each kind of field uses the parts that mean something
 * for it (see `tidyFilter`): a choice `in`, a checkbox `checked`, a number `min` / `max` / `has`, a date `date` /
 * `has`, text `has`, a card link `in` (links) / `has`, a person `in` (their ids) / `has`.
 */
export interface FieldFilter {
  /** Any of these options, linked cards (a card link) or people (a person field); '' is "none picked". */
  in?: string[]
  /** Ticked, or not. */
  checked?: boolean
  /** At least, and at most. */
  min?: number
  max?: number
  /** In the past, in the next 7 days, or no date. */
  date?: 'past' | 'week' | 'none'
  /** Has a value, or doesn't. */
  has?: boolean
}

/** The parts of a filter each kind of field uses. */
const FILTER_PARTS: Record<FieldType, (keyof FieldFilter)[]> = {
  text: ['has'],
  number: ['min', 'max', 'has'],
  date: ['date', 'has'],
  choice: ['in'],
  checkbox: ['checked'],
  link: ['in', 'has'],
  person: ['in', 'has'],
}

/**
 * Does a card's value for a field pass? `today`: the day it is, as a day number (see dates.ts), for date filters.
 * `isMember`: who is on the board, so a person field that only holds people who left counts as holding no one.
 */
export function fieldMatches(
  def: FieldDef,
  value: FieldValue | undefined,
  f: FieldFilter,
  today: number,
  isMember?: (userId: string) => boolean,
): boolean {
  const asks = (part: keyof FieldFilter) => FILTER_PARTS[def.type].includes(part) && f[part] !== undefined
  const people = def.type === 'person' ? peopleOf(value).filter((id) => !isMember || isMember(id)) : null
  if (asks('has') && (people ? people.length > 0 : value !== undefined) !== f.has) return false
  if (asks('checked') && (value === true) !== f.checked) return false
  if (asks('in')) {
    const picked = people ?? (def.type === 'link' ? linksOf(value) : optionsOf(def, value).map((o) => o.id))
    if (!(picked.length ? picked.some((id) => f.in!.includes(id)) : f.in!.includes(''))) return false
  }
  if (asks('min') && !(typeof value === 'number' && value >= f.min!)) return false
  if (asks('max') && !(typeof value === 'number' && value <= f.max!)) return false
  if (asks('date')) {
    if (f.date === 'none') return value === undefined
    const days = typeof value === 'string' ? toDay(value) - today : NaN
    if (f.date === 'past' && !(days < 0)) return false
    if (f.date === 'week' && !(days >= 0 && days <= 7)) return false
  }
  return true
}

/**
 * A filter kept to what its field can use now: the parts for its kind, and options that still exist (a card link
 * keeps every well-formed link, a person field every id: whether the card or the person is still there isn't known
 * here). Undefined when nothing is left. The same object comes back when nothing had to go. `isMember`: who is on
 * the board, where that's known, so a person field's filter keeps only them.
 */
export function tidyFilter(def: FieldDef, f: FieldFilter, isMember?: (userId: string) => boolean): FieldFilter | undefined {
  const out: FieldFilter = {}
  for (const part of FILTER_PARTS[def.type]) {
    if (f[part] === undefined) continue
    if (part === 'in') {
      const fits = (id: string) =>
        def.type === 'link'
          ? !!parseRef(id)
          : def.type === 'person'
            ? isPersonId(id) && (!isMember || isMember(id))
            : (def.options ?? []).some((o) => o.id === id)
      const known = f.in!.filter((id) => id === '' || fits(id))
      if (known.length) out.in = known.length === f.in!.length ? f.in : known
    } else Object.assign(out, { [part]: f[part] })
  }
  const keys = Object.keys(out) as (keyof FieldFilter)[]
  if (!keys.length) return undefined
  return keys.length === Object.keys(f).filter((k) => f[k as keyof FieldFilter] !== undefined).length && keys.every((k) => out[k] === f[k]) ? f : out
}

/**
 * A filter in words, to follow the field's name: "Won, Lead", "yes", "from 1,000 to 5,000", "in the past". A card
 * link's cards and a person field's people are named by `titleOf`: "a card", "someone who left" when it doesn't
 * know one.
 */
export function filterText(def: FieldDef, f: FieldFilter, titleOf?: TitleOf): string {
  const parts: string[] = []
  const named = (id: string) =>
    def.type === 'link'
      ? (titleOf?.(id) ?? 'a card')
      : def.type === 'person'
        ? (titleOf?.(id) ?? SOMEONE_GONE)
        : (def.options ?? []).find((o) => o.id === id)?.name
  if (f.in)
    parts.push(
      f.in
        .map((id) => (id ? named(id) : def.type === 'person' ? 'no one' : 'none'))
        .filter(Boolean)
        .join(', '),
    )
  if (f.checked !== undefined) parts.push(f.checked ? 'yes' : 'no')
  const n = (x: number) => numberText(def, x)
  if (f.min !== undefined && f.max !== undefined) parts.push(`${n(f.min)} to ${n(f.max)}`)
  else if (f.min !== undefined) parts.push(`${n(f.min)} or more`)
  else if (f.max !== undefined) parts.push(`${n(f.max)} or less`)
  if (f.date) parts.push({ past: 'in the past', week: 'in the next 7 days', none: 'no date' }[f.date])
  if (f.has !== undefined) parts.push(f.has ? 'has a value' : 'empty')
  return parts.join(', ')
}

/**
 * A filter as text, for an address (the Search cards page): option ids with commas ("-" for none picked), "yes" or
 * "no", "any" or "none" (has a value or not), "past" or "week", and for numbers "10..200", "10.." or "..200". A card
 * link: "any" or "none", or its links with commas (each written for an address, since a card's id may hold one). A
 * person field: "any" or "none", or people's ids with commas ("-" for no one; "me" is for whoever reads it to fill in).
 */
export function filterToText(def: FieldDef, f: FieldFilter): string {
  if (def.type === 'choice' || (def.type === 'person' && f.in)) return (f.in ?? []).map((id) => id || '-').join(',')
  if (def.type === 'link' && f.in) return f.in.map((ref) => (ref ? encodeURIComponent(ref) : '-')).join(',')
  if (def.type === 'checkbox') return f.checked === undefined ? '' : f.checked ? 'yes' : 'no'
  if (f.has !== undefined) return f.has ? 'any' : 'none'
  if (def.type === 'date') return f.date ?? ''
  if (f.min !== undefined || f.max !== undefined) return `${f.min ?? ''}..${f.max ?? ''}`
  return ''
}

/** Reads `filterToText` back. Undefined when the text says nothing this kind of field understands. */
export function filterFromText(def: FieldDef, text: string): FieldFilter | undefined {
  const t = text.trim()
  if (!t) return undefined
  let f: FieldFilter = {}
  if (def.type === 'choice') f = { in: [...new Set(t.split(',').map((id) => (id === '-' ? '' : id)))] }
  else if (def.type === 'checkbox') f = t === 'yes' ? { checked: true } : t === 'no' ? { checked: false } : {}
  else if (t === 'any' || t === 'none') f = { has: t === 'any' }
  else if (def.type === 'link') f = { in: [...new Set(t.split(',').map((x) => (x === '-' ? '' : safeDecode(x))))] }
  else if (def.type === 'person') f = { in: [...new Set(t.split(',').map((id) => (id === '-' ? '' : id)))] }
  else if (def.type === 'date') f = t === 'past' || t === 'week' ? { date: t } : {}
  else if (def.type === 'number' && t.includes('..')) {
    const [min, max] = t.split('..').map((x) => (x === '' ? undefined : Number(x)))
    f = { ...(min !== undefined && Number.isFinite(min) && { min }), ...(max !== undefined && Number.isFinite(max) && { max }) }
  }
  return tidyFilter(def, f)
}

/**
 * What an assistant says a field should be, when looking for cards: a value as people write it (an option's name,
 * "yes", a number as text), or null for "empty". Unlike setting a value, finding one is forgiving: text in any case,
 * an archived option by its name, a day for a date that has a time. Returns the test, or why it can't be read.
 */
export function saidFilter(
  def: FieldDef,
  said: string | number | boolean | null,
): { test: (value: FieldValue | undefined) => boolean } | { error: string } {
  if (said === null || said === '') return { test: (v) => v === undefined }
  switch (def.type) {
    case 'text': {
      const key = String(said).trim().toLowerCase()
      return { test: (v) => typeof v === 'string' && v.trim().toLowerCase() === key }
    }
    case 'number': {
      const n = typeof said === 'number' ? said : Number(String(said).replace(/[,\s]/g, ''))
      if (!Number.isFinite(n)) return { error: `${def.name}: that isn’t a number.` }
      return { test: (v) => v === n }
    }
    case 'date': {
      const day = normalizeTaskDate(String(said))
      if (!day) return { error: `${def.name}: ${DATE_HINT}` }
      // A whole day finds what falls on it, with or without a time.
      return { test: (v) => typeof v === 'string' && (v === day || (day.length === 10 && v.slice(0, 10) === day)) }
    }
    case 'choice': {
      const key = nameKey(String(said))
      const hit = (def.options ?? []).find((o) => o.id === said) ?? (def.options ?? []).find((o) => nameKey(o.name) === key)
      if (!hit)
        return {
          error: `There’s no option “${said}” for ${def.name}. The options are: ${(def.options ?? []).map((o) => o.name).join(', ') || 'none yet'}.`,
        }
      return { test: (v) => Array.isArray(v) && v.includes(hit.id) }
    }
    case 'checkbox': {
      const key = typeof said === 'boolean' ? (said ? 'yes' : 'no') : String(said).trim().toLowerCase()
      if (['yes', 'true', 'on', '1'].includes(key)) return { test: (v) => v === true }
      if (['no', 'false', 'off', '0'].includes(key)) return { test: (v) => v === undefined }
      return { error: `${def.name}: that’s either yes or no.` }
    }
    case 'link': {
      // (A link as it's stored. A card said by its title is looked up first, by whoever can see the other boards.)
      const ref = String(said)
      if (!parseRef(ref)) return { error: `${def.name}: say which card by its title, or by its board’s id and its own with a colon between.` }
      return { test: (v) => linksOf(v).includes(ref) }
    }
    case 'person': {
      // (A person by id. Someone said by name is looked up first, by whoever knows the board's people.)
      const id = String(said)
      return { test: (v) => peopleOf(v).includes(id) }
    }
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
