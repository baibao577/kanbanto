import { z } from 'zod'
import type { Command, TaskFields } from './commands'
import { tidyCustom, type BoardField, type CustomValues, type FieldDef } from './fields'
import { descendantsOf, indexFor } from './indexer'
import type { BoardRule } from './rules'
import { PRIORITIES, type BoardData, type LabelDef, type Priority, type StatusColumn, type StatusMode } from './types'

// Templates: a card, or a board, saved to start the next one from. Work that repeats with the same steps (a new
// client, a release, a booking) is started from a card template; a board for each client or event from a board
// template. A template is a copy taken when it is saved: it sits apart from every view, count and search, nobody
// can work in it by mistake, and it is changed by saving over it.
//
// A card template lives with its board (its labels and fields are the board's, so they always fit) and holds the
// card with everything under it. What it keeps is what a card *is*: its title, description, labels, priority, the
// board's own fields that aren't about a day or a person, and which of its steps wait on which. What it leaves is
// what happened to one card: who it was assigned to, its dates and reminders, comments, files, logged time, its
// number and its cover. A board template holds a board's shape: its lists, labels, fields, rules and its card
// templates, and never its cards or its people.

/** Card templates one board keeps, board templates one person or workspace keeps, and cards one template holds. */
export const TEMPLATES_MAX = 30
export const TEMPLATE_CARDS_MAX = 200
export const TEMPLATE_NAME_MAX = 100
/**
 * How much one card template may hold, and one board template with the card templates in it, in letters as they
 * are kept: a template is a card's shape, a few pages at most, not a store for 200 full descriptions. (Without a
 * most, thirty of them could weigh hundreds of megabytes, read whole whenever templates are listed.)
 */
export const TEMPLATE_TEXT_MAX = 500_000
export const BOARD_TEMPLATE_TEXT_MAX = 4_000_000

/** One card of a template: `key` names it within the template, `parent` the card it sits under (null: the top one). */
export interface TemplateCard {
  key: string
  parent: string | null
  title: string
  description?: string
  /** Label ids of the board it was saved on. */
  labels?: string[]
  priority?: Priority
  /** Its values for the board's fields, by field id (text, numbers, choices, ticks). */
  custom?: CustomValues
  /** The cards of this template it waits on, by key. */
  waits?: string[]
}

/** A card template, as it's listed: its name, its cards (the first is the top one), who saved it and when. */
export interface CardTemplate {
  id: string
  name: string
  cards: TemplateCard[]
  by: string | null
  updatedAt: string
}

/** The kinds of field a template keeps a value for: not a day (it would be a past one), not a person, not a link to one card. */
const KEPT: ReadonlySet<FieldDef['type']> = new Set(['text', 'number', 'choice', 'checkbox'])

/**
 * A card and everything under it, as a template's cards: the top one first, then the outline's order, so a card
 * always comes after its parent. Says why when it can't be one.
 */
export function templateOf(data: BoardData, taskId: string): TemplateCard[] | { error: string } {
  const idx = indexFor(data)
  if (!data.tasks[taskId]) return { error: 'That card no longer exists.' }
  const ids = [taskId, ...descendantsOf(idx, taskId)]
  if (ids.length > TEMPLATE_CARDS_MAX)
    return { error: `A template holds up to ${TEMPLATE_CARDS_MAX} cards: this one has ${ids.length} with its subtasks.` }
  const key = new Map(ids.map((id, i) => [id, `c${i}`]))
  const kept = data.fields.filter((f) => KEPT.has(f.type))
  return ids.map((id): TemplateCard => {
    const t = data.tasks[id]
    const custom = tidyCustom(t.custom, kept)
    const waits = t.blockedBy.flatMap((b) => key.get(b) ?? [])
    return {
      key: key.get(id)!,
      parent: id === taskId ? null : (key.get(t.parentId!) ?? key.get(taskId)!),
      title: t.title,
      ...(t.description && { description: t.description }),
      ...(t.labels.length && { labels: t.labels }),
      ...(t.priority && { priority: t.priority }),
      ...(custom && Object.keys(custom).length && { custom }),
      ...(waits.length && { waits }),
    }
  })
}

type ImportCommand = Extract<Command, { type: 'tasks.import' }>

/**
 * The one change that adds a template's cards to a board: the top card in the list `status` (under `parentId`, when
 * it goes under a card), with what else `top` says about where it was put (a person's row gives it that person),
 * and its subtasks under it in the same list. Labels and fields the board no longer has are left out, as are
 * options that are gone. Nobody is assigned by a template, and no card gets a date.
 *
 * Answers with the command and the id the top card gets, to open or point at.
 */
