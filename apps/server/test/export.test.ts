import type { CommentView, TimeEntryView } from '@kanbanto/model/api'
import { exportFile, type BoardExtras } from '@kanbanto/model/transfer'
import type { BoardData } from '@kanbanto/model/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

type Snapshot = { data: BoardData; counts: { comments: Record<string, number>; time: Record<string, number> } }
const load = (p: Person, id: string) => p.ok<Snapshot>('GET', `/api/boards/${id}?archived=all`)
const extrasOf = (p: Person, id: string) => p.request<BoardExtras & { error?: string }>('GET', `/api/boards/${id}/extras`)
const commentsOf = async (p: Person, board: string, task: string) =>
  (await p.ok<{ comments: CommentView[] }>('GET', `/api/boards/${board}/tasks/${task}/comments`)).comments
const timeOf = async (p: Person, board: string, task: string) =>
  (await p.ok<{ entries: TimeEntryView[] }>('GET', `/api/boards/${board}/tasks/${task}/time`)).entries

/** Ann owns the example board; Bob can edit it. Both commented on Deploy (A3) and logged time; Buy domain (A1) is archived with a comment. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'Deployed to staging.' })
  await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'Looks good, *ship it*.' })
  await ann.ok('POST', `/api/boards/${id}/tasks/A1/comments`, { body: 'Bought for two years.' })
  await ann.ok('POST', `/api/boards/${id}/tasks/A3/time`, { minutes: 90, day: '2026-10-06', note: 'Pipeline' })
  await bob.ok('POST', `/api/boards/${id}/tasks/A3/time`, { minutes: 45, day: '2026-10-07', note: '' })
  await bob.ok('POST', `/api/boards/${id}/tasks/A2a/time`, { minutes: 30, day: '2026-10-07', note: 'Review' })
  await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.archive', id: 'A1' } })
  return { ann, bob, id }
}

describe('a board’s comments and logged time, for its file', () => {
  it('are given to the board’s people, each naming who it was by, archived cards’ too', async () => {
    const { ann, bob, id } = await team()
    const { status, body } = await extrasOf(bob, id)
    expect(status).toBe(200)
    expect(body.comments.map((c) => [c.taskId, c.by?.name, c.body])).toEqual([
      ['A3', 'Ann', 'Deployed to staging.'],
      ['A3', 'Bob', 'Looks good, *ship it*.'],
      ['A1', 'Ann', 'Bought for two years.'],
    ])
    expect(body.comments[0].by).toEqual({ id: ann.user.id, name: 'Ann' })
    expect(body.time.map((e) => [e.taskId, e.by?.name, e.day, e.minutes, e.note])).toEqual([
      ['A3', 'Ann', '2026-10-06', 90, 'Pipeline'],
      ['A3', 'Bob', '2026-10-07', 45, ''],
      ['A2a', 'Bob', '2026-10-07', 30, 'Review'],
    ])
    // Not for a stranger, nor for a visitor with the public link (who doesn't see logged time).
    const sam = await Person.signUp(t.app, 'Sam')
    expect((await extrasOf(sam, id)).status).toBe(404)
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    expect((await extrasOf(sam, id)).status).toBe(403)
    expect((await extrasOf(new Person(t.app), id)).status).toBe(401)
  })

  it('come back with the board: comments in the importer’s name saying who wrote them, time theirs or nobody’s', async () => {
    const { ann, bob, id } = await team()
    const whole = (await load(ann, id)).data
    const extras = (await extrasOf(ann, id)).body
    const file = JSON.parse(JSON.stringify(exportFile(whole, extras)))
    expect(Object.keys(file)).toEqual(['app', 'format', 'exportedAt', 'data', 'comments', 'time'])

    // Ann brings it back on the same site: what was hers is hers again; Bob's says so.
    const made = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file })
    const said = await commentsOf(ann, made.id, 'A3')
    expect(said.map((c) => [c.author?.name, c.body])).toEqual([
      ['Ann', 'Deployed to staging.'],
      ['Ann', '**Bob** wrote:\n\nLooks good, *ship it*.'],
    ])
    // (With the dates they were written, in order.)
    expect(said[0].createdAt).toBe(extras.comments[0].at)
    expect((await commentsOf(ann, made.id, 'A1')).map((c) => c.body)).toEqual(['Bought for two years.'])
    const logged = await timeOf(ann, made.id, 'A3')
    expect(logged.map((e) => [e.user?.name ?? null, e.day, e.minutes, e.note]).sort()).toEqual(
      [
        ['Ann', '2026-10-06', 90, 'Pipeline'],
        [null, '2026-10-07', 45, 'Bob'],
      ].sort(),
    )
    expect((await timeOf(ann, made.id, 'A2a')).map((e) => [e.user, e.note])).toEqual([[null, 'Bob: Review']])
    const counts = (await load(ann, made.id)).counts
    expect([counts.comments.A3, counts.time.A3, counts.time.A2a]).toEqual([2, 135, 30])

    // Bob brings the same file in: now his own are his, and Ann's say who wrote them.
    const bobs = await bob.ok<{ id: string }>('POST', '/api/boards/import', { file })
    expect((await commentsOf(bob, bobs.id, 'A3')).map((c) => [c.author?.name, c.body])).toEqual([
      ['Bob', '**Ann** wrote:\n\nDeployed to staging.'],
      ['Bob', 'Looks good, *ship it*.'],
    ])
    expect((await timeOf(bob, bobs.id, 'A3')).map((e) => [e.user?.name ?? null, e.note]).sort()).toEqual(
      [
        [null, 'Ann: Pipeline'],
        ['Bob', ''],
      ].sort(),
    )
  })

  it('a file without them, or with some out of shape, still makes its board', async () => {
    const { ann, id } = await team()
    const whole = (await load(ann, id)).data
    const plain = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file: JSON.parse(JSON.stringify(exportFile(whole))) })
    expect(await commentsOf(ann, plain.id, 'A3')).toEqual([])
    const file = {
      ...JSON.parse(JSON.stringify(exportFile(whole))),
      comments: [
        { taskId: 'A3', by: { id: 'x', name: 'Mai *the* boss' }, body: 'Kept', at: '2026-10-01T03:00:00.000Z' },
        { taskId: 'A3', by: null, body: 'From nobody', at: '2026-10-02T03:00:00.000Z' },
        { taskId: 'nope', by: null, body: 'For a card the board doesn’t have', at: '2026-10-02T03:00:00.000Z' },
        { taskId: 'A3', body: '', at: '2026-10-02T03:00:00.000Z' },
        { taskId: 'A3', by: null, body: 'No date' },
        'nonsense',
      ],
      time: [
        { taskId: 'A3', by: { id: 'x', name: 'Mai' }, day: '2026-10-01', minutes: 60, note: 'Kept', at: '2026-10-01T03:00:00.000Z' },
        { taskId: 'A3', by: null, day: '2026-10-01', minutes: 0, note: '', at: '2026-10-01T03:00:00.000Z' },
        { taskId: 'A3', by: null, day: 'yesterday', minutes: 30, note: '', at: '2026-10-01T03:00:00.000Z' },
        { taskId: 'A3', by: null, day: '2026-10-01', minutes: 99999, note: '', at: '2026-10-01T03:00:00.000Z' },
      ],
    }
    const made = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file })
    expect((await commentsOf(ann, made.id, 'A3')).map((c) => c.body)).toEqual([
      '**Mai \\*the\\* boss** wrote:\n\nKept',
      'Someone wrote:\n\nFrom nobody',
    ])
    expect((await timeOf(ann, made.id, 'A3')).map((e) => [e.minutes, e.note])).toEqual([[60, 'Mai: Kept']])
  })
})
