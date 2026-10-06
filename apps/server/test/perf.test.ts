import { writeFileSync } from 'node:fs'
import { linksOf, parseRef } from '@kanbanto/model/fields'
import type { Change } from '@kanbanto/model/records'
import { inArray, sql } from 'drizzle-orm'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { boards } from '../src/db/schema'
import { mid, reset, setPlatformAdmin, setup, type Person } from './helpers'
import { perfSizes, seedPerf, type PerfSeed } from './perfSeed'

/**
 * How long the server takes on a big workspace with custom fields everywhere (see perfSeed.ts): a board of 10,000
 * cards with twenty fields, 3,000 archived ones, a board of 4,000 companies they link to, 25 boards in all.
 *
 * It only runs when asked, against a throwaway database (it empties it, and takes most of a minute):
 *
 *   PERF=1 TEST_DATABASE_URL=postgres://kankan:kankan@127.0.0.1:5471/kankan_perf \
 *     pnpm --filter @kanbanto/server exec vitest run test/perf.test.ts --silent=false
 *
 * Each thing is done three times (once, where it can't be done again) and the middle time is kept. What is timed is
 * the server answering, from the request going in to the whole answer being there: not the network, and not the
 * caller reading the answer. The table is printed at the end, and written as JSON to the file named by PERF_OUT.
 * The sizes come from the environment (see `perfSizes`).
 */
const ON = !!process.env.PERF
/** Longer than any of it takes: the limit is there for something that hangs. */
const LONG = 20 * 60_000

// Every time a board is read whole from the database is noted, to tell a board served from memory from one that
// wasn't (and how many times over, when several people ask at once).
const loaded = vi.hoisted(() => ({ boards: [] as string[] }))
vi.mock('../src/boards/store', async (original) => {
  const real = await original<typeof import('../src/boards/store')>()
  const loadBoard: typeof real.loadBoard = (tx, boardId) => {
    loaded.boards.push(boardId)
    return real.loadBoard(tx, boardId)
  }
  return { ...real, loadBoard }
})

interface Line {
  /** Its number in the list of things measured, and what it was. */
  n: number
  what: string
  /** The middle time, and each one, in ms. */
  ms: number
  runs: number[]
  /** How big the answer was. */
  bytes?: number
  note?: string
}

