import { z } from 'zod'
import { COLORS, type ColorName } from './colors'
import { hasTime, normalizeTaskDate } from './dates'
import { PERCENTS, type Percent } from './planning'
import type { PlanCommand } from './planningCommands'
import { isPosition } from './position'

/**
 * Runtime checks for plan commands coming from outside the code (the page, the API). Limits match the ones
 * `executePlan` enforces, so a record can't come back by undo in a shape no command could have made.
 */
// PostgreSQL text can't hold a NUL character; ids are printable too.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const id = z
  .string()
  .min(1)
  .max(100)
  .refine((s) => !CONTROL.test(s), 'Not a valid id.')
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes('\u0000'), 'Text can’t contain NUL characters.')
const day = z
  .string()
  .max(10)
  .refine((v) => !hasTime(v) && normalizeTaskDate(v) === v, 'Dates look like 2026-10-31.')
const pct = z
  .number()
  .int()
  .refine((v): v is Percent => (PERCENTS as readonly number[]).includes(v), 'Time on a project is 25, 50, 75 or 100%.')
  .transform((v) => v as Percent)
const color = z.enum(COLORS.map((c) => c.id) as [ColorName, ...ColorName[]])
const md = z.number().min(0).max(1_000_000).nullable()
const hours = z.number().min(0.5).max(24)
const position = z.string().refine(isPosition, 'Not a valid position.')
const moment = z.string().max(40)
const meta = {
  createdAt: moment,
  updatedAt: moment,
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}

const RoleSchema = z.object({ id, name: text(20), position, ...meta }).strict()
const PersonSchema = z
  .object({ id, userId: id.nullable(), name: text(100), roleId: id.nullable(), hoursPerDay: hours, position: position.nullable(), ...meta })
  .strict()
const slot = z.number().int().min(0).max(19)
const ProjectSchema = z
  .object({
    id,
    name: text(100),
    client: text(100),
    plannedMd: md,
    color,
    position,
    finishedAt: moment.nullable(),
    openLines: z.number().int().min(1).max(20),
    boardId: id.nullable(),
    prospect: z.boolean(),
    ...meta,
  })
  .strict()
const LineSchema = z.object({ id, projectId: id, personId: id, ...meta }).strict()
const BlockSchema = z.object({ id, projectId: id, personId: id.nullable(), slot, start: day, end: day, pct, ...meta }).strict()

const change = <K extends string, T extends z.ZodType>(entity: K, record: T) =>
  z.object({ entity: z.literal(entity), id, before: record.nullable(), after: record.nullable() })
export const PlanChangeSchema = z.discriminatedUnion('entity', [
  change('role', RoleSchema),
  change('person', PersonSchema),
  change('project', ProjectSchema),
  change('line', LineSchema),
  change('block', BlockSchema),
])

export const PlanCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('block.add'),
    id: id.optional(),
    projectId: id,
    personId: id.nullable(),
    slot: slot.optional(),
    start: day,
    end: day,
    pct,
  }),
  z.object({
    type: z.literal('block.update'),
    id,
    fields: z.object({ projectId: id, personId: id.nullable(), slot, start: day, end: day, pct }).partial().strict(),
  }),
  z.object({ type: z.literal('block.split'), id, at: day, newId: id.optional() }),
  z.object({ type: z.literal('block.remove'), id }),
  z.object({
    type: z.literal('project.add'),
    id: id.optional(),
    name: text(200),
    client: text(200).optional(),
    plannedMd: md.optional(),
    color: color.optional(),
    prospect: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('project.update'),
    id,
    fields: z
      .object({ name: text(200), client: text(200), plannedMd: md, color, finished: z.boolean(), boardId: id.nullable(), prospect: z.boolean() })
      .partial()
      .strict(),
  }),
  z.object({ type: z.literal('project.move'), id, beforeId: id.optional() }),
  z.object({ type: z.literal('project.remove'), id }),
  z.object({ type: z.literal('project.addOpenLine'), id }),
  z.object({ type: z.literal('project.removeOpenLine'), id, slot }),
  z.object({ type: z.literal('person.add'), id: id.optional(), name: text(200), roleId: id.nullable().optional(), hoursPerDay: hours.optional() }),
  z.object({
    type: z.literal('person.update'),
    id,
    fields: z
      .object({ name: text(200), roleId: id.nullable(), hoursPerDay: hours })
      .partial()
      .strict(),
  }),
  z.object({ type: z.literal('person.move'), id, beforeId: id.optional() }),
  z.object({ type: z.literal('person.merge'), id, into: id }),
  z.object({ type: z.literal('person.remove'), id }),
  z.object({ type: z.literal('line.add'), id: id.optional(), projectId: id, personId: id }),
  z.object({ type: z.literal('line.remove'), projectId: id, personId: id }),
  z.object({ type: z.literal('role.add'), id: id.optional(), name: text(100) }),
  z.object({ type: z.literal('role.update'), id, name: text(100) }),
  z.object({ type: z.literal('role.move'), id, beforeId: id.optional() }),
  z.object({ type: z.literal('role.remove'), id }),
  z.object({ type: z.literal('plan.restore'), changes: z.array(PlanChangeSchema).max(20_000) }),
])

// The schema and the PlanCommand type describe the same thing: this stops compiling if they drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
export const planCommandSchemaMatchesType: Same<z.infer<typeof PlanCommandSchema>, PlanCommand> = true
