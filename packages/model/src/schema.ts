import { normalizeTaskDate } from './dates'
import { z } from 'zod'
import { COLORS, isBackground, type BoardBackground, type ColorName } from './colors'
import type { Command } from './commands'
import { isPosition } from './position'
import { CATEGORIES, LAYOUTS, PRIORITIES } from './types'

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
const priority = z.enum(PRIORITIES)
const reminder = z
  .object({
    id: recordId,
    at: z.string().max(40).optional(),
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
const meta = {
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}

export const TaskSchema = z.object({
  id: recordId,
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
  activeAt: z.string().max(40).optional(),
  reminders: reminders.optional(),
  color: color.optional(),
  rank: position.optional(),
  ...meta,
})

export const BoardSchema = z.object({
  id: recordId,
  name: plain(200),
  mode: z.enum(['manual', 'derived']),
  background: boardBackground.optional(),
  description: plain(1000).optional(),
  ...meta,
})
export const MemberSchema = z.object({ id: recordId, name: plain(200), ...meta })
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
  z.object({ type: z.literal('task.delete'), id }),
  z.object({ type: z.literal('task.archive'), id }),
  z.object({ type: z.literal('task.restore'), id }),
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
  groupByParent: z.boolean().optional(),
})

/** A board preset's settings (see PresetSettings): filters, and how the Board and Outline look. */
export const PresetSettingsSchema = z.object({
  display: z.object({ board: viewConfig }),
  outline: z.object({
    sort: z
      .object({ key: z.enum(['title', 'status', 'progress', 'assignee', 'priority', 'start', 'due', 'labels']), dir: z.enum(['asc', 'desc']) })
      .optional(),
    hidden: z.array(z.enum(['status', 'progress', 'assignee', 'priority', 'start', 'due', 'labels'])).optional(),
    density: z.enum(['comfortable', 'compact']).optional(),
  }),
  filter: z.object({
    statuses: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    priorities: z.array(z.enum([...PRIORITIES, ''])).optional(),
    due: z.enum(['overdue', 'week', 'none']).optional(),
    upNext: z.boolean().optional(),
    idle: z.number().int().min(1).max(3650).optional(),
  }),
})

export const ViewPrefsSchema = PresetSettingsSchema.extend({
  version: z.literal(3),
  layout: z.enum(LAYOUTS),
  focusId: z.string().optional(),
  collapsedRows: z.array(z.string()),
  showPerf: z.boolean(),
  presetId: z.string().optional(),
  beforePreset: PresetSettingsSchema.optional(),
})
