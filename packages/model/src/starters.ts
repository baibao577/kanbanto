import type { ColorName } from './colors'
import { dayIn, fromDay, normalizeTaskDate, toDay } from './dates'
import { fieldKey, ME, type BoardField, type CustomValues } from './fields'
import { positionsBetween } from './position'
import { defaultDisplay, type PresetSettings } from './prefs'
import { makeTask } from './records'
import { zoned } from './reminders'
import { builtIn, type BoardData, type Category, type LabelDef, type StatusColumn, type Task, type ViewConfig } from './types'

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
 *
 * Every starter's cards are for someone: a "Client" field links each to a card of a board of clients, which comes
 * along the first time a starter is made in a space (see `clientsBoard`) and is shared from then on. A deal, a
 * request, an order and a booking for the same client then point at one card, which lists them all.
 */
export const STARTERS = ['sales', 'support', 'store', 'bookings'] as const
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
  store: {
    title: 'Store orders',
    hint: 'Orders from new to shipped, with what’s in each, what it comes to and when it has to leave.',
    name: 'Store orders',
    about: 'Orders, from new to shipped.',
  },
  bookings: {
    title: 'Bookings',
    hint: 'Appointments from booked to done, with what each is for, with whom and at what time.',
    name: 'Bookings',
    about: 'Appointments, from booked to done.',
  },
}

/** Who makes the board, and where they are: the examples' dates are theirs. */
export interface StarterContext {
  /** Example cards given to someone are given to them. */
  ownerId?: string
  /** Their time zone: "today", and a time of day, are as they are there. UTC when unknown. */
  zone?: string
  now?: Date
  /** The board the "Client" field's cards come from: the one that's there already, or the one about to be made. */
  clientsBoardId?: string
}

/** A board made from a starter, before its fields are fitted to a library. */
export interface StarterBoard {
  data: BoardData
  /** Saved filters ("presets") to make with it, in order. They name the starter's own field and option ids. */
  presets: { name: string; settings: PresetSettings }[]
  /** The example cards that are for a client: each card's id, and the client's name (a card of the Clients board). */
  clients: Record<string, string>
}

/** The field all starters share, a link to a card of the Clients board: the starter's own id for it, and its name. */
export const CLIENT_FIELD = 'st-client'
export const CLIENT_NAME = 'Client'
const clientField = (clientsBoardId?: string): BoardField => ({
  id: CLIENT_FIELD,
  name: CLIENT_NAME,
  type: 'link',
  linkTo: 'board',
  ...(clientsBoardId && { board: clientsBoardId }),
  // (What the list of cards pointing at a client is called, on the client's card.)
  back: 'For this client',
  front: true,
})

const list = (id: string, name: string, category: Category): Omit<StatusColumn, 'position'> => ({ id, name, category, ...builtIn() })
const label = (id: string, name: string, color: ColorName): LabelDef => ({ id, name, color, ...builtIn() })
const option = (id: string, name: string, color: ColorName) => ({ id, name, color })
/** One card per task: a deal or a request keeps its subtasks on its own card. */
const view = (filter: PresetSettings['filter'] = {}, outline: PresetSettings['outline'] = {}, board: Partial<ViewConfig> = {}): PresetSettings => ({
  display: { board: { ...defaultDisplay('manual'), ...board } },
  filter,
  outline,
})

interface Card {
  title: string
  list: string
  description?: string
  labels?: string[]
  priority?: Task['priority']
  custom?: CustomValues
  /** Days from today where the owner is; with `at` ("14:30"), a time of day there. */
  due?: number | { day: number; at: string }
  /** Given to whoever makes the board. */
  mine?: boolean
  /** Who it's for: a client's name (see `clientsBoard`). */
  client?: string
  /** Its subtasks, in order. Ticked ones are in the first list that counts as done, the rest in the first list. */
  steps?: { title: string; done?: boolean }[]
}

/** The owner's dates: `day(2)` is the day after tomorrow there, `at(1, '14:00')` two in the afternoon tomorrow. */
function dates(who: StarterContext) {
  const zone = who.zone ?? 'UTC'
  const today = toDay(dayIn(who.now ?? new Date(), zone))
  const day = (from: number) => fromDay(today + from)
  const at = (from: number, time: string) => {
    const [hour, minute] = time.split(':').map(Number)
    return normalizeTaskDate(zoned(day(from), hour, zone, minute).toISOString())!
  }
  return { day, at }
}

