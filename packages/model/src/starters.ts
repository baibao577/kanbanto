import type { ColorName } from './colors'
import { fromDay, todayDay } from './dates'
import { fieldKey, type BoardField, type CustomValues } from './fields'
import { positionsBetween } from './position'
import { defaultDisplay, type PresetSettings } from './prefs'
import { makeTask } from './records'
import { builtIn, type BoardData, type Category, type LabelDef, type StatusColumn, type Task } from './types'

/**
 * Starter boards: a board for a kind of work, ready to use. Its lists, the fields it needs, a few saved filters and
 * some example cards to show how it's meant to be filled in.
 *
 * A starter is plain data built by a function, like the example board. Its fields are named by ids of its own
 * ("st-…"): whoever makes the board fits them to a library first (see `planStarter` in fields.ts), so the board ends
 * up with that library's fields, and the cards' values and the saved filters are carried over to them.
 *
 * The ids of a choice's options are different: a field added to a library keeps them, so they are in people's data
 * from then on. Never change one; add new ones.
 */
export const STARTERS = ['sales', 'support'] as const
export type Starter = (typeof STARTERS)[number]

export const isStarter = (x: string): x is Starter => (STARTERS as readonly string[]).includes(x)

/** What a starter is called where you pick one, what it says there, and the name a board made from it gets if none is given. */
export const STARTER_INFO: Record<Starter, { title: string; hint: string; name: string; about: string }> = {
  sales: {
    title: 'A sales pipeline',
    hint: 'Deals from first contact to won or lost, with what each is worth and when it should close.',
    name: 'Sales pipeline',
    about: 'Deals from first contact to won or lost.',
  },
  support: {
    title: 'A support desk',
    hint: 'Customer requests from new to solved, with how serious each is and who it came from.',
    name: 'Support desk',
    about: 'Customer requests, from new to solved.',
  },
}

/** A board made from a starter, before its fields are fitted to a library. */
export interface StarterBoard {
  data: BoardData
  /** Saved filters ("presets") to make with it, in order. They name the starter's own field and option ids. */
  presets: { name: string; settings: PresetSettings }[]
}

const list = (id: string, name: string, category: Category): Omit<StatusColumn, 'position'> => ({ id, name, category, ...builtIn() })
const label = (id: string, name: string, color: ColorName): LabelDef => ({ id, name, color, ...builtIn() })
const option = (id: string, name: string, color: ColorName) => ({ id, name, color })
/** One card per task: a deal or a request keeps its subtasks on its own card. */
const view = (filter: PresetSettings['filter'] = {}, outline: PresetSettings['outline'] = {}): PresetSettings => ({
  display: { board: defaultDisplay('manual') },
  filter,
  outline,
})

interface Card {
  title: string
  list: string
  description?: string
  labels?: string[]
  priority?: Task['priority']
  custom: CustomValues
}

function board(
  kind: Starter,
  boardId: string,
  lists: Omit<StatusColumn, 'position'>[],
  labels: LabelDef[],
  fields: BoardField[],
  cards: Card[],
  presets: StarterBoard['presets'],
): StarterBoard {
  const keys = positionsBetween(null, null, lists.length)
  const order = positionsBetween(null, null, cards.length)
  const tasks = cards.map((c, i) =>
    makeTask({
      id: `${kind}-${i + 1}`,
      title: c.title,
      status: c.list,
      order: order[i],
      ...(c.description && { description: c.description }),
      ...(c.labels && { labels: c.labels }),
      ...(c.priority && { priority: c.priority }),
      custom: c.custom,
    }),
  )
  return {
    data: {
      // (Set by hand: a deal's stage is the list it's in, not something worked out from its subtasks.)
      board: { id: boardId, name: STARTER_INFO[kind].name, mode: 'manual', description: STARTER_INFO[kind].about, ...builtIn() },
      members: [],
      columns: lists.map((l, i) => ({ ...l, position: keys[i] })),
      labels,
      fields,
      tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    },
    presets,
  }
}

