import { EDITOR_VERSION, type DocMessage, type DocRequest } from '@kanbanto/model/api'
import { invertChanges } from '@kanbanto/model/changes'
import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { HeldSaves, type Changed } from '../src/boards/heldSaves'
import type { LiveMessage } from '../src/live'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** Ann owns a board; Bob (editor) and Vic (viewer) are on it. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  const run = (p: Person, command: object) => p.request('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
  const text = async () => (await ann.ok('GET', `/api/boards/${id}`)).data.tasks.A.description ?? ''
  return { ann, bob, vic, id, run, text }
}

/**
 * Someone's browser with card A's description open for writing, over the board's live connection: it joins, takes in
 * what the others write, and sends what is typed in it. (The text is a Y.Text here; the editor's document is richer,
 * and the same to the server.)
 */
class Writing {
  got: LiveMessage[] = []
  doc = new Y.Doc()
  session = ''
  seed = false
  refused: string | null = null
  ended = false
  resets = 0
  private ws!: WebSocket
  static async open(p: Person, boardId: string) {
    const w = new Writing()
    w.ws = await t.app.injectWS(`/api/boards/${boardId}/live`, { headers: { cookie: p.cookie } })
    w.ws.on('message', (raw) => w.take(JSON.parse(String(raw))))
    await w.until(() => w.got.some((m) => m.type === 'hello'))
    return w
  }
  private listen() {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'theirs' && this.session) this.say({ type: 'doc', op: 'update', taskId: 'A', session: this.session, data: b64(update) })
    })
  }
  private take(m: LiveMessage) {
    this.got.push(m)
    if (m.type !== 'doc') return
    const d = m as DocMessage
    if (d.op === 'joined') {
      if (!d.same) {
        this.doc = new Y.Doc()
        this.listen()
      }
      this.session = d.session
      this.seed = d.seed
      Y.applyUpdate(this.doc, bytesOf(d.state), 'theirs')
    } else if (d.op === 'update') Y.applyUpdate(this.doc, bytesOf(d.data), 'theirs')
    else if (d.op === 'refused') this.refused = d.error
    else if (d.op === 'ended') this.ended = true
    else if (d.op === 'reset') this.resets++
  }
  say(m: DocRequest) {
    this.ws.send(JSON.stringify(m))
  }
  async until(test: () => boolean) {
    for (let i = 0; i < 150 && !test(); i++) await wait()
    return test()
  }
  /** Asks to join, and waits for the answer (joined, refused, or the card being gone). */
  async join() {
    const before = this.got.length
    this.say({
      type: 'doc',
      op: 'join',
      taskId: 'A',
      ...(this.session && { session: this.session }),
      client: this.doc.clientID,
      editor: EDITOR_VERSION,
    })
    await this.until(() => this.got.slice(before).some((m) => m.type === 'doc' && ['joined', 'refused', 'ended'].includes(m.op)))
    return this
  }
  /** Loads the saved text, as the editor of whoever is asked to does. */
  load(saved: string) {
    this.doc.transact(() => {
      this.doc.getText('t').insert(0, saved)
      this.doc.getMap('meta').set('seeded', true)
      this.doc.getMap('meta').set('by', this.doc.clientID)
    })
  }
  type(more: string) {
    this.doc.getText('t').insert(this.text.length, more)
  }
  get text() {
    return this.doc.getText('t').toString()
  }
  writers() {
    const last = this.got.filter((m) => m.type === 'writing').at(-1) as Extract<LiveMessage, { type: 'writing' }> | undefined
    return last?.people.map((p) => p.name) ?? null
  }
  close() {
    this.ws.terminate()
  }
}