export function fromTemplate(
  data: Pick<BoardData, 'labels' | 'fields'>,
  template: Pick<CardTemplate, 'name' | 'cards'>,
  to: { status: string; parentId?: string | null; top?: TaskFields },
  newId: () => string,
): { command: ImportCommand; id: string } {
  const id = new Map(template.cards.map((c) => [c.key, newId()]))
  const has = new Set(data.labels.map((l) => l.id))
  const kept = data.fields.filter((f) => KEPT.has(f.type))
  const cards = template.cards.map((c, i) => {
    const labels = c.labels?.filter((l) => has.has(l))
    const custom = tidyCustom(c.custom, kept)
    const waits = c.waits?.flatMap((k) => id.get(k) ?? [])
    return {
      id: id.get(c.key)!,
      parentId: c.parent === null || !id.has(c.parent) ? (i === 0 ? (to.parentId ?? null) : id.get(template.cards[0].key)!) : id.get(c.parent)!,
      fields: {
        ...(i === 0 ? to.top : {}),
        title: c.title,
        status: to.status,
        ...(c.description && { description: c.description }),
        ...(labels?.length && { labels }),
        ...(c.priority && { priority: c.priority }),
        ...(custom && Object.keys(custom).length && { custom }),
        ...(waits?.length && { blockedBy: waits }),
      },
    }
  })
  return { command: { type: 'tasks.import', template: template.name, cards }, id: cards[0].id }
}

/** How many steps a template's card has under it, for the list of templates ("8 steps"). */
export const stepsOf = (template: Pick<CardTemplate, 'cards'>) => Math.max(0, template.cards.length - 1)

const key = z.string().min(1).max(20)
const TemplateCardSchema = z
  .object({
    key,
    parent: key.nullable(),
    title: z.string().min(1).max(500),
    description: z.string().max(50_000).optional(),
    labels: z.array(z.string().max(100)).max(100).optional(),
    priority: z.enum(PRIORITIES).optional(),
    custom: z
      .record(z.string().max(100), z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(500)).max(100)]))
      .optional(),
    waits: z.array(key).max(50).optional(),
  })
  .strict()

/** A template's cards as they're kept: checked when read, so nothing out of shape ever reaches a board. Null: not a template. */
export function readTemplateCards(raw: unknown): TemplateCard[] | null {
  const read = z.array(TemplateCardSchema).min(1).max(TEMPLATE_CARDS_MAX).safeParse(raw)
  if (!read.success) return null
  const keys = new Set<string>()
  // (The top card first, each other card after its parent, no key twice.)
  for (const [i, c] of read.data.entries()) {
    if (keys.has(c.key) || (i === 0 ? c.parent !== null : !c.parent || !keys.has(c.parent))) return null
    keys.add(c.key)
  }
  return read.data
}

/**
 * A board's shape, as a board template keeps it: how its parents behave, its look and what it is for, its lists,
 * labels, fields and rules, and its card templates. Never its cards, its people or what it is connected to.
 */
export interface BoardTemplateContent {
  board: { mode: StatusMode; background?: string; description?: string }
  columns: StatusColumn[]
  labels: LabelDef[]
  fields: BoardField[]
  rules?: BoardRule[]
  cardTemplates: { name: string; cards: TemplateCard[] }[]
}

/** A board template, as it's listed: its name, where it is kept, and what it holds in a few numbers. */
export interface BoardTemplate {
  id: string
  name: string
  /** The workspace it belongs to (null: the person's own). */
  workspaceId: string | null
  lists: number
  fields: number
  cardTemplates: number
  by: string | null
  updatedAt: string
  /** The person asking may rename, replace and remove it. */
  canChange: boolean
}

/** The shape of a board as it is now, to keep as a template (see `BoardTemplateContent`). */
export function boardTemplateOf(data: BoardData, cardTemplates: readonly Pick<CardTemplate, 'name' | 'cards'>[]): BoardTemplateContent {
  const { mode, background, description } = data.board
  return {
    board: { mode, ...(background && { background }), ...(description && { description }) },
    columns: data.columns,
    labels: data.labels,
    fields: data.fields,
    ...(data.rules?.length && { rules: data.rules }),
    cardTemplates: cardTemplates.map((t) => ({ name: t.name, cards: t.cards })),
  }
}
