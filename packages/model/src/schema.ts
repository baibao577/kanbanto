import { DATE_WORDS, MAX_DATE_DAYS, normalizeTaskDate } from './dates'
import { z } from 'zod'
import { COLORS, isBackground, type BoardBackground, type ColorName } from './colors'
import { BULK_MAX, IMPORT_MAX, type Command } from './commands'
import { FIELD_LIMITS, FIELD_TYPES, FILTER_TEXT_MAX, TEXT_FORMATS, TEXT_MATCHES, LINK_SCOPES, type FieldSettings } from './fields'
import { isPosition } from './position'
import { CODE, MAX_NUMBER, PAST_CODES } from './refs'
import { MAX_RULES, RULE_COUNTS, type BoardRule } from './rules'
import { CALENDAR_RANGES } from './prefs'
import { BUILT_IN_SORT_KEYS, OUTLINE_COLUMNS, OUTLINE_EXTRA, type OutlineConfig, type TableFilter } from './table'
import { CATEGORIES, LAYOUTS, LIST_ORDERS, PRIORITIES } from './types'

/**
 * Runtime checks for data coming from outside the code: imported files, and records a client asks to put back
 * (undo). Anything that doesn't match is rejected instead of crashing somewhere deep inside — the limits are the
 * same ones the commands enforce, so a record can't come back in a shape no command could have made.
 */
const color = z.enum(COLORS.map((c) => c.id) as [ColorName, ...ColorName[]])
/** A palette color, a designed background, or custom-<hue>-<shade> (see colors.ts). */
const boardBackground = z
  .string()
  .max(40)
  .refine(isBackground, 'That isn’t a board background.')
  .transform((v) => v as BoardBackground)
/** A whole day (2026-10-15), or a date-time with its time zone (2026-10-15T14:30:00+07:00), stored as a UTC moment. */
const date = z
  .string()
  .max(40)
  .refine((v) => normalizeTaskDate(v) !== null, 'Dates look like 2026-10-31, or 2026-10-31T14:30:00Z with a time.')
// PostgreSQL text can't hold a NUL character; ids are printable too.
const NUL = '\u0000'
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const plain = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes(NUL), 'Text can’t contain NUL characters.')
const recordId = z
  .string()
  .min(1)
  .max(100)
  .refine((s) => !CONTROL.test(s), 'Not a valid id.')
const position = z.string().refine(isPosition, 'Not a valid position.')
/** A board's letters (see refs.ts). */
const code = z.string().regex(CODE, 'A board’s letters are 2 to 5 capitals or digits, starting with a letter.')
const priority = z.enum(PRIORITIES)
const reminder = z
  .object({
    id: recordId,
    at: z
      .string()
      .max(40)
      // (A real moment, in years a calendar can show: what's built from it adds to it.)
      .refine(
        (s) => Date.parse(s) >= Date.UTC(2000, 0, 1) && Date.parse(s) < Date.UTC(2200, 0, 1),
        'A reminder’s time is a moment, like 2026-10-31T14:30:00Z.',
      )
      .optional(),
    beforeDue: z
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 30)
      .optional(),
    tz: z.string().max(64).optional(),
    by: recordId.optional(),
  })
  .refine((r) => !!r.at !== (r.beforeDue !== undefined), 'A reminder is either at a time or before the due date.')
const reminders = z.array(reminder).max(20)
/**
 * A card's values for the board's fields. Only their shape and size are checked here: whether a value fits its
 * field needs the board (see `patchCustom` and `tidyCustom` in fields.ts).
 */
// (A list holds a choice's option ids, a person field's people, or a card link's links: a board's id, a colon and a
// card's, so longer than an id.)
const listed = z
  .string()
  .min(1)
  .max(FIELD_LIMITS.ref)
  .refine((s) => !CONTROL.test(s), 'Not a valid id.')
const fieldValue = z.union([plain(FIELD_LIMITS.link), z.number(), z.boolean(), z.array(listed).max(FIELD_LIMITS.links)])
const tooMany = 'That’s more values than one card can hold.'
const custom = z.record(recordId, fieldValue).refine((v) => Object.keys(v).length <= FIELD_LIMITS.values, tooMany)
const meta = {
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}