describe('a description written by several people at once', () => {
  it('is joined over the board’s live connection, by the people who can edit', async () => {
    const { ann, bob, vic, id, run } = await team()
    await run(ann, { type: 'task.update', id: 'A', fields: { description: 'Saved text.' } })
    const a = await (await Writing.open(ann, id)).join()
    expect([a.seed, a.text]).toEqual([true, ''])
    a.load('Saved text.')
    const b = await (await Writing.open(bob, id)).join()
    expect([b.seed, b.text, b.session]).toEqual([false, 'Saved text.', a.session])
    // What each writes reaches the other.
    b.type(' Bob.')
    a.type(' Ann.')
    expect(await a.until(() => a.text === b.text && a.text.includes('Bob.') && a.text.includes('Ann.'))).toBe(true)
    // Everyone with the board open is told who is writing; someone opening it later is told at once.
    expect(await a.until(() => a.writers()?.length === 2)).toBe(true)
    expect(a.writers()).toEqual(['Ann', 'Bob'])
    const v = await Writing.open(vic, id)
    expect(await v.until(() => v.writers() !== null)).toBe(true)
    expect(v.writers()).toEqual(['Ann', 'Bob'])
    // A viewer can't join, and neither can anyone for a card that isn't there.
    await v.join()
    expect(v.refused).toMatch(/can’t change it/)
    b.say({ type: 'doc', op: 'join', taskId: 'no-such-card', editor: EDITOR_VERSION })
    expect(await b.until(() => b.got.some((m) => m.type === 'doc' && m.op === 'ended' && m.taskId === 'no-such-card'))).toBe(true)
    // Leaving, and a connection that goes, both take a writer out.
    b.say({ type: 'doc', op: 'leave', taskId: 'A' })
    expect(await a.until(() => a.writers()?.length === 1)).toBe(true)
    a.close()
    expect(await v.until(() => v.writers()?.length === 0)).toBe(true)
    b.close()
    v.close()
  })

  it('isn’t changed from anywhere else while they write, and is theirs to save', async () => {
    const { ann, bob, id, run, text } = await team()
    await run(ann, { type: 'task.update', id: 'A', fields: { description: 'Saved text.', priority: 'high' } })
    const a = await (await Writing.open(ann, id)).join()
    a.load('Saved text.')
    a.type(' More.')
    await wait(60)
    // From outside the session it waits, with who is writing said: another window, an assistant, an undo.
    const refused = await run(bob, { type: 'task.update', id: 'A', fields: { description: 'Bob’s own version.' } })
    expect(refused.status).toBe(422)
    expect(refused.body).toMatchObject({ code: 'being-written' })
    expect(refused.body.error).toMatch(/^Ann is writing the description of “.+” right now/)
    expect((await run(ann, { type: 'task.update', id: 'A', fields: { description: 'Ann’s other window.' } })).status).toBe(422)
    expect((await run(bob, { type: 'tasks.update', cards: [{ id: 'A', fields: { description: 'In bulk.' } }] })).status).toBe(422)
    const was = (await ann.ok('GET', `/api/boards/${id}`)).data
    const undo = invertChanges(
      was,
      [{ entity: 'task', id: 'A', before: { ...was.tasks.A, description: 'Old.' }, after: was.tasks.A }],
      new Date().toISOString(),
    )
    expect((await run(ann, { type: 'records.restore', changes: undo })).status).toBe(422)
    expect(await text()).toBe('Saved text.')
    // Anything else about the card is changed as ever.
    expect((await run(bob, { type: 'task.update', id: 'A', fields: { priority: 'low' } })).status).toBe(200)
    // The writing itself, saved with the session it is written in.
    expect((await run(ann, { type: 'task.update', id: 'A', fields: { description: 'Saved text. More.' }, session: a.session })).status).toBe(200)
    expect(await text()).toBe('Saved text. More.')
    expect((await run(bob, { type: 'task.update', id: 'A', fields: { description: 'x' }, session: 'not-this-one' })).status).toBe(422)
    // Once they have stopped for a while it may be changed, and they start again from the new text.
    ;(t.app.docs as unknown as { quiet: number }).quiet = 0
    expect((await run(bob, { type: 'task.update', id: 'A', fields: { description: 'Bob’s own version.' } })).status).toBe(200)
    expect(await a.until(() => a.resets === 1)).toBe(true)
    // (A save still on its way from the session that was, isn't put over the new text.)
    const late = await run(ann, { type: 'task.update', id: 'A', fields: { description: 'Saved text. More. And more.' }, session: a.session })
    expect([late.status, late.body.code]).toEqual([422, 'being-written'])
    await a.join()
    expect([a.seed, a.text, await text()]).toEqual([true, '', 'Bob’s own version.'])
    ;(t.app.docs as unknown as { quiet: number }).quiet = 120_000
    a.close()
  })

  it('is one line in the history for each writer’s sitting, one version, and one thing told to followers', async () => {
    const { ann, bob, vic, id, run } = await team()
    await run(ann, { type: 'task.update', id: 'A', fields: { description: 'Start.' } })
    // (Vic follows the card: he hears of changes to its description.)
    await vic.ok('PUT', `/api/boards/${id}/tasks/A/follow`, { following: true })
    const told = async () =>
      (await vic.ok('GET', '/api/notifications')).notifications
        .flatMap((n: { kind: string; changes?: string[] }) => (n.kind === 'change' ? (n.changes ?? []) : []))
        .filter((text: string) => /description/.test(text)).length
    const lines = async () =>
      (await ann.ok('GET', `/api/boards/${id}/tasks/A/activity`)).entries
        .filter((e: { lines: { text: string }[] }) => e.lines.some((l) => /description/.test(l.text)))
        .map((e: { actor: { name: string } }) => e.actor.name)
    const before = { told: await told(), lines: (await lines()).length }
    const a = await (await Writing.open(ann, id)).join()
    a.load('Start.')
    const b = await (await Writing.open(bob, id)).join()
    // Both write; Ann's browser is the one that saves, again and again as the writing goes on.
    for (const round of [1, 2, 3]) {
      a.type(` A${round}.`)
      b.type(` B${round}.`)
      await a.until(() => a.text === b.text && a.text.includes(`B${round}.`))
      expect((await run(ann, { type: 'task.update', id: 'A', fields: { description: a.text }, session: a.session })).status).toBe(200)
    }
    // Each of them once, not three times; whoever saved is no more its writer than the other.
    expect((await lines()).slice(0, (await lines()).length - before.lines).sort()).toEqual(['Ann', 'Bob'])
    expect((await told()) - before.told).toBe(1)
    const { versions } = await ann.ok('GET', `/api/boards/${id}/tasks/A/versions`)
    expect(versions.filter((v: { by: { name: string } | null }) => v.by).map((v: { by: { name: string } }) => v.by.name)).toEqual(['Ann'])
    // (One version: Ann's saves of these few minutes, the first of them included.)
    // Bob writes on after Ann has left, and it is another browser that saves it (his own went before it did): the
    // text is put down to Bob, who wrote it.
    a.say({ type: 'doc', op: 'leave', taskId: 'A' })
    b.type(' Bob alone.')
    await wait(60)
    expect((await run(ann, { type: 'task.update', id: 'A', fields: { description: b.text }, session: b.session })).status).toBe(200)
    const newest = (await ann.ok('GET', `/api/boards/${id}/tasks/A/versions`)).versions[0]
    expect(newest.by.name).toBe('Bob')
    a.close()
    b.close()
  })

  it('ends when the card goes, and puts out whoever may no longer write', async () => {
    const { ann, bob, id, run } = await team()
    const a = await (await Writing.open(ann, id)).join()
    a.load('')
    const b = await (await Writing.open(bob, id)).join()
    // Bob becomes a viewer: out of the session, and not back in.
    await ann.ok('PATCH', `/api/boards/${id}/members/${bob.user.id}`, { role: 'viewer' })
    expect(await b.until(() => b.refused !== null)).toBe(true)
    expect(b.refused).toMatch(/any more/)
    expect(await a.until(() => a.writers()?.length === 1)).toBe(true)
    b.refused = null
    await b.join()
    expect(b.refused).toMatch(/can’t change it/)
    // The card is archived: the session is over, for everyone in it.
    expect((await run(ann, { type: 'task.archive', id: 'A' })).status).toBe(200)
    expect(await a.until(() => a.ended)).toBe(true)
    expect(t.app.docs.sessionId(id, 'A')).toBeNull()
    expect(a.writers()).toEqual([])
    a.close()
    b.close()
  })
})

