import { limitOn, MAX_RULES, type BoardRule, type LimitRule } from '@kanbanto/model/rules'
import { exportFile } from '@kanbanto/model/transfer'
import type { BoardData } from '@kanbanto/model/types'
import { eq } from 'drizzle-orm'
import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boardActivity, boardRules } from '../src/db/schema'
import type { LiveMessage } from '../src/live'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

type Snapshot = { data: BoardData; seq: number }
const load = (p: Person, id: string) => p.ok<Snapshot>('GET', `/api/boards/${id}`)
const rulesOf = async (p: Person, id: string) => (await load(p, id)).data.rules
const mutate = (p: Person, id: string, command: object) => p.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
/** A limit as the app sends it: without an id (the server gives one). */
const limit = (list = 'doing', max = 3, over: Partial<LimitRule> = {}) => {
  const { id: _id, ...rule } = { ...limitOn('', list, 'derived', max), ...over }
  return rule
}
const make = (p: Person, board: string, rule: object) =>
  p.request<{ rule: BoardRule; error?: string }>('POST', `/api/boards/${board}/rules`, { rule })
const change = (p: Person, board: string, id: string, rule: object) =>
  p.request<{ rule: BoardRule; error?: string }>('PATCH', `/api/boards/${board}/rules/${id}`, { rule })
const remove = (p: Person, board: string, id: string) => p.request('DELETE', `/api/boards/${board}/rules/${id}`)

