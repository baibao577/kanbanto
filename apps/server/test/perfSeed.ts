import { bigBoard, bigFieldSpecs, type BigBoard, type BigFieldSpec } from '@kanbanto/model/bigBoard'
import { LABEL_COLOR_CYCLE } from '@kanbanto/model/colors'
import type { BoardField } from '@kanbanto/model/fields'
import type { BoardData } from '@kanbanto/model/types'
import { inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { taskToRow } from '../src/boards/records'
import type { Db } from '../src/db'
import { boards, tasks } from '../src/db/schema'
import { mid, Person } from './helpers'

/**
 * A big workspace to measure against (see perf.test.ts, and perfSeedRun.ts for a site to open in a browser).
 *
 * Acme, with its people, a library of 50 fields and 25 boards: "Deals", the main board, with twenty fields of every
 * kind; "Companies", which the deals link to; eight more boards with the same fields and links; fifteen small ones.
 * People, fields and boards are made the way the app makes them, through its API. The cards are made up by the
 * model's `bigBoard` and written straight into the `tasks` table, which is the only way to have this many in a few
 * seconds: afterwards every board's change counter goes up, so the server reads them afresh.
 */
export interface PerfSizes {
  /** People in the workspace (30; 10 is enough where signing up is slow). */
  people: number
  /** Cards on the main board, and archived ones beside them. */
  cards: number
  archived: number
  /** Whether the main board's cards nest (see `bigBoard`). */
  shape: 'flat' | 'nested'
  /** Cards on the Companies board. */
  companies: number
  /** Cards on each of the eight boards that link to Companies too, and on each of the fifteen small ones. */
  linking: number
  small: number
}

/** The sizes, from the environment: PERF_PEOPLE, PERF_CARDS, PERF_ARCHIVED, PERF_SHAPE, PERF_COMPANIES, PERF_LINKING, PERF_SMALL. */
export function perfSizes(env: Record<string, string | undefined> = process.env): PerfSizes {
  const n = (name: string, fallback: number) => {
    const v = Number(env[name] ?? fallback)
    if (!Number.isInteger(v) || v < 1) throw new Error(`${name} is a whole number, 1 or more.`)
    return v
  }
  return {
    people: Math.min(n('PERF_PEOPLE', 30), NAMES.length),
    cards: n('PERF_CARDS', 10_000),
    archived: n('PERF_ARCHIVED', 3000),
    shape: env.PERF_SHAPE === 'nested' ? 'nested' : 'flat',
    companies: n('PERF_COMPANIES', 4000),
    linking: n('PERF_LINKING', 500),
    small: n('PERF_SMALL', 200),
  }
}

export interface PerfSeed {
  sizes: PerfSizes
  /** Ann made the workspace and everything in it: its admin, and an owner of every board. */
  ann: Person
  /** Everyone else in the workspace. */
  others: Person[]
  ws: string
  /** The main board, as it was made up (its cards, and which field is which). */
  main: { id: string; big: BigBoard }
  companies: { id: string; cards: string[] }
  linking: string[]
  small: string[]
  /** The library's fields by name. */
  fieldIds: Record<string, string>
  /** How long each part of making it took, in ms. */
  took: Record<string, number>
}

const NAMES = [
  'Ann',
  'Bob',
  'Cat',
  'Dan',
  'Eve',
  'Fay',
  'Gus',
  'Hal',
  'Ivy',
  'Jon',
  'Kim',
  'Lee',
  'Max',
  'Nia',
  'Oli',
  'Pam',
  'Quin',
  'Ray',
  'Sue',
  'Tom',
  'Uma',
  'Vic',
  'Wes',
  'Xan',
  'Yan',
  'Zoe',
  'Abe',
  'Bea',
  'Cal',
  'Dee',
]

/** The library's other thirty fields: five each of text, number, date, choice, checkbox and person. */
function extraSpecs(): BigFieldSpec[] {
  const kinds: ((n: number) => BigFieldSpec)[] = [
    (n) => ({ name: `Detail ${n}`, type: 'text' }),
    (n) => ({ name: `Count ${n}`, type: 'number', decimals: 0 }),
    (n) => ({ name: `Milestone ${n}`, type: 'date' }),
    (n) => ({
      name: `Kind ${n}`,
      type: 'choice',
      options: Array.from({ length: 8 }, (_, i) => ({ name: `Kind ${n}.${i + 1}`, color: LABEL_COLOR_CYCLE[i] })),
    }),
    (n) => ({ name: `Flag ${n}`, type: 'checkbox' }),
    (n) => ({ name: `Helper ${n}`, type: 'person' }),
  ]
  return Array.from({ length: 30 }, (_, i) => kinds[i % kinds.length](Math.floor(i / kinds.length) + 1))
}

const CHUNK = 500

export async function seedPerf(app: FastifyInstance, db: Db, sizes: PerfSizes, say: (line: string) => void = () => {}): Promise<PerfSeed> {
  const took: Record<string, number> = {}
  const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now()
    const out = await run()
    took[what] = Math.round(performance.now() - started)
    say(`${what}: ${took[what]} ms`)
    return out
  }

  // People, and the workspace they're all in.
  const [ann, ...others] = await step(`sign up ${sizes.people} people`, async () => {
    const all: Person[] = []
    for (const name of NAMES.slice(0, sizes.people)) all.push(await Person.signUp(app, name))
    return all
  })
  const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
  for (const p of others) await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: p.user.email })

  // 25 boards.
  const board = async (name: string) => (await ann.ok('POST', '/api/boards', { name, workspaceId: ws })).id as string
  const main = await board('Deals')
  const companies = await board('Companies')
  const linking: string[] = []
  for (let i = 1; i <= 8; i++) linking.push(await board(`Deals, region ${i}`))
  const small: string[] = []
  for (let i = 1; i <= 15; i++) small.push(await board(`Team board ${i}`))

  // A library of 50 fields: the twenty the big boards use, and thirty more that the small boards share out.
  const twenty = bigFieldSpecs(companies)
  const extras = extraSpecs()
  const fieldIds: Record<string, string> = {}
  await step('make 50 fields', async () => {
    for (const { front: _front, total: _total, ...spec } of [...twenty, ...extras])
      fieldIds[spec.name] = (await ann.ok('POST', `/api/workspaces/${ws}/fields`, spec)).id
  })
  const use = (boardId: string, specs: BigFieldSpec[]) =>
    ann.ok('PUT', `/api/boards/${boardId}/fields`, { fields: specs.map((s) => ({ id: fieldIds[s.name], front: !!s.front, total: !!s.total })) })
  const named = (...names: string[]) => names.map((name) => twenty.find((s) => s.name === name)!)
  // (The two text fields that are alike, "Contact" and "Contact name", are on every board: they're there to be merged.)
  const pair = named('Contact', 'Contact name')
  await step('put fields on 25 boards', async () => {
    for (const id of [main, ...linking]) await use(id, twenty)
    await use(companies, [...pair, ...named('Website', 'Email', 'Region', 'Seats', 'Renewal', 'Reviewer')])
    for (const [i, id] of small.entries()) await use(id, [...pair, ...Array.from({ length: 6 }, (_, k) => extras[(i * 2 + k) % extras.length])])
  })

  // Cards. Each board is asked for its fields and people as the server has them (their ids), and made up from those.
  const made = new Map<string, BigBoard>()
  const insert = async (boardId: string, opts: Parameters<typeof bigBoard>[0]) => {
    const { data } = await ann.ok<{ data: BoardData }>('GET', `/api/boards/${boardId}`)
    const big = bigBoard({ ...opts, boardId, name: data.board.name, fields: data.fields as BoardField[], members: data.members })
    // (The labels its cards wear, through the app: a label is a record of the board, like a card.)
    for (const l of big.data.labels)
      await ann.ok('POST', `/api/boards/${boardId}/mutations`, {
        mutationId: mid(),
        command: { type: 'label.create', id: l.id, name: l.name, color: l.color },
      })
    const rows = [...Object.values(big.data.tasks), ...Object.values(big.data.archived ?? {})].map((t) => taskToRow(boardId, t))
    for (let i = 0; i < rows.length; i += CHUNK) await db.insert(tasks).values(rows.slice(i, i + CHUNK))
    made.set(boardId, big)
    return big
  }
  const all = [main, companies, ...linking, ...small]
  const total = sizes.cards + sizes.archived + sizes.companies + sizes.linking * linking.length + sizes.small * small.length
  const { mainBig, companyCards } = await step(`write ${total.toLocaleString('en-US')} cards`, async () => {
    const co = await insert(companies, { seed: 2, cards: sizes.companies, shape: 'flat', titles: 'names' })
    const other = { boardId: companies, taskIds: Object.keys(co.data.tasks) }
    const mainBig = await insert(main, { seed: 1, cards: sizes.cards, archived: sizes.archived, shape: sizes.shape, other })
    for (const [i, id] of linking.entries()) await insert(id, { seed: 10 + i, cards: sizes.linking, shape: 'nested', other })
    for (const [i, id] of small.entries()) await insert(id, { seed: 100 + i, cards: sizes.small, shape: i % 2 ? 'nested' : 'flat' })
    // The cards arrived behind the server's back: a new change counter has it read each board again.
    await db
      .update(boards)
      .set({ seq: sql`${boards.seq} + 1` })
      .where(inArray(boards.id, all))
    // And the database is told to look at its tables again, as it does by itself every minute or so: without that it
    // plans every query for the empty tables it last saw, and what's measured is that, not the app.
    await db.execute(sql`vacuum analyze`)
    return { mainBig, companyCards: other.taskIds }
  })

  // Read back through the app: every board has the cards that were made up for it, and the main one exactly those.
  await step('read every board back', async () => {
    for (const id of all) {
      const big = made.get(id)!
      const { data } = await ann.ok<{ data: BoardData }>('GET', `/api/boards/${id}?archived=all`)
      const [got, want] = [Object.keys(data.tasks).length, Object.keys(big.data.tasks).length]
      if (got !== want) throw new Error(`${data.board.name}: ${got} cards came back, ${want} were written.`)
      const [put, away] = [Object.keys(data.archived ?? {}).length, Object.keys(big.data.archived ?? {}).length]
      if (put !== away) throw new Error(`${data.board.name}: ${put} archived cards came back, ${away} were written.`)
      if (id !== main) continue
      for (const [taskId, want] of [...Object.entries(big.data.tasks), ...Object.entries(big.data.archived ?? {})]) {
        const got = data.tasks[taskId] ?? data.archived?.[taskId]
        if (JSON.stringify(sortedKeys(got)) !== JSON.stringify(sortedKeys(want)))
          throw new Error(`“${want.title}” didn’t come back as it was written:\n${JSON.stringify(got)}\n${JSON.stringify(want)}`)
      }
    }
  })

  return {
    sizes,
    ann,
    others,
    ws,
    main: { id: main, big: mainBig },
    companies: { id: companies, cards: companyCards },
    linking,
    small,
    fieldIds,
    took,
  }
}

/** A record with its keys in order, at every level, so two that hold the same read the same. */
function sortedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedKeys)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(
    Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => [k, sortedKeys(x)]),
  )
}