function sales(boardId: string): StarterBoard {
  const day = (from: number) => fromDay(todayDay() + from)
  const F = { value: 'st-sales-value', company: 'st-sales-company', email: 'st-sales-email', close: 'st-sales-close', source: 'st-sales-source' }
  const fields: BoardField[] = [
    { id: F.value, name: 'Deal value', type: 'number', unit: '$', decimals: 0, sum: true, front: true, total: true },
    { id: F.company, name: 'Company', type: 'text' },
    { id: F.email, name: 'Contact email', type: 'text', format: 'email' },
    { id: F.close, name: 'Close date', type: 'date', front: true },
    {
      id: F.source,
      name: 'Source',
      type: 'choice',
      options: [
        option('st-source-referral', 'Referral', 'green'),
        option('st-source-website', 'Website', 'blue'),
        option('st-source-outreach', 'Outreach', 'violet'),
        option('st-source-event', 'Event', 'amber'),
      ],
    },
  ]
  const deal = (
    title: string,
    where: string,
    value: number,
    company: string,
    email: string,
    source: string,
    close: number,
    description?: string,
  ): Card => ({
    title,
    list: where,
    ...(description && { description }),
    custom: { [F.value]: value, [F.company]: company, [F.email]: email, [F.close]: day(close), [F.source]: [`st-source-${source}`] },
  })
  return board(
    'sales',
    boardId,
    [
      list('leads', 'Leads', 'todo'),
      list('contacted', 'Contacted', 'doing'),
      list('proposal', 'Proposal', 'doing'),
      list('won', 'Won', 'done'),
      list('lost', 'Lost', 'done'),
    ],
    [],
    fields,
    [
      deal(
        'Northwind Traders: new website',
        'leads',
        12000,
        'Northwind Traders',
        'jordan@northwind.example',
        'website',
        21,
        'An example deal: open it to see its fields, then drag it to the next list as it moves along. Delete the examples when you’re ready.',
      ),
      deal('Blue Harbor Cafe: online ordering', 'contacted', 8400, 'Blue Harbor Cafe', 'sam@blueharbor.example', 'referral', 5),
      deal('Pinecrest Dental: booking app', 'proposal', 36500, 'Pinecrest Dental', 'taylor@pinecrest.example', 'event', 3),
      deal('Larkspur Studio: brand refresh', 'proposal', 9500, 'Larkspur Studio', 'alex@larkspur.example', 'outreach', 12),
      deal('Summit Cycles: support plan', 'won', 15000, 'Summit Cycles', 'riley@summitcycles.example', 'referral', -4),
    ],
    [
      { name: 'Closing in the next 7 days', settings: view({ fields: { [F.close]: { date: 'week' } } }) },
      { name: 'Deals of 10,000 and up', settings: view({ fields: { [F.value]: { min: 10000 } } }) },
    ],
  )
}

function support(boardId: string): StarterBoard {
  const day = (from: number) => fromDay(todayDay() + from)
  const F = {
    severity: 'st-support-severity',
    customer: 'st-support-customer',
    email: 'st-support-email',
    channel: 'st-support-channel',
    reported: 'st-support-reported',
  }
  const fields: BoardField[] = [
    {
      id: F.severity,
      name: 'Severity',
      type: 'choice',
      front: true,
      options: [
        option('st-severity-low', 'Low', 'gray'),
        option('st-severity-normal', 'Normal', 'blue'),
        option('st-severity-high', 'High', 'orange'),
        option('st-severity-critical', 'Critical', 'red'),
      ],
    },
    { id: F.customer, name: 'Customer', type: 'text' },
    { id: F.email, name: 'Customer email', type: 'text', format: 'email' },
    {
      id: F.channel,
      name: 'Channel',
      type: 'choice',
      options: [option('st-channel-email', 'Email', 'sky'), option('st-channel-chat', 'Chat', 'teal'), option('st-channel-phone', 'Phone', 'violet')],
    },
    { id: F.reported, name: 'Reported on', type: 'date' },
  ]
  const ticket = (
    title: string,
    where: string,
    severity: string,
    customer: string,
    email: string,
    channel: string,
    reported: number,
    tag: string,
    description?: string,
  ): Card => ({
    title,
    list: where,
    labels: [tag],
    ...(description && { description }),
    custom: {
      [F.severity]: [`st-severity-${severity}`],
      [F.customer]: customer,
      [F.email]: email,
      [F.channel]: [`st-channel-${channel}`],
      [F.reported]: day(reported),
    },
  })
  return board(
    'support',
    boardId,
    [
      list('new', 'New', 'todo'),
      list('working', 'In progress', 'doing'),
      list('waiting', 'Waiting on customer', 'doing'),
      list('solved', 'Solved', 'done'),
    ],
    [label('bug', 'Bug', 'red'), label('question', 'Question', 'blue'), label('billing', 'Billing', 'green')],
    fields,
    [
      ticket(
        'Can’t sign in after a password reset',
        'new',
        'high',
        'Northwind Traders',
        'dana@northwind.example',
        'email',
        0,
        'bug',
        'An example request: open it to see its fields, then drag it along as it’s worked on. Delete the examples when you’re ready.',
      ),
      ticket('The app closes when a photo is attached', 'working', 'critical', 'Pinecrest Dental', 'taylor@pinecrest.example', 'chat', -1, 'bug'),
      ticket('The invoice shows the wrong tax rate', 'working', 'normal', 'Blue Harbor Cafe', 'sam@blueharbor.example', 'email', -2, 'billing'),
      ticket('How do I add a second person?', 'waiting', 'low', 'Larkspur Studio', 'alex@larkspur.example', 'chat', -3, 'question'),
      ticket('The spreadsheet export misses a column', 'solved', 'normal', 'Summit Cycles', 'riley@summitcycles.example', 'phone', -6, 'bug'),
    ],
    [
      {
        name: 'High and critical',
        settings: view({ fields: { [F.severity]: { in: ['st-severity-high', 'st-severity-critical'] } } }),
      },
      { name: 'Most severe first (Outline)', settings: view({}, { sort: { key: fieldKey(F.severity), dir: 'desc' } }) },
    ],
  )
}

/** The board a starter makes, under `boardId`. Dates are relative to today, so the examples always look current. */
export function starterBoard(kind: Starter, boardId: string): StarterBoard {
  return kind === 'sales' ? sales(boardId) : support(boardId)
}