function board(
  kind: Starter,
  boardId: string,
  who: StarterContext,
  lists: Omit<StatusColumn, 'position'>[],
  labels: LabelDef[],
  fields: BoardField[],
  cards: Card[],
  presets: StarterBoard['presets'],
): StarterBoard {
  const { day, at } = dates(who)
  const keys = positionsBetween(null, null, lists.length)
  const order = positionsBetween(null, null, cards.length)
  const first = lists[0].id
  const finished = lists.find((l) => l.category === 'done')?.id ?? first
  const tasks: Task[] = []
  const clients: Record<string, string> = {}
  for (const [i, c] of cards.entries()) {
    const id = `${kind}-${i + 1}`
    if (c.client) clients[id] = c.client
    tasks.push(
      makeTask({
        id,
        title: c.title,
        status: c.list,
        order: order[i],
        ...(c.description && { description: c.description }),
        ...(c.labels && { labels: c.labels }),
        ...(c.priority && { priority: c.priority }),
        ...(c.due !== undefined && { due: typeof c.due === 'number' ? day(c.due) : at(c.due.day, c.due.at) }),
        ...(c.mine && who.ownerId && { assigneeId: who.ownerId }),
        ...(c.custom && Object.keys(c.custom).length && { custom: c.custom }),
      }),
    )
    const under = positionsBetween(null, null, c.steps?.length ?? 0)
    for (const [j, step] of (c.steps ?? []).entries())
      tasks.push(makeTask({ id: `${id}-${j + 1}`, title: step.title, parentId: id, status: step.done ? finished : first, order: under[j] }))
  }
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
    clients,
  }
}