/** Ann owns the example board; Bob can edit it and Vic can only look. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  return { ann, bob, vic, id }
}

async function listen(p: Person, boardId: string) {
  const messages: LiveMessage[] = []
  const ws: WebSocket = await t.app.injectWS(`/api/boards/${boardId}/live`, { headers: p.cookie ? { cookie: p.cookie } : {} })
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20))
    return test()
  }
  return { ws, messages, until }
}

describe('a board’s rules', () => {
  it('are its owners’ to make, change and remove, and come with the board for everyone who can open it', async () => {
    const { ann, bob, vic, id } = await team()
    expect('rules' in (await load(ann, id)).data).toBe(false)
    const before = (await load(ann, id)).seq
    const live = await listen(bob, id)
    const made = await make(ann, id, limit('doing', 3))
    expect(made.status).toBe(200)
    expect(made.body.rule).toMatchObject({
      kind: 'limit',
      cards: { statuses: ['doing'] },
      counts: 'leaves',
      measure: { by: 'cards' },
      max: 3,
      then: [{ do: 'show' }],
    })
    // Everyone's open copy is told to read the board again, and gets the rule with it: editors, viewers, visitors.
    expect(await live.until(() => live.messages.some((m) => m.type === 'reload'))).toBe(true)
    live.ws.close()
    expect((await load(ann, id)).seq).toBeGreaterThan(before)
    for (const p of [ann, bob, vic]) expect(await rulesOf(p, id)).toEqual([made.body.rule])
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    expect(await rulesOf(new Person(t.app), id)).toEqual([made.body.rule])
    // A change to the board doesn't lose them (in the server's memory, where a board is rebuilt part by part).
    await mutate(bob, id, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    expect(await rulesOf(vic, id)).toEqual([made.body.rule])
    t.app.engine.forget(id)
    expect(await rulesOf(vic, id)).toEqual([made.body.rule])
    // Changed: the same rule, another number, for each person.
    const next = await change(ann, id, made.body.rule.id, limit('doing', 2, { per: 'person' }))
    expect(next.body.rule).toMatchObject({ id: made.body.rule.id, max: 2, per: 'person' })
    expect(await rulesOf(bob, id)).toEqual([next.body.rule])
    // A rule can have a name of its own.
    const named = await change(ann, id, made.body.rule.id, limit('doing', 2, { per: 'person', name: 'Two at a time' }))
    expect(named.body.rule.name).toBe('Two at a time')
    expect((await change(ann, id, made.body.rule.id, limit('doing', 2, { per: 'person' }))).body.rule).toEqual(next.body.rule)
    // Only owners. A stranger isn't told the board exists; someone signed out is asked to sign in.
    for (const p of [bob, vic]) {
      expect((await make(p, id, limit())).status).toBe(403)
      expect((await change(p, id, made.body.rule.id, limit('doing', 9))).status).toBe(403)
      expect((await remove(p, id, made.body.rule.id)).status).toBe(403)
    }
    // (With the public link on, a stranger is a visitor: told it isn't theirs to change, not that there's no board.)
    expect((await make(await Person.signUp(t.app, 'Carl'), id, limit())).status).toBe(403)
    expect((await make(new Person(t.app), id, limit())).status).toBe(401)
    expect(await rulesOf(ann, id)).toEqual([next.body.rule])
    // Removed.
    expect((await remove(ann, id, made.body.rule.id)).status).toBe(200)
    expect('rules' in (await load(bob, id)).data).toBe(false)
    expect((await remove(ann, id, made.body.rule.id)).status).toBe(404)
    // The board's log says what was done, in the rule's own words.
    const said = (await t.db.select().from(boardActivity).where(eq(boardActivity.boardId, id)))
      .filter((r) => r.command === 'board.rules')
      .map((r) => (r.items as { text: string }[])[0].text)
    expect(said).toEqual([
      'added a limit: At most 3 cards in Doing',
      'changed a limit: At most 2 cards for each person in Doing',
      'changed a limit: At most 2 cards for each person in Doing',
      'changed a limit: At most 2 cards for each person in Doing',
      'removed a limit: At most 2 cards for each person in Doing',
    ])
  })

  it('have to be whole, and about what the board has: the rest is refused with the reason', async () => {
    const { ann, id } = await team()
    const refused = async (rule: object) => {
      const r = await make(ann, id, rule)
      return [r.status, r.body.error]
    }
    expect(await refused(limit('nowhere'))).toEqual([422, 'That rule can’t be kept. Its list is gone.'])
    expect(await refused(limit('doing', 3, { cards: { statuses: ['doing'], labels: ['nothing'] } }))).toEqual([
      422,
      'That rule can’t be kept. A label it names is gone.',
    ])
    expect(await refused(limit('doing', 3, { cards: { assignees: ['me'] } }))).toEqual([422, 'That rule can’t be kept. A rule can’t be about “me”.'])
    expect(await refused(limit('doing', 3, { cards: { assignees: ['00000000-0000-4000-8000-000000000000'] } }))).toEqual([
      422,
      'That rule can’t be kept. Someone it names is no longer on the board.',
    ])
    expect(await refused(limit('doing', 3, { measure: { by: 'field', field: 'f-none' } }))).toEqual([
      422,
      'That rule can’t be kept. The field it adds up is no longer on the board.',
    ])
    // Not a rule at all: a date or a day count among its conditions, no number, a kind there isn't, something extra.
    for (const bad of [
      limit('doing', 3, { cards: { statuses: ['doing'], due: 'week' } as never }),
      limit('doing', 3, { cards: { statuses: ['doing'], idle: 7 } as never }),
      { ...limit(), max: undefined },
      { ...limit(), max: -1 },
      { ...limit(), kind: 'when' },
      { ...limit(), then: [{ do: 'refuse' }] },
      { ...limit(), counts: 'some' },
      { ...limit(), owner: 'me' },
    ])
      expect([JSON.stringify(bad).slice(0, 60), (await make(ann, id, bad)).status]).toEqual([JSON.stringify(bad).slice(0, 60), 400])
    expect((await ann.request('POST', `/api/boards/${id}/rules`, { rule: 'three' })).status).toBe(400)
    expect(await rulesOf(ann, id)).toBeUndefined()
    // A rule of another board can't be changed or removed through this one.
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Ops', template: 'example' })
    const theirs = (await make(ann, other, limit())).body.rule
    expect((await change(ann, id, theirs.id, limit('doing', 9))).status).toBe(404)
    expect((await remove(ann, id, theirs.id)).status).toBe(404)
    expect(await rulesOf(ann, other)).toEqual([theirs])
    // Twenty to a board.
    for (let i = 0; i < MAX_RULES; i++) expect((await make(ann, id, limit('doing', i + 1))).status).toBe(200)
    expect(await refused(limit('doing', 99))).toEqual([422, `A board can have up to ${MAX_RULES} rules. Remove one first.`])
    expect((await rulesOf(ann, id))!.map((r) => (r as LimitRule).max)).toEqual(Array.from({ length: MAX_RULES }, (_, i) => i + 1))
  })

  it('follow their fields when two are merged, and when the board moves to another workspace', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const add = async (body: object) => (await ann.ok('POST', '/api/fields', body)).id as string
    const hours = await add({ name: 'Hours', type: 'number', unit: 'h', decimals: 0, sum: true })
    const effort = await add({ name: 'Effort', type: 'number', unit: 'h', decimals: 0, sum: true })
    const stage = await add({
      name: 'Stage',
      type: 'choice',
      options: [
        { name: 'Lead', color: 'gray' },
        { name: 'Won', color: 'green' },
      ],
    })
    const [lead, won] = (await ann.ok('GET', '/api/fields')).fields
      .find((f: { id: string }) => f.id === stage)
      .options.map((o: { id: string }) => o.id)
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: hours }, { id: effort }, { id: stage }] })
    const sum = (await make(ann, id, limit('doing', 40, { measure: { by: 'field', field: effort } }))).body.rule
    const picky = (await make(ann, id, limit('doing', 2, { cards: { statuses: ['doing'], fields: { [stage]: { in: [won] } } } }))).body.rule
    const plain = (await make(ann, id, limit('todo', 5))).body.rule
    // Effort is merged into Hours: the limit on Effort is a limit on Hours.
    const merged = await ann.request('POST', `/api/fields/${effort}/merge`, { into: hours })
    expect(merged.status).toBe(200)
    expect(await rulesOf(ann, id)).toEqual([{ ...sum, measure: { by: 'field', field: hours } }, picky, plain])
    // To a workspace that has a Stage with only "Lead": Hours and "Won" are made there, and the rules name them.
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/fields`, { name: 'Stage', type: 'choice', options: [{ name: 'Lead', color: 'gray' }] })
    await ann.ok('PUT', `/api/boards/${id}/workspace`, { workspaceId: ws, confirm: true })
    const library = (await ann.ok('GET', `/api/workspaces/${ws}/fields`)).fields as {
      id: string
      name: string
      options?: { id: string; name: string }[]
    }[]
    const wsHours = library.find((f) => f.name === 'Hours')!.id
    const wsStage = library.find((f) => f.name === 'Stage')!
    const wsWon = wsStage.options!.find((o) => o.name === 'Won')!.id
    expect([hours, stage, won, lead]).not.toContain(wsHours)
    expect(await rulesOf(ann, id)).toEqual([
      { ...sum, measure: { by: 'field', field: wsHours } },
      { ...picky, cards: { statuses: ['doing'], fields: { [wsStage.id]: { in: [wsWon] } } } },
      plain,
    ])
  })

  it('come with a board read from a file, under new ids, without the ones that name people', async () => {
    const { ann, bob, id } = await team()
    const kept = (await make(ann, id, limit('doing', 3))).body.rule
    await make(ann, id, limit('doing', 2, { cards: { statuses: ['doing'], assignees: [bob.user.id] } }))
    const perPerson = (await make(ann, id, limit('todo', 2, { per: 'person' }))).body.rule
    const whole = (await ann.ok<Snapshot>('GET', `/api/boards/${id}?archived=all`)).data
    const file = exportFile(whole)
    expect(file.data.rules).toHaveLength(3)
    const made = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file })
    const again = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file })
    const [first, second] = [await rulesOf(ann, made.id), await rulesOf(ann, again.id)]
    const bare = (rules?: BoardRule[]) => rules?.map(({ id: _id, ...r }) => r)
    expect(bare(first)).toEqual(bare([kept, perPerson]))
    expect(bare(second)).toEqual(bare(first))
    // (The same file twice: no two rules share an id, with each other or with the board they came from.)
    const ids = [kept.id, perPerson.id, ...first!.map((r) => r.id), ...second!.map((r) => r.id)]
    expect(new Set(ids).size).toBe(ids.length)
    // A board that's deleted takes its rules with it.
    await ann.ok('DELETE', `/api/boards/${again.id}`)
    expect(await t.db.select().from(boardRules).where(eq(boardRules.boardId, again.id))).toEqual([])
  })
})