export const TaskSchema = z.object({
  id: recordId,
  number: z.number().int().positive().max(MAX_NUMBER).optional(),
  // (A file's id. Anything else is read as no cover, not refused: it's the server's to set, see types.ts.)
  cover: z.uuid().optional().catch(undefined),
  title: plain(500),
  parentId: recordId.nullable(),
  status: recordId,
  order: position,
  assigneeId: recordId.optional(),
  start: date.optional(),
  due: date.optional(),
  labels: z.array(recordId).max(200),
  blockedBy: z.array(recordId).max(200),
  description: plain(50_000).optional(),
  priority: priority.optional(),
  archivedAt: z.string().max(40).optional(),
  archivedList: plain(200).optional(),
  archivedDone: z.boolean().optional(),
  activeAt: z.string().max(40).optional(),
  doneAt: z.string().max(40).optional(),
  reminders: reminders.optional(),
  color: color.optional(),
  rank: position.optional(),
  custom: custom.optional(),
  ...meta,
})

/** What a field's type lets you set (see FieldSettings). */
export const FieldSettingsSchema = z.object({
  format: z.enum(TEXT_FORMATS).optional(),
  unit: plain(FIELD_LIMITS.unit).optional(),
  decimals: z.number().int().min(0).max(6).optional(),
  sum: z.boolean().optional(),
  options: z
    .array(z.object({ id: recordId, name: plain(FIELD_LIMITS.name), color, archived: z.boolean().optional() }))
    .max(FIELD_LIMITS.options * 2)
    .optional(),
  linkTo: z.enum(LINK_SCOPES).optional(),
  board: recordId.optional(),
  many: z.boolean().optional(),
  back: plain(FIELD_LIMITS.name).optional(),
})
// (This schema drops what it doesn't list: a setting added to FieldSettings and not here would be lost from every
// imported board. So the two are kept the same, like commands below.)
type SameAs<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
export const fieldSettingsSchemaMatchesType: SameAs<z.infer<typeof FieldSettingsSchema>, FieldSettings> = true
/** A field as a board uses it (see BoardField). */
export const BoardFieldSchema = FieldSettingsSchema.extend({
  id: recordId,
  name: plain(FIELD_LIMITS.name),
  type: z.enum(FIELD_TYPES),
  front: z.boolean().optional(),
  total: z.boolean().optional(),
})

export const BoardSchema = z.object({
  id: recordId,
  name: plain(200),
  mode: z.enum(['manual', 'derived']),
  background: boardBackground.optional(),
  description: plain(1000).optional(),
  code: code.optional(),
  pastCodes: z.array(code).max(PAST_CODES).optional(),
  ...meta,
})
export const MemberSchema = z.object({ id: recordId, name: plain(200), picture: z.string().max(200).optional(), ...meta })
export const ColumnSchema = z.object({
  id: recordId,
  name: plain(200),
  category: z.enum(CATEGORIES),
  color: color.optional(),
  position,
  ...meta,
})
export const LabelSchema = z.object({ id: recordId, name: plain(200), color, ...meta })

export const BoardDataSchema = z.object({
  board: BoardSchema,
  members: z.array(MemberSchema),
  columns: z.array(ColumnSchema).min(1),
  labels: z.array(LabelSchema),
  // A file from before fields has none; a field of a type this version doesn't know is left out, not refused.
  fields: z
    .array(z.unknown())
    .max(200)
    .default([])
    .transform((all) => all.flatMap((f) => (BoardFieldSchema.safeParse(f).success ? [BoardFieldSchema.parse(f)] : []))),
  // A board from before rules has none (and stays without the key); a rule of a kind this version doesn't know, or
  // one that isn't whole, is left out, not refused.
  rules: z
    .array(z.unknown())
    .max(MAX_RULES * 5)
    .optional()
    .transform((all) =>
      all?.flatMap((r) => {
        const rule = BoardRuleSchema.safeParse(r)
        return rule.success ? [rule.data] : []
      }),
    ),
  tasks: z.record(z.string(), TaskSchema),
  archived: z.record(z.string(), TaskSchema).optional(),
})