describe.skipIf(!ON)('a workspace with a 10,000-card board and fields everywhere', { timeout: LONG }, () => {
  let t: Awaited<ReturnType<typeof setup>>
  let seed: PerfSeed
  const lines: Line[] = []
  /** What couldn't be measured, and why. */
  const notes: string[] = []

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a throwaway database: this empties it.')
    t = await setup()
    await reset(t.db)
    seed = await seedPerf(t.app, t.db, perfSizes(), (line) => console.info(`seed: ${line}`))
  }, LONG)

  afterAll(async () => {
    if (lines.length) {
      const sorted = [...lines].sort((a, b) => a.n - b.n)
      const width = Math.max(...sorted.map((l) => l.what.length))
      const size = (bytes?: number) => (bytes === undefined ? '' : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} kB`)
      const text = [
        `The server, on ${JSON.stringify(seed.sizes)}: median in ms (each run), the answer’s size`,
        ...sorted.map(
          (l) =>
            `${String(l.n).padStart(3)}  ${l.what.padEnd(width)}  ${l.ms.toFixed(l.ms < 10 ? 1 : 0).padStart(8)}  (${l.runs.map((r) => r.toFixed(0)).join(', ')})  ${size(l.bytes)}${l.note ? `  ${l.note}` : ''}`,
        ),
        ...notes.map((n) => `  not measured: ${n}`),
      ].join('\n')
      console.info(text)
      if (process.env.PERF_OUT)
        writeFileSync(
          process.env.PERF_OUT,
          JSON.stringify({ at: new Date().toISOString(), sizes: seed.sizes, seed: seed.took, lines: sorted, notes }, null, 2),
        )
    }
    await t?.close()
  })

  // ── How things are asked and timed ───────────────────────────────────────────

  type Who = Person | { token: string }
  /** One request, as that person (or with that API token): the answer as it comes, not read yet. */
  const send = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: object) =>
    t.app.inject({
      method,
      url,
      headers: 'token' in who ? { authorization: `Bearer ${who.token}`, accept: 'application/json, text/event-stream' } : { cookie: who.cookie },
      ...(body !== undefined && { payload: body }),
    })
  /** The answer, which has to be the one expected: a refusal timed by mistake would look quick. */
  const sure = (r: LightMyRequestResponse, status = 200) => {
    if (r.statusCode !== status) throw new Error(`Expected ${status}, got ${r.statusCode}: ${r.body.slice(0, 300)}`)
    return r
  }
  const middle = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

  /**
   * Times `run`, three times unless told otherwise, and keeps the middle time. `before` gets things ready and isn't
   * timed; `say` reads the last answer for something worth noting beside the number.
   */
  async function measure(
    n: number,
    what: string,
    run: (i: number) => Promise<LightMyRequestResponse>,
    opts: { runs?: number; before?: (i: number) => Promise<unknown>; say?: (r: LightMyRequestResponse) => string | undefined } = {},
  ) {
    const runs: number[] = []
    let last!: LightMyRequestResponse
    for (let i = 0; i < (opts.runs ?? 3); i++) {
      await opts.before?.(i)
      const started = performance.now()
      last = await run(i)
      runs.push(performance.now() - started)
    }
    const note = [opts.say?.(last), runs.length === 1 ? 'once: it can’t be done again' : undefined].filter(Boolean).join('; ')
    lines.push({ n, what, ms: middle(runs), runs, bytes: last.rawPayload.length, ...(note && { note }) })
    return last
  }

  const bump = (ids: string[]) =>
    t.db
      .update(boards)
      .set({ seq: sql`${boards.seq} + 1` })
      .where(inArray(boards.id, ids))
  const everyBoard = () => [seed.main.id, seed.companies.id, ...seed.linking, ...seed.small]
  /** How many times the main board was read from the database since `loaded.boards` was last emptied. */
  const mainLoads = () => loaded.boards.filter((id) => id === seed.main.id).length
  const mutate = (who: Person, boardId: string, command: object) =>
    send(who, 'POST', `/api/boards/${boardId}/mutations`, { mutationId: mid(), command })
  const field = (name: string) => seed.fieldIds[name]
  const fieldUrl = (name: string) => `/api/workspaces/${seed.ws}/fields/${field(name)}`

  // ── Reading (nothing here changes the workspace) ─────────────────────────────

  it('1, 13: opening the main board, and the boards page', async () => {
    const { ann, main } = seed
    const url = `/api/boards/${main.id}`
    const cold = await measure(1, 'open the main board: read from the database', () => send(ann, 'GET', url).then(sure), {
      before: async () => {
        await bump([main.id])
        loaded.boards = []
      },
      say: () => `${loaded.boards.length} board read`,
    })
    expect(mainLoads()).toBe(1)
    loaded.boards = []
    await measure(1, 'open the main board: from memory', () => send(ann, 'GET', url).then(sure))
    expect(loaded.boards).toEqual([])
    await measure(1, 'open the main board: it and every board its links lead to read from the database', () => send(ann, 'GET', url).then(sure), {
      before: async () => {
        await bump(everyBoard())
        loaded.boards = []
      },
      say: () => `${loaded.boards.length} boards read`,
    })
    // What came back is the board that was written, with the links it could say something about (2,000 at most).
    const body = cold.json()
    expect(Object.keys(body.data.tasks)).toHaveLength(seed.sizes.cards)
    expect(body.data.fields).toHaveLength(20)
    expect(main.big.linksElsewhere).toBeGreaterThan(Math.min(2000, seed.sizes.companies / 2))
    expect(Object.keys(body.linked).length).toBeLessThanOrEqual(2000)
    // (Read every board once more, so what follows starts with all of them in memory.)
    for (const id of everyBoard()) sure(await send(ann, 'GET', `/api/boards/${id}`))
    // The boards page: every search starts from this list too.
    await measure(13, 'list the boards (the boards page)', () => send(ann, 'GET', '/api/boards').then(sure), {
      say: (r) => `${r.json().boards.length} boards`,
    })
  })

  it('7: Search cards', async () => {
    const { ann, main } = seed
    const stage = main.big.pick.choice!
    const some = stage.options!.slice(0, 3).map((o) => o.id)
    const total = (r: LightMyRequestResponse) => `${r.json().total.toLocaleString('en-US')} cards found`
    for (const [what, query] of [
      ['every card, archived ones too', 'state=all'],
      ['one word', 'state=all&q=renewal'],
      ['a choice field is one of three options', `state=all&field=${stage.id}&fv=${some.join(',')}`],
      ['a number field is between 5,000 and 15,000', `state=all&field=${field('Amount')}&fv=5000..15000`],
    ] as const) {
      const first = await measure(7, `search cards: ${what}, first page`, () => send(ann, 'GET', `/api/cards?${query}`).then(sure), { say: total })
      expect(first.json().total).toBeGreaterThan(50)
      const second = await measure(7, `search cards: ${what}, second page`, () => send(ann, 'GET', `/api/cards?${query}&offset=50`).then(sure))
      expect(second.json().cards[0].id).not.toBe(first.json().cards[0].id)
    }
    const linked = `/api/cards?state=all&field=${field('Company')}&fv=any`
    await measure(7, 'search cards: a card link has a card, first page', () => send(ann, 'GET', linked).then(sure), { say: total })
  })

  it('8: an assistant looking for tasks', async () => {
    const { ann } = seed
    await setPlatformAdmin(t.db, ann.user.email, true)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    const token = (await ann.ok('POST', '/api/account/tokens', { name: 'perf', scope: 'read', expiresInDays: null })).token as string
    const find = (args: object) =>
      send({ token }, 'POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_tasks', arguments: args } })
    const found = (r: LightMyRequestResponse) => {
      const { result } = sure(r).json()
      if (result.isError) throw new Error(result.content[0].text)
      return JSON.parse(result.content[0].text) as { total: number; tasks: unknown[] }
    }
    const say = (r: LightMyRequestResponse) => `${found(r).total.toLocaleString('en-US')} tasks found`
    for (const [what, args] of [
      ['anything', {}],
      ['one word', { text: 'renewal' }],
      ['by a choice field', { fields: { Stage: 'Stage 7' } }],
      ['by a choice and a checkbox', { fields: { Stage: 'Stage 7', Signed: true } }],
    ] as const) {
      const r = await measure(8, `find_tasks: ${what}`, () => find(args).then(sure), { say })
      expect(found(r).tasks.length).toBeGreaterThan(0)
    }
  })

  it('9, 12: links: who links to a card, cards to pick, what links point at', async () => {
    const { ann, main, companies } = seed
    const busy = companies.cards[0]
    const from = await measure(9, 'linked from: a company many deals link to', () =>
      send(ann, 'GET', `/api/boards/${companies.id}/tasks/${busy}/linked-from`).then(sure),
    )
    const { groups } = from.json() as { groups: { count: number }[] }
    lines.at(-1)!.note = `${groups.reduce((sum, g) => sum + g.count, 0)} cards on ${groups.length} board-and-field pairs`
    expect(groups.length).toBeGreaterThan(1)
    for (const [name, scope] of [
      ['See also', 'any board of the workspace'],
      ['Company', 'one board'],
    ] as const) {
      const cards = `/api/boards/${main.id}/fields/${field(name)}/cards`
      const empty = await measure(9, `card picker, ${scope}: nothing typed`, () => send(ann, 'GET', `${cards}?q=`).then(sure))
      const typed = await measure(9, `card picker, ${scope}: three letters`, () => send(ann, 'GET', `${cards}?q=nor`).then(sure))
      expect(empty.json().cards).toHaveLength(30)
      expect(typed.json().cards.length).toBeGreaterThan(0)
    }
    // What the app asks as links come into view that the board didn't send with it: forty at a time.
    const held = new Set<string>()
    for (const c of Object.values(main.big.data.tasks)) for (const ref of linksOf(c.custom?.[field('Company')])) if (held.size < 40) held.add(ref)
    const linked = await measure(12, 'what 40 links point at (asked as they come into view)', () =>
      send(ann, 'GET', `/api/boards/${main.id}/linked?refs=${[...held].map(encodeURIComponent).join(',')}`).then(sure),
    )
    expect(Object.keys(linked.json().linked)).toHaveLength(held.size)
  })

  // ── Changing things (from here on the workspace isn't as it was made) ────────

  it('2: editing one card’s field', async () => {
    const { ann, main } = seed
    const ids = Object.keys(main.big.data.tasks)
    const r = await measure(2, 'edit one card’s text field', (i) =>
      mutate(ann, main.id, { type: 'task.update', id: ids[i], fields: { custom: { [field('Notes')]: `Edited ${i}` } } }).then(sure),
    )
    expect(r.json().changes).toHaveLength(1)
  })

  it('3, 11: changing a field of the library, and eight people opening the board right after', async () => {
    const { ann, main, others } = seed
    loaded.boards = []
    await measure(3, 'rename a field the main board shows', (i) => send(ann, 'PATCH', fieldUrl('Notes'), { name: `Notes ${i + 2}` }).then(sure))
    // (Nothing reads the boards because of a rename: they're read when someone next opens them.)
    expect(loaded.boards).toEqual([])
    // (Its options are sent whole, in order: the ones it has, as they are now, and one more.)
    let options: { id: string; name: string; color: string }[] = []
    await measure(
      3,
      'add an option to a choice',
      (i) => send(ann, 'PATCH', fieldUrl('Region'), { options: [...options, { name: `New ${i + 1}`, color: 'gray' }] }).then(sure),
      {
        before: async () => {
          const { fields } = await ann.ok('GET', `/api/workspaces/${seed.ws}/fields`)
          options = fields.find((f: { id: string }) => f.id === field('Region')).options
        },
      },
    )

    const viewers = others.slice(0, 8)
    let reads = 0
    await measure(
      11,
      `${viewers.length} people open the main board at once, right after a field was renamed`,
      async () => {
        const all = await Promise.all(viewers.map((p) => send(p, 'GET', `/api/boards/${main.id}`)))
        all.forEach((r) => sure(r))
        reads = mainLoads()
        return all[0]
      },
      {
        before: async (i) => {
          sure(await send(ann, 'PATCH', fieldUrl('Kickoff'), { name: `Kickoff ${i + 2}` }))
          loaded.boards = []
        },
        say: () => `the board was read from the database ${reads} times`,
      },
    )
  })

  it('4: merging two text fields that are on every board', async () => {
    const { ann } = seed
    const [from, into] = [field('Contact name'), field('Contact')]
    const base = `/api/workspaces/${seed.ws}/fields/${from}/merge`
    const preview = await measure(4, 'merge two fields: what it would do', () => send(ann, 'GET', `${base}?into=${into}`).then(sure))
    const { cards, boards: on } = preview.json() as { cards: number; boards: number }
    lines.at(-1)!.note = `${cards.toLocaleString('en-US')} cards on ${on} boards`
    expect(on).toBe(25)
    const done = await measure(4, 'merge two fields', () => send(ann, 'POST', base, { into }).then(sure), {
      runs: 1,
      say: (r) => `${r.json().cards.toLocaleString('en-US')} cards changed`,
    })
    expect(done.json().cards).toBe(cards)
  })

  it('5: moving a 500-card board to Personal and back', async () => {
    const { ann, ws, linking } = seed
    const move = (i: number, body: object) => send(ann, 'PUT', `/api/boards/${linking[i]}/workspace`, body)
    const asked = await measure(5, 'move a board to Personal: what it would change (refused until confirmed)', (i) =>
      move(i, { workspaceId: null }).then((r) => sure(r, 409)),
    )
    const { add, lose, links } = asked.json() as { add: string[]; lose: string[]; links: number }
    lines.at(-1)!.note = `the last of three: ${add.length} fields to add, ${lose.length} lost, ${links} links undone`
    await measure(5, 'move a board to Personal: confirmed', (i) => move(i, { workspaceId: null, confirm: true }).then(sure))
    // (Its fields are in the workspace already, and its links to other boards are gone: nothing to confirm.)
    await measure(5, 'move it back to the workspace', (i) => move(i, { workspaceId: ws }).then(sure))
  })

  it('10: moving a card to another board', async () => {
    const { ann, main, linking } = seed
    // Three cards other cards of the board link to: those links have to follow them.
    const pointedAt = new Map<string, number>()
    for (const c of Object.values(main.big.data.tasks))
      for (const name of ['Related', 'See also'])
        for (const ref of linksOf(c.custom?.[field(name)])) {
          const to = parseRef(ref)!
          if (to.boardId === main.id) pointedAt.set(to.taskId, (pointedAt.get(to.taskId) ?? 0) + 1)
        }
    const cards = [...pointedAt].sort((a, b) => b[1] - a[1]).slice(0, 3)
    expect(cards).toHaveLength(3)
    await measure(
      10,
      'move a card from the main board to another board (links to it follow)',
      (i) => send(ann, 'POST', `/api/boards/${main.id}/tasks/${cards[i][0]}/move`, { boardId: linking[3] }).then(sure),
      { say: (r) => `${cards[2][1]} cards linked to the last one; ${r.json().summary.linksRemoved} links removed` },
    )
  })

  it('6: clearing a field on every card of the main board', async () => {
    const { ann, main } = seed
    const clear = (name: string) => mutate(ann, main.id, { type: 'tasks.clearField', fieldId: field(name) })
    const runs: number[] = []
    let cleared!: LightMyRequestResponse
    const first = async (name: string) => {
      const started = performance.now()
      cleared = sure(await clear(name))
      runs.push(performance.now() - started)
      return cleared.json().changes as Change[]
    }
    // Its undo puts every card back as it was: the app sends them all, before and after.
    const changes = await first('Website')
    const inverse = changes.map((c) => ({
      entity: c.entity,
      id: c.id,
      before: c.after,
      after: { ...c.before!, version: c.after!.version + 1 },
    }))
    const undo = { mutationId: mid(), command: { type: 'records.restore', changes: inverse } }
    const mb = (JSON.stringify(undo).length / 1e6).toFixed(1)
    const started = performance.now()
    const undone = await send(ann, 'POST', `/api/boards/${main.id}/mutations`, undo)
    const took = performance.now() - started
    if (undone.statusCode === 200) {
      const undos = [took]
      // It fits: the same field can be cleared and put back again.
      for (let i = 0; i < 2; i++) {
        const again = await first('Website')
        const back = {
          mutationId: mid(),
          command: {
            type: 'records.restore',
            changes: again.map((c) => ({ ...c, before: c.after, after: { ...c.before!, version: c.after!.version + 1 } })),
          },
        }
        const at = performance.now()
        sure(await send(ann, 'POST', `/api/boards/${main.id}/mutations`, back))
        undos.push(performance.now() - at)
      }
      lines.push({ n: 6, what: 'undo it', ms: middle(undos), runs: undos, bytes: undone.rawPayload.length, note: `a request of ${mb} MB` })
    } else {
      notes.push(
        `6, undoing “clear a field on every card”: the request is ${mb} MB (${changes.length.toLocaleString('en-US')} cards, before and after) and was refused with ${undone.statusCode} after ${took.toFixed(0)} ms: ${undone.body.slice(0, 160)}`,
      )
      // It can't be put back, so the other two runs clear two other fields.
      await first('Renewal')
      await first('Paid')
    }
    lines.push({
      n: 6,
      what: 'clear a field on every card of the main board',
      ms: middle(runs),
      runs,
      bytes: cleared.rawPayload.length,
      note: `${changes.length.toLocaleString('en-US')} cards changed`,
    })
    expect(changes.length).toBeGreaterThan(seed.sizes.cards / 2)
  })
})