describe('what an undo puts back', () => {
  it('keeps the description as it is now, unless the change undone was to the description', async () => {
    const { ann, id } = await team()
    const data = (await ann.ok('GET', `/api/boards/${id}`)).data
    const now = { ...data.tasks.A, description: 'Written since, by several people.', version: data.tasks.A.version + 3 }
    const board = { ...data, tasks: { ...data.tasks, A: now } }
    const at = new Date().toISOString()
    // An older change to the card's priority, undone: the text of that moment doesn't come back with it.
    const prio = {
      entity: 'task' as const,
      id: 'A',
      before: { ...data.tasks.A, description: 'Old.' },
      after: { ...data.tasks.A, description: 'Old.', priority: 'high' },
    }
    expect(invertChanges(board, [prio], at)[0].after).toMatchObject({ description: 'Written since, by several people.' })
    // A change to the description, undone, does bring the earlier text back.
    const text = { entity: 'task' as const, id: 'A', before: { ...data.tasks.A, description: 'Old.' }, after: now }
    expect(invertChanges(board, [text], at)[0].after).toMatchObject({ description: 'Old.' })
    // (And a card that had no description gets none.)
    const { description: _none, ...bare } = data.tasks.A
    const none = { entity: 'task' as const, id: 'A', before: bare, after: { ...bare, priority: 'high' } }
    const empty = { ...data, tasks: { ...data.tasks, A: bare } }
    expect('description' in invertChanges(empty, [none], at)[0].after!).toBe(false)
  })
})