// Commands, as they arrive from a client. Sizes are capped so one request can't be enormous.
const id = recordId
const ids = z.array(id).max(10_000)
const text = plain
const category = z.enum(CATEGORIES)
const taskFields = z
  .object({
    title: text(500),
    description: text(50_000),
    status: id,
    start: z.union([date, z.literal('')]),
    due: z.union([date, z.literal('')]),
    labels: z.array(id).max(200),
    blockedBy: z.array(id).max(200),
    assigneeId: id.nullable(),
    priority: priority.nullable(),
    reminders,
    color: color.nullable(),
    // Sets the fields it names (null clears one) and leaves the others.
    custom: z.record(id, fieldValue.nullable()).refine((v) => Object.keys(v).length <= FIELD_LIMITS.values, tooMany),
  })
  .partial()
const place = z.union([z.object({ before: id }), z.object({ after: id }), z.object({ end: z.literal(true) })])
const change = <E extends string, S extends z.ZodType>(entity: E, schema: S) =>
  z.object({ entity: z.literal(entity), id, before: schema.nullable(), after: schema.nullable() })

export const ChangeSchema = z.discriminatedUnion('entity', [
  change('board', BoardSchema),
  change('member', MemberSchema),
  change('column', ColumnSchema),
  change('label', LabelSchema),
  change('task', TaskSchema),
])

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.create'),
    id: id.optional(),
    parentId: id.nullable(),
    fields: taskFields.extend({ title: text(500) }),
    rankAfter: id.optional(),
  }),
  z.object({ type: z.literal('task.update'), id, fields: taskFields }),
  z.object({
    type: z.literal('task.move'),
    id,
    parentId: id.nullable().optional(),
    place: place.optional(),
    status: id.optional(),
    assigneeId: id.nullable().optional(),
    list: ids.optional(),
  }),
  z.object({ type: z.literal('tasks.moveToList'), ids, status: id, assigneeId: id.nullable().optional(), list: ids.optional() }),
  z.object({
    type: z.literal('tasks.update'),
    cards: z.array(z.object({ id, fields: taskFields })).max(BULK_MAX),
    lists: z
      .array(z.object({ status: id, order: ids }))
      .max(200)
      .optional(),
  }),
  z.object({ type: z.literal('task.delete'), id }),
  z.object({ type: z.literal('task.archive'), id, complete: z.boolean().optional() }),
  z.object({ type: z.literal('tasks.archiveDone'), status: id, before: z.string().max(40) }),
  z.object({ type: z.literal('task.restore'), id }),
  z.object({ type: z.literal('tasks.clearField'), fieldId: id }),
  z.object({
    type: z.literal('tasks.import'),
    template: text(100).optional(),
    lists: z
      .array(z.object({ id, name: text(200), category }))
      .max(200)
      .optional(),
    labels: z
      .array(z.object({ id, name: text(200), color }))
      .max(500)
      .optional(),
    cards: z.array(z.object({ id, parentId: id.nullable(), fields: taskFields.extend({ title: text(500) }) })).max(IMPORT_MAX),
  }),
  z.object({ type: z.literal('column.create'), id: id.optional(), name: text(200), category }),
  z.object({
    type: z.literal('column.update'),
    id,
    fields: z.object({ name: text(200), category, color: color.nullable() }).partial(),
  }),
  z.object({ type: z.literal('column.move'), id, beforeId: id.optional() }),
  z.object({ type: z.literal('column.delete'), id, moveTo: id }),
  z.object({ type: z.literal('label.create'), id: id.optional(), name: text(200), color }),
  z.object({ type: z.literal('label.update'), id, fields: z.object({ name: text(200), color }).partial() }),
  z.object({ type: z.literal('label.delete'), id }),
  z.object({
    type: z.literal('board.update'),
    fields: z
      .object({ name: text(200), mode: z.enum(['manual', 'derived']), background: boardBackground.nullable(), description: text(1000) })
      .partial(),
  }),
  z.object({ type: z.literal('records.restore'), changes: z.array(ChangeSchema).max(20_000) }),
])

