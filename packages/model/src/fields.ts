import type { ColorName } from './colors'
import { normalizeTaskDate, sortTime } from './dates'

/**
 * Custom fields: what a space's library defines, what a board uses, and what a card holds.
 *
 * A field is defined once, in the library of a workspace or of a person (for their Personal boards). A board picks
 * the fields it uses; a card holds a value per field id (`Task.custom`). This file is the one place that knows the
 * types: everything else asks here how to check a value, show it, compare it, or carry it over to another field.
 */
export const FIELD_TYPES = ['text', 'number', 'date', 'choice', 'checkbox'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export const FIELD_TYPE_LABEL: Record<FieldType, string> = { text: 'Text', number: 'Number', date: 'Date', choice: 'Choice', checkbox: 'Checkbox' }
export const FIELD_TYPE_HINT: Record<FieldType, string> = {
  text: 'A few words, a link, an email or a phone number',
  number: 'An amount, with a unit if you like',
  date: 'A day, with a time if it matters',
  choice: 'One of the options you list',
  checkbox: 'Yes or no',
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

/** What a field's type lets you set: text has a format, a number a unit and decimals, a choice its options. */
export interface FieldSettings {
  format?: TextFormat
  unit?: string
  decimals?: number
  /** Numbers that make sense added up (a parent's subtasks, a list). */
  sum?: boolean
  options?: FieldOption[]
}

/** A field, as its library defines it. Its type never changes. */
export interface FieldDef extends FieldSettings {
  id: string
  name: string
  type: FieldType
}

/** A field a board uses, in the board's order. `front`: shown on the card front too. */
export interface BoardField extends FieldDef {
  front?: boolean
}

/**
 * What a card holds for a field: text, a number, a date (a day or a moment, like `due`), true for a ticked checkbox,
 * or a list of option ids for a choice. Empty is never stored: no value is no key.
 */
export type FieldValue = string | number | boolean | string[]
export type CustomValues = Record<string, FieldValue>

export const FIELD_LIMITS = {
  /** Fields in use in one library, and archived ones kept beside them. */
  perSpace: 50,
  archived: 100,
  perBoard: 20,
  front: 3,
  options: 50,
  name: 60,
  unit: 8,
  text: 500,
  link: 2000,
  /** Values one card can hold. */
  values: 50,
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
 * Checks a value for a field and tidies it. `undefined` means empty (the key goes). Lenient is for values that were
 * valid once (undo, an imported file): an archived option is kept, and what no longer fits is dropped, not refused.
 */
export function checkValue(def: FieldDef, raw: unknown, lenient = false): Checked {
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

/** A value in words, for the activity log and anywhere that just reads it out. */
export function valueText(def: FieldDef, value: FieldValue): string {
  switch (def.type) {
    case 'number':
      return typeof value === 'number' ? numberText(def, value) : String(value)
    case 'choice':
      return optionsOf(def, value)
        .map((o) => o.name)
        .join(', ')
    case 'checkbox':
      return 'yes'
    default:
      return String(value)
  }
}

/** A value for programs (assistants, the API by name): option names instead of ids, the rest as stored. */
export function valuePlain(def: FieldDef, value: FieldValue): string | number | boolean {
  if (def.type === 'choice') return valueText(def, value)
  return Array.isArray(value) ? value.join(', ') : value
}

/** Orders two values of a field. Empty always goes last (the caller flips the rest for descending). */
export function compareValues(def: FieldDef, a: FieldValue | undefined, b: FieldValue | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  switch (def.type) {
    case 'number':
      return (a as number) - (b as number)
    case 'date':
      return sortTime(a as string) - sortTime(b as string)
    case 'choice': {
      const at = (v: FieldValue) => (def.options ?? []).findIndex((o) => Array.isArray(v) && v.includes(o.id))
      return at(a) - at(b)
    }
    case 'checkbox':
      return 0
    default:
      return String(a).localeCompare(String(b))
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
 * For records that come back from somewhere: undo, un-archiving, a file.
 */
export function tidyCustom(custom: CustomValues | undefined, fields: FieldDef[]): CustomValues | undefined {
  if (!custom) return undefined
  const out: CustomValues = {}
  for (const f of fields) {
    if (!(f.id in custom)) continue
    const r = checkValue(f, custom[f.id], true)
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
): { custom: CustomValues | undefined } | { error: string } {
  const out: CustomValues = { ...current }
  for (const [id, raw] of Object.entries(patch)) {
    const def = fields.find((f) => f.id === id)
    if (!def) return { error: 'That field is no longer on this board.' }
    const r = checkValue(def, raw)
    if ('error' in r) return { error: `${def.name}: ${r.error}` }
    if (r.value === undefined) delete out[id]
    else out[id] = r.value
  }
  if (Object.keys(out).length > FIELD_LIMITS.values) return { error: 'That’s more values than one card can hold.' }
  return { custom: sorted(out) }
}

/** Where a field's values go when they're carried to another set of fields: the field there, and its options. */
export type FieldMap = Map<string, { id: string; options?: Map<string, string> }>

/** A card's values carried over by a `FieldMap`: what has nowhere to go is left behind. */
export function carryCustom(custom: CustomValues | undefined, map: FieldMap): CustomValues | undefined {
  if (!custom) return undefined
  const out: CustomValues = {}
  for (const [id, v] of Object.entries(custom)) {
    const to = map.get(id)
    if (!to) continue
    if (Array.isArray(v) && to.options) {
      const next = v.flatMap((o) => (to.options!.has(o) ? [to.options!.get(o)!] : []))
      if (next.length) out[to.id] = next
    } else out[to.id] = v
  }
  return sorted(out)
}

/** How one choice field's options map onto another's, by name (only onto options that can still be picked). */
function optionMap(from: FieldDef, to: FieldDef): Map<string, string> {
  const map = new Map<string, string>()
  for (const o of from.options ?? []) {
    const hit = (to.options ?? []).find((x) => !x.archived && nameKey(x.name) === nameKey(o.name))
    if (hit) map.set(o.id, hit.id)
  }
  return map
}

/**
 * Where one board's fields go on another board (a card moving between them): the same field if that board uses it,
 * else a field there with the same name and type. `unmatched`: the ones with nowhere to go.
 */
export function matchFields(from: FieldDef[], to: FieldDef[]): { map: FieldMap; unmatched: FieldDef[] } {
  const map: FieldMap = new Map()
  const unmatched: FieldDef[] = []
  for (const f of from) {
    const same = to.find((t) => t.id === f.id)
    const alike = same ?? to.find((t) => t.type === f.type && nameKey(t.name) === nameKey(f.name))
    if (same) map.set(f.id, { id: same.id })
    else if (alike) map.set(f.id, { id: alike.id, ...(f.type === 'choice' && { options: optionMap(f, alike) }) })
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
 */
export function planAdoption(library: LibraryField[], incoming: FieldDef[], opts: { canAdd: boolean; room: number; newId: () => string }): Adoption {
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
      plan.map.set(f.id, { id: own.id })
      continue
    }
    if (named) {
      if (f.type !== 'choice') {
        plan.map.set(f.id, { id: named.id })
        continue
      }
      const options = optionMap(f, named)
      const missing = (f.options ?? []).filter((o) => !o.archived && !options.has(o.id))
      const fits = (named.options ?? []).length + missing.length <= FIELD_LIMITS.options
      if (missing.length && opts.canAdd && fits) {
        const used = new Set((named.options ?? []).map((o) => o.id))
        const added = missing.map((o) => ({ id: used.has(o.id) ? opts.newId() : o.id, name: o.name, color: o.color }))
        plan.addOptions.set(named.id, added)
        missing.forEach((o, i) => options.set(o.id, added[i].id))
      } else for (const o of missing) plan.lose.push(`${f.name}: ${o.name}`)
      plan.map.set(f.id, { id: named.id, options })
      continue
    }
    if (!opts.canAdd || room <= 0) {
      plan.lose.push(f.name)
      continue
    }
    room--
    const name = free(f.name)
    taken.add(nameKey(name))
    const { id: _old, ...rest } = f
    const added: FieldDef = { ...rest, id: opts.newId(), name }
    plan.add.push(added)
    plan.map.set(f.id, { id: added.id })
  }
  return plan
}