describe('saves held for what listens from outside', () => {
  it('go out as one change once the writing has paused, in order with everything else', () => {
    vi.useFakeTimers()
    try {
      const sent: { boardId: string; e: Changed }[] = []
      const held = new HeldSaves((boardId, e) => sent.push({ boardId, e }), { pause: 1000, most: 5000 })
      const save = (seq: number, from: string, to: string, id = 'T'): Changed => ({
        board: { id: 'B', name: 'Board' },
        userId: 'u',
        command: 'task.update',
        seq,
        items: [],
        autosave: true,
        changes: [{ entity: 'task', id, before: { description: from }, after: { description: to } } as never],
      })
      held.hold('B', save(1, 'a', 'ab'))
      vi.advanceTimersByTime(900)
      held.hold('B', save(2, 'ab', 'abc'))
      vi.advanceTimersByTime(900)
      expect(sent).toHaveLength(0)
      vi.advanceTimersByTime(200)
      // One change: the card before the first save and after the last, with the last one's number.
      expect(sent.map((s) => [s.e.seq, s.e.changes[0].before, s.e.changes[0].after])).toEqual([[2, { description: 'a' }, { description: 'abc' }]])
      // Writing that never pauses still goes out every so often.
      for (let i = 0; i < 8; i++) {
        held.hold('B', save(10 + i, `${i}`, `${i + 1}`))
        vi.advanceTimersByTime(800)
      }
      expect(sent).toHaveLength(2)
      expect(sent[1].e.changes[0].before).toEqual({ description: '0' })
      // Something else happening on the board sends what is held first; another board's is left.
      held.hold('B', save(29, 'w', 'x'))
      held.hold('B', save(30, 'x', 'y', 'T2'))
      held.hold('C', save(1, 'p', 'q'))
      const before = sent.length
      held.flush('B')
      expect(sent.slice(before).map((s) => [s.boardId, s.e.changes[0].id])).toEqual(
        expect.arrayContaining([
          ['B', 'T'],
          ['B', 'T2'],
        ]),
      )
      expect(sent.some((s) => s.boardId === 'C')).toBe(false)
      held.flush()
      expect(sent.at(-1)!.boardId).toBe('C')
    } finally {
      vi.useRealTimers()
    }
  })
})