// The schema and the Command type describe the same thing: this stops compiling if they drift apart, so the
// server can use a checked command as a Command without a cast.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
export const commandSchemaMatchesType: Same<z.infer<typeof CommandSchema>, Command> = true

const viewConfig = z.object({
  columns: z.enum(['status', 'parent']),
  rows: z.enum(['none', 'rootParent', 'directParent', 'assignee']),
  filter: z.enum(['all', 'leaves', 'main', 'topLevel', 'actionable']),
  parentDisplay: z.array(z.enum(['label', 'checklist', 'progress', 'rowHeader', 'age'])),
  hiddenColumns: z.array(z.string()).optional(),
  collapsedColumns: z.array(z.string()).optional(),
  groupByParent: z.boolean().optional(),
  // (A value this version doesn't know reads as the default.)
  doneLists: z.enum(['all', 'recent']).optional().catch(undefined),
  doneDays: z.number().int().min(1).max(365).optional(),
  listOrder: z.record(z.string(), z.enum(LIST_ORDERS)).optional().catch(undefined),
  cardNumbers: z.boolean().optional().catch(undefined),
  covers: z.boolean().optional().catch(undefined),
})

/**
 * One of the board's own fields as a column or a sort key: "f:" and its id. Only the shape is checked: whether the
 * field is still on the board is for `cleanPrefs`, like a filter by a list that's gone.
 */
const fieldKey = z.templateLiteral(['f:', z.string()]).refine((k) => k.length > 2 && k.length <= 110, 'Not a field.')
const wholeDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
/**
 * A test of a day (see DateTest). Like every part of a filter added after the first ones, a value this version
 * doesn't know reads as not there: the test is then left out, and never read as a different one.
 */
const dateTest = {
  on: z.enum(DATE_WORDS).optional().catch(undefined),
  days: z.number().int().min(1).max(MAX_DATE_DAYS).optional().catch(undefined),
  from: wholeDay.optional().catch(undefined),
  to: wholeDay.optional().catch(undefined),
}
const picked = z.array(z.string().max(FIELD_LIMITS.ref)).max(FIELD_LIMITS.options * 2 + 1)
/** What a field's value has to be to pass a filter (see FieldFilter). */
const fieldFilter = z.object({
  in: picked.optional(),
  notIn: picked.optional().catch(undefined),
  checked: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  date: z.enum(['past', 'week', 'none']).optional(),
  text: z.string().max(FILTER_TEXT_MAX).optional().catch(undefined),
  match: z.enum(TEXT_MATCHES).optional().catch(undefined),
  has: z.boolean().optional(),
  ...dateTest,
})

/** A board preset's settings (see PresetSettings): filters, and how the Board and Outline look. */
export const PresetSettingsSchema = z.object({
  display: z.object({ board: viewConfig }),
  outline: z.object({
    sort: z.object({ key: z.union([z.enum(BUILT_IN_SORT_KEYS), fieldKey]), dir: z.enum(['asc', 'desc']) }).optional(),
    // (Like any setting added later: a value this version doesn't know reads as not set.)
    group: z
      .union([z.enum(['status', 'assignee', 'priority', 'labels']), fieldKey])
      .optional()
      .catch(undefined),
    hidden: z
      .array(z.union([z.enum(OUTLINE_COLUMNS), fieldKey]))
      .max(100)
      .optional(),
    extra: z.array(z.enum(OUTLINE_EXTRA)).max(OUTLINE_EXTRA.length).optional().catch(undefined),
    hideFields: z.boolean().optional(),
    density: z.enum(['comfortable', 'compact']).optional(),
    hideDone: z.boolean().optional(),
    order: z
      .array(z.union([z.enum(OUTLINE_COLUMNS), fieldKey]))
      .max(200)
      .optional()
      .catch(undefined),
  }),
  filter: z.object({
    statuses: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    priorities: z.array(z.enum([...PRIORITIES, ''])).optional(),
    due: z.enum(['overdue', 'week', 'none']).optional(),
    dueIs: z.object(dateTest).optional().catch(undefined),
    startIs: z.object(dateTest).optional().catch(undefined),
    changed: z.number().int().min(1).max(3650).optional(),
    idle: z.number().int().min(1).max(3650).optional(),
    fields: z.record(recordId, fieldFilter).optional(),
  }),
})
// (A key in the types and not here would be dropped from every saved filter and every device's settings without a
// word, so the two are kept the same: this stops compiling when they drift.)
export const filterSchemaMatchesType: SameAs<z.infer<typeof PresetSettingsSchema>['filter'], TableFilter> = true

