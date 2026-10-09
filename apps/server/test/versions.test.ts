import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { descriptionsChanged, keepVersions, SITTING_MS, VERSIONS_KEPT } from '../src/boards/versions'
import { descriptionVersions } from '../src/db/schema'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** Ann owns a board; Bob (editor) and Vic (viewer) are on it. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  const run = (p: Person, command: object) => p.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
  const write = (p: Person, text: string, card = 'A3') => run(p, { type: 'task.update', id: card, fields: { description: text } })
  const list = async (p: Person, card = 'A3') => (await p.ok('GET', `/api/boards/${id}/tasks/${card}/versions`)).versions as Version[]
  const read = async (p: Person, v: Version, card = 'A3') =>
    (await p.ok('GET', `/api/boards/${id}/tasks/${card}/versions/${v.id}`)).version.text as string
  return { ann, bob, vic, id, run, write, list, read }
}
type Version = { id: string; at: string; by: { id: string; name: string } | null; via: string | null; length: number }

describe('earlier versions of a description', () => {
  it('keeps what a text read like before: the first change keeps the text there was, and each person’s sitting is one version', async () => {
    const { ann, bob, write, list, read } = await team()
    expect(await list(ann)).toEqual([])
    await write(ann, 'First text')
    // (The card had no description: there is nothing from before to keep.)
    expect((await list(ann)).map((v) => v.by?.name)).toEqual(['Ann'])
    // Ann goes on within the same few minutes: still one version, the last she saved.
    await write(ann, 'First text, improved')
    let versions = await list(ann)
    expect(versions).toHaveLength(1)
    expect(await read(ann, versions[0])).toBe('First text, improved')
    // Bob's change is a version of its own; Ann saving again goes on with hers, which is then the newest.
    await write(bob, 'First text, improved. Bob was here.')
    await write(ann, 'First text, improved. Bob was here. Ann again.')
    versions = await list(ann)
    expect(versions.map((v) => v.by?.name)).toEqual(['Ann', 'Bob'])
    expect(await read(bob, versions[0])).toBe('First text, improved. Bob was here. Ann again.')
    expect(await read(bob, versions[1])).toBe('First text, improved. Bob was here.')
    expect(versions[0].length).toBe('First text, improved. Bob was here. Ann again.'.length)
    // A change to anything else about the card keeps nothing.
    await write(ann, 'First text, improved. Bob was here. Ann again.')
    expect(await list(ann)).toHaveLength(2)
  })

  it('a text written before versions were kept is the version before all of them, and nobody’s', async () => {
    const { ann, bob, id, run, list, read } = await team()
    await run(ann, { type: 'task.create', id: 'N1', parentId: null, fields: { title: 'An article', description: 'As it was first written' } })
    // (Made with its text: nothing kept yet. Versions begin when a text changes.)
    expect(await list(ann, 'N1')).toEqual([])
    await t.db.delete(descriptionVersions).where(eq(descriptionVersions.boardId, id))
    await run(bob, { type: 'task.update', id: 'N1', fields: { description: 'Rewritten by Bob' } })
    const versions = await list(ann, 'N1')
    expect(versions.map((v) => v.by?.name ?? null)).toEqual(['Bob', null])
    expect(await read(ann, versions[1], 'N1')).toBe('As it was first written')
    expect(Date.parse(versions[1].at)).toBeLessThan(Date.parse(versions[0].at))
    // Undo is a change like any other: the text it puts back is the newest version, by whoever undid.
    const before = (await ann.ok('GET', `/api/boards/${id}`)).data.tasks.N1
    await run(ann, { type: 'task.update', id: 'N1', fields: { description: 'As it was first written' } })
    expect((await list(ann, 'N1')).map((v) => v.by?.name ?? null)).toEqual(['Ann', 'Bob', null])
    expect(before.description).toBe('Rewritten by Bob')
  })

  it('a sitting ends after a few minutes, and a card keeps its newest versions only', async () => {
    const { ann, id, list, read } = await team()
    const data = (await ann.ok('GET', `/api/boards/${id}`)).data
    const card = data.tasks.A3
    const save = (text: string, was: string, at: Date) =>
      keepVersions(
        t.db,
        id,
        {
          userId: ann.user.id,
          changes: [{ entity: 'task', id: 'A3', before: { ...card, description: was }, after: { ...card, description: text } }],
        },
        at,
      )
    const start = Date.now() - 200 * SITTING_MS
    await save('one', '', new Date(start))
    await save('two', 'one', new Date(start + SITTING_MS - 1000))
    expect(await list(ann)).toHaveLength(1)
    await save('three', 'two', new Date(start + 2 * SITTING_MS))
    expect(await list(ann)).toHaveLength(2)
    for (let i = 0; i < VERSIONS_KEPT + 5; i++) await save(`text ${i}`, 'x', new Date(start + (3 + i) * (SITTING_MS + 1000)))
    const versions = await list(ann)
    expect(versions).toHaveLength(VERSIONS_KEPT)
    expect(await read(ann, versions[0])).toBe(`text ${VERSIONS_KEPT + 4}`)
    expect(await read(ann, versions.at(-1)!)).toBe('text 5')
    // (What changed, and what didn't.)
    expect(descriptionsChanged([{ entity: 'task', id: 'A3', before: card, after: { ...card, title: 'Renamed' } }])).toEqual([])
    expect(descriptionsChanged([{ entity: 'task', id: 'A3', before: null, after: { ...card, description: 'new card' } }])).toEqual([])
  })

  it('is for the board’s people, viewers too, and not for a visitor with the public link; a version of another card isn’t read through this one', async () => {
    const { ann, vic, id, write, list, read } = await team()
    await write(ann, 'Kept')
    await write(ann, 'Other card', 'A1')
    const [v] = await list(vic)
    expect(await read(vic, v)).toBe('Kept')
    expect((await vic.request('GET', `/api/boards/${id}/tasks/A1/versions/${v.id}`)).status).toBe(404)
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const visitor = new Person(t.app)
    expect((await visitor.request('GET', `/api/boards/${id}/tasks/A3/versions`)).status).toBe(401)
    const stranger = await Person.signUp(t.app, 'Sam')
    expect((await stranger.request('GET', `/api/boards/${id}/tasks/A3/versions`)).status).toBe(403)
  })

  it('follows a card that moves to another board', async () => {
    const { ann, id, write, list } = await team()
    await write(ann, 'Before the move')
    await write(ann, 'Still before the move')
    const other = (await ann.ok('POST', '/api/boards', { name: 'Other', template: 'empty' })).id
    const moved = await ann.ok('POST', `/api/boards/${id}/tasks/A3/move`, { boardId: other })
    expect(await list(ann)).toEqual([])
    const there = Object.keys((await ann.ok('GET', `/api/boards/${other}`)).data.tasks)[0]
    expect(moved).toBeTruthy()
    const versions = (await ann.ok('GET', `/api/boards/${other}/tasks/${there}/versions`)).versions as Version[]
    expect(versions).toHaveLength(1)
    expect((await ann.ok('GET', `/api/boards/${other}/tasks/${there}/versions/${versions[0].id}`)).version.text).toBe('Still before the move')
  })
})