function sales(boardId: string, who: StarterContext): StarterBoard {
  const { day } = dates(who)
  const F = { value: 'st-sales-value', email: 'st-sales-email', close: 'st-sales-close', source: 'st-sales-source' }
  const fields: BoardField[] = [
    { id: F.value, name: 'Deal value', type: 'number', unit: '$', decimals: 0, sum: true, front: true, total: true },
    clientField(who.clientsBoardId),
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
    client: string,
    email: string,
    source: string,
    close: number,
    description?: string,
  ): Card => ({
    title,
    list: where,
    client,
    ...(description && { description }),
    custom: { [F.value]: value, [F.email]: email, [F.close]: day(close), [F.source]: [`st-source-${source}`] },
  })
  return board(
    'sales',
    boardId,
    who,
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
        'An example deal: open it to see its fields, then drag it to the next list as it moves along. Its client is a card on the Clients board: open that one to see every deal for them. Delete the examples when you’re ready.',
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

function support(boardId: string, who: StarterContext): StarterBoard {
  const { day } = dates(who)
  const F = { severity: 'st-support-severity', email: 'st-support-email', channel: 'st-support-channel', reported: 'st-support-reported' }
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
    clientField(who.clientsBoardId),
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
    client: string,
    email: string,
    channel: string,
    reported: number,
    tag: string,
    description?: string,
  ): Card => ({
    title,
    list: where,
    labels: [tag],
    client,
    ...(description && { description }),
    custom: { [F.severity]: [`st-severity-${severity}`], [F.email]: email, [F.channel]: [`st-channel-${channel}`], [F.reported]: day(reported) },
  })
  return board(
    'support',
    boardId,
    who,
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
        'An example request: open it to see its fields, then drag it along as it’s worked on. Its client is a card on the Clients board: open that one to see everything they’ve asked. Delete the examples when you’re ready.',
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

/**
 * An online shop's orders. "Ship by" is the card's own due date, so a late order shows as overdue and the Timeline
 * works; an order's items are its subtasks, ticked as they're packed. Orders are moved along by hand.
 */
function store(boardId: string, who: StarterContext): StarterBoard {
  const F = { total: 'st-store-total', shipping: 'st-store-shipping', tracking: 'st-store-tracking' }
  const fields: BoardField[] = [
    { id: F.total, name: 'Order total', type: 'number', unit: '$', decimals: 2, sum: true, front: true, total: true },
    {
      id: F.shipping,
      name: 'Shipping',
      type: 'choice',
      front: true,
      options: [
        option('st-shipping-standard', 'Standard', 'gray'),
        option('st-shipping-express', 'Express', 'orange'),
        option('st-shipping-collection', 'Collection', 'teal'),
      ],
    },
    clientField(who.clientsBoardId),
    { id: F.tracking, name: 'Tracking number', type: 'text' },
  ]
  const order = (
    title: string,
    where: string,
    client: string,
    total: number,
    shipping: string,
    due: number,
    steps: Card['steps'],
    extra: { labels?: string[]; tracking?: string; description?: string } = {},
  ): Card => ({
    title,
    list: where,
    client,
    due,
    steps,
    ...(extra.labels && { labels: extra.labels }),
    ...(extra.description && { description: extra.description }),
    // (The total is on the order alone: a card adds up together with its subtasks.)
    custom: { [F.total]: total, [F.shipping]: [`st-shipping-${shipping}`], ...(extra.tracking && { [F.tracking]: extra.tracking }) },
  })
  return board(
    'store',
    boardId,
    who,
    [list('new', 'New', 'todo'), list('packing', 'Packing', 'doing'), list('packed', 'Packed', 'doing'), list('shipped', 'Shipped', 'done')],
    [label('wholesale', 'Wholesale', 'violet'), label('made', 'Made to order', 'amber'), label('gift', 'Gift', 'pink')],
    fields,
    [
      order(
        'Order 1042: Dana Keller',
        'new',
        'Dana Keller',
        86,
        'express',
        0,
        [{ title: 'Linen apron, sand' }, { title: 'Oak serving board' }, { title: 'Beeswax candle' }],
        {
          description:
            'An example order: its due date is when it has to leave, and its subtasks are what’s in it. Tick them as you pack, then drag the order along. Its client is a card on the Clients board: open that one to see everything they’ve ordered. Delete the examples when you’re ready.',
        },
      ),
      order('Order 1043: Priya Nair', 'new', 'Priya Nair', 34, 'standard', 0, [{ title: 'Beeswax candle, set of two' }], { labels: ['gift'] }),
      order(
        'Order 1041: Blue Harbor Cafe',
        'packing',
        'Blue Harbor Cafe',
        196,
        'standard',
        1,
        [{ title: 'Linen apron, sand (8)', done: true }, { title: 'Oak serving board (4)' }],
        { labels: ['wholesale'] },
      ),
      order('Order 1039: Jonas Weber', 'packing', 'Jonas Weber', 52, 'standard', -1, [{ title: 'Engraved oak board' }, { title: 'Gift wrap' }], {
        labels: ['made'],
      }),
      order(
        'Order 1038: Mai Tran',
        'shipped',
        'Mai Tran',
        118,
        'express',
        -2,
        [
          { title: 'Linen apron, charcoal', done: true },
          { title: 'Oak serving board', done: true },
        ],
        { tracking: 'DX 4821 9930' },
      ),
    ],
    [
      { name: 'Leaves today', settings: view({ dueIs: { on: 'today' } }) },
      { name: 'Late', settings: view({ due: 'overdue' }) },
      { name: 'By ship-by date (Outline)', settings: view({}, { sort: { key: 'due', dir: 'asc' } }) },
    ],
  )
}

/**
 * Appointments, with a salon's services to start from (rename them for a clinic, a studio, a workshop). The time is
 * the card's own due date and time, and "with whom" is who it's assigned to, so a booking shows in that person's
 * calendar.
 */
function bookings(boardId: string, who: StarterContext): StarterBoard {
  const F = { service: 'st-bookings-service', price: 'st-bookings-price', deposit: 'st-bookings-deposit' }
  const fields: BoardField[] = [
    {
      id: F.service,
      name: 'Service',
      type: 'choice',
      front: true,
      options: [
        option('st-service-cut', 'Cut', 'blue'),
        option('st-service-colour', 'Colour', 'violet'),
        option('st-service-nails', 'Nails', 'green'),
        option('st-service-treatment', 'Treatment', 'teal'),
      ],
    },
    { id: F.price, name: 'Price', type: 'number', unit: '$', decimals: 0, sum: true, front: true, total: true },
    clientField(who.clientsBoardId),
    { id: F.deposit, name: 'Deposit paid', type: 'checkbox' },
  ]
  const booking = (
    title: string,
    where: string,
    client: string,
    service: string,
    price: number,
    due: { day: number; at: string },
    extra: { deposit?: boolean; mine?: boolean; description?: string } = {},
  ): Card => ({
    title,
    list: where,
    client,
    due,
    ...(extra.mine && { mine: true }),
    ...(extra.description && { description: extra.description }),
    custom: { [F.service]: [`st-service-${service}`], [F.price]: price, ...(extra.deposit && { [F.deposit]: true }) },
  })
  return board(
    'bookings',
    boardId,
    who,
    [list('booked', 'Booked', 'todo'), list('arrived', 'Arrived', 'doing'), list('done', 'Done', 'done'), list('noshow', 'No-show', 'done')],
    [],
    fields,
    [
      booking(
        'Dana Keller: colour',
        'booked',
        'Dana Keller',
        'colour',
        95,
        { day: 1, at: '10:00' },
        {
          deposit: true,
          description:
            'An example booking: its due date and time are when it is, and who it’s assigned to is who it’s with (it then shows in their calendar). Drag it along when they arrive and when it’s done. Its client is a card on the Clients board: open that one to see every visit. Delete the examples when you’re ready.',
        },
      ),
      booking('Priya Nair: cut', 'booked', 'Priya Nair', 'cut', 45, { day: 1, at: '14:00' }),
      booking('Jonas Weber: treatment', 'booked', 'Jonas Weber', 'treatment', 60, { day: 2, at: '11:30' }),
      // (Finished, so given to the owner without landing in their morning email; and the one booking that is today.)
      booking('Mai Tran: cut', 'done', 'Mai Tran', 'cut', 45, { day: 0, at: '09:30' }, { mine: true }),
      booking('Dana Keller: nails', 'noshow', 'Dana Keller', 'nails', 40, { day: -1, at: '16:00' }),
    ],
    [
      { name: 'Today', settings: view({ dueIs: { on: 'today' } }, {}, { listOrder: { booked: 'due' } }) },
      { name: 'This week', settings: view({ dueIs: { on: 'this-week' } }, {}, { listOrder: { booked: 'due' } }) },
      { name: 'Mine', settings: view({ assignees: [ME] }) },
      {
        name: 'The day in order (Outline)',
        settings: view(
          {},
          {
            sort: { key: 'due', dir: 'asc' },
            order: ['due', fieldKey(F.service), 'assignee', fieldKey(F.price), fieldKey(CLIENT_FIELD)],
            hidden: ['labels', 'priority', 'progress', 'start'],
          },
        ),
      },
    ],
  )
}

const BUILDERS: Record<Starter, (boardId: string, who: StarterContext) => StarterBoard> = { sales, support, store, bookings }

/**
 * The board a starter makes, under `boardId`. Dates are relative to today where the owner is, so the examples always
 * look current.
 */
export function starterBoard(kind: Starter, boardId: string, who: StarterContext = {}): StarterBoard {
  return BUILDERS[kind](boardId, who)
}

// ── The clients ─────────────────────────────────────────

/** What the board of clients is called when a starter makes it. */
export const CLIENTS_BOARD_NAME = 'Clients'

/** The example clients the starters' cards are for, and how to reach them. */
const CLIENTS: Record<string, { email: string; phone: string }> = {
  'Northwind Traders': { email: 'jordan@northwind.example', phone: '+1 555 0101' },
  'Blue Harbor Cafe': { email: 'sam@blueharbor.example', phone: '+1 555 0102' },
  'Pinecrest Dental': { email: 'taylor@pinecrest.example', phone: '+1 555 0103' },
  'Larkspur Studio': { email: 'alex@larkspur.example', phone: '+1 555 0104' },
  'Summit Cycles': { email: 'riley@summitcycles.example', phone: '+1 555 0105' },
  'Dana Keller': { email: 'dana.keller@example.com', phone: '+1 555 0106' },
  'Priya Nair': { email: 'priya.nair@example.com', phone: '+1 555 0107' },
  'Jonas Weber': { email: 'jonas.weber@example.com', phone: '+1 555 0108' },
  'Mai Tran': { email: 'mai.tran@example.com', phone: '+1 555 0109' },
}

/** Every example client's name: the ones a board of clients starts with. */
export const EXAMPLE_CLIENTS = Object.keys(CLIENTS)

/**
 * The board of clients that comes with the first starter made in a space: a card for each of `names`, with how to
 * reach them. (It's made with every example client, that starter's first: whichever starter is made next finds the
 * clients its own examples are for, and nothing has to be added to a board that may be in use by then.) Its cards are what every starter's "Client" field links
 * to. Like a starter's, its fields are fitted to a library before it's saved.
 */
export function clientsBoard(boardId: string, names: string[]): BoardData {
  const F = { email: 'st-clients-email', phone: 'st-clients-phone' }
  const order = positionsBetween(null, null, names.length)
  const keys = positionsBetween(null, null, 2)
  const tasks = names.map((name, i) =>
    makeTask({
      id: `client-${i + 1}`,
      title: name,
      status: 'clients',
      order: order[i],
      ...(i === 0 && {
        description:
          'An example client. Cards on other boards point here with their Client field: scroll down to “Linked from” to see everything that’s for them. Add a card here for each of your own clients, then pick it on a deal, a request, an order or a booking. Delete the examples when you’re ready.',
      }),
      ...(CLIENTS[name] && { custom: { [F.email]: CLIENTS[name].email, [F.phone]: CLIENTS[name].phone } }),
    }),
  )
  return {
    board: {
      id: boardId,
      name: CLIENTS_BOARD_NAME,
      mode: 'manual',
      description: 'Who the work is for, a card each. Other boards link to them with their Client field.',
      ...builtIn(),
    },
    members: [],
    columns: [
      { ...list('clients', 'Clients', 'todo'), position: keys[0] },
      { ...list('past', 'Past clients', 'done'), position: keys[1] },
    ],
    labels: [],
    fields: [
      { id: F.email, name: 'Email', type: 'text', format: 'email', front: true },
      { id: F.phone, name: 'Phone', type: 'text', format: 'phone', front: true },
    ],
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  }
}