const ruleName = plain(60)
  .refine((s) => s.trim().length > 0 && s === s.trim(), 'A name can’t be empty.')
  .optional()
/** The cards a rule is about (see CardSet): a filter's lists, people, labels, priorities and fields, and nothing else. */
const ruleCards = z
  .object({
    statuses: z.array(recordId).min(1).max(50).optional(),
    assignees: z.array(z.string().max(100)).min(1).max(50).optional(),
    labels: z.array(recordId).min(1).max(50).optional(),
    priorities: z
      .array(z.enum([...PRIORITIES, '']))
      .min(1)
      .max(PRIORITIES.length + 1)
      .optional(),
    fields: z
      .record(recordId, fieldFilter)
      .refine((f) => Object.keys(f).length <= 10, 'Too many fields.')
      .optional(),
  })
  .strict()
const LimitRuleSchema = z
  .object({
    id: z.uuid(),
    kind: z.literal('limit'),
    name: ruleName,
    cards: ruleCards,
    counts: z.enum(RULE_COUNTS),
    measure: z.union([z.object({ by: z.literal('cards') }).strict(), z.object({ by: z.literal('field'), field: recordId }).strict()]),
    per: z.literal('person').optional(),
    max: z.number().min(0).max(1e12).optional(),
    min: z.number().min(0).max(1e12).optional(),
    then: z
      .array(z.object({ do: z.literal('show') }).strict())
      .min(1)
      .max(5),
  })
  .strict()
  .refine((r) => r.max !== undefined || r.min !== undefined, 'A limit needs a number.')
  .refine((r) => r.max === undefined || r.min === undefined || r.min <= r.max, 'The least can’t be more than the most.')
const WhenRuleSchema = z
  .object({
    id: z.uuid(),
    kind: z.literal('when'),
    name: ruleName,
    on: z.enum(['enters', 'leaves']),
    cards: ruleCards,
    counts: z.enum(RULE_COUNTS),
    // (One thing to do, for now: tell. Who: people's ids, and "@assignee" for whoever the card is assigned to.)
    then: z
      .array(
        z
          .object({
            do: z.literal('tell'),
            who: z.array(z.string().min(1).max(100)).min(1).max(50),
          })
          .strict(),
      )
      .length(1),
  })
  .strict()
/**
 * A board's rule (see rules.ts): a limit, or a "when" rule. What it says about its cards is a filter's lists,
 * people, labels, priorities and fields, and nothing else: a part a rule can't have ("me" aside, which `ruleProblem`
 * sees to) makes it not a rule.
 */
export const BoardRuleSchema = z.union([LimitRuleSchema, WhenRuleSchema])
export const ruleSchemaMatchesType: SameAs<z.infer<typeof BoardRuleSchema>, BoardRule> = true
export const outlineSchemaMatchesType: SameAs<z.infer<typeof PresetSettingsSchema>['outline'], OutlineConfig> = true

export const ViewPrefsSchema = PresetSettingsSchema.extend({
  version: z.literal(3),
  layout: z.enum(LAYOUTS),
  focusId: z.string().optional(),
  collapsedRows: z.array(z.string()),
  showPerf: z.boolean(),
  presetId: z.string().optional(),
  beforePreset: PresetSettingsSchema.optional(),
  // (Like any setting added later: a value this version doesn't know reads as not set.)
  timeline: z
    .object({
      as: z.enum(['calendar']).optional().catch(undefined),
      range: z.enum(CALENDAR_RANGES).optional().catch(undefined),
      subtasks: z.boolean().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
})
