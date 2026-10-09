import type { DocMessage, LiveMessage } from '@kanbanto/model/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { LiveDocs, type Writer } from '../src/boards/liveDocs'

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))
type Sock = { readyState: number; OPEN: number; got: LiveMessage[] }

/**
 * A browser with a card's description open, as far as the server can tell: it joins, takes in what it is sent, and
 * sends on what is typed in it. The text is a Y.Text here (the real one is the editor's document): what the server
 * does with it is the same.
 */
class Browser {
  socket: Sock = { readyState: 1, OPEN: 1, got: [] }
  doc = new Y.Doc()
  session: string | undefined
  seedAsked = false
  /** It loaded the saved text into the document it has now. */
  seeder = false
  refused: string | null = null
  ended = false
  resets = 0
  /** Its connection is down: nothing it writes is sent. */
  offline = false
  private read = 0
  private docs: LiveDocs
  who: Writer
  private task: string
  constructor(docs: LiveDocs, name: string, task = 'T1', canWrite = true) {
    this.docs = docs
    this.who = { userId: name.toLowerCase(), name, canWrite }
    this.task = task
    this.listen()
  }
  private listen() {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'server' && this.session && !this.offline)
        this.say({ type: 'doc', op: 'update', taskId: this.task, session: this.session, data: b64(update) })
    })
  }
  say(m: Parameters<LiveDocs['handle']>[3]) {
    this.docs.handle('B1', this.socket, this.who, m)
    this.take()
  }
  join() {
    this.say({ type: 'doc', op: 'join', taskId: this.task, session: this.session, client: this.doc.clientID, seeder: this.seeder })
    return this
  }
  /** Takes in what the server sent since last time. */
  take() {
    while (this.read < this.socket.got.length) {
      // (Counted as read first: taking one in can make this browser say something, which takes in the next.)
      const m = this.socket.got[this.read++] as DocMessage
      if (m.type !== 'doc') continue
      if (m.op === 'joined') {
        if (!m.same) {
          this.doc.destroy()
          this.doc = new Y.Doc()
          this.seeder = false
          this.listen()
        }
        this.session = m.session
        Y.applyUpdate(this.doc, bytesOf(m.state), 'server')
        if (m.same)
          this.say({
            type: 'doc',
            op: 'update',
            taskId: this.task,
            session: m.session,
            data: b64(Y.encodeStateAsUpdate(this.doc, bytesOf(m.vector))),
          })
        if (m.seed) this.seedAsked = true
      } else if (m.op === 'update') Y.applyUpdate(this.doc, bytesOf(m.data), 'server')
      else if (m.op === 'seed') this.seedAsked = true
      else if (m.op === 'reset') {
        // (Told to join again, as a browser does.)
        this.resets++
        this.join()
      } else if (m.op === 'ended') this.ended = true
      else if (m.op === 'refused') this.refused = m.error
    }
  }
  /** Loads the saved text, with the mark that says it is in: one change, as the editor makes it. */
  seed(saved: string) {
    this.doc.transact(() => {
      this.doc.getText('t').insert(0, saved)
      this.doc.getMap('meta').set('seeded', true)
      this.doc.getMap('meta').set('by', this.doc.clientID)
    })
    this.seedAsked = false
    this.seeder = true
  }
  type(text: string, at = this.text.length) {
    this.doc.getText('t').insert(at, text)
  }
  get text() {
    return this.doc.getText('t').toString()
  }
  leave() {
    this.say({ type: 'doc', op: 'leave', taskId: this.task })
  }
  /** The connection goes (the server sees the browser leave), and comes back as a new one. */
  drop() {
    this.docs.leaveAll(this.socket)
    this.offline = true
  }
  back() {
    this.socket = { readyState: 1, OPEN: 1, got: [] }
    this.read = 0
    this.offline = false
    return this.join()
  }
}

let told: LiveMessage[]
let docs: LiveDocs
const all = (...bs: Browser[]) => bs.forEach((b) => b.take())
beforeEach(() => {
  vi.useFakeTimers()
  told = []
  docs = new LiveDocs(
    (socket, m) => (socket as Sock).got.push(m),
    (_board, m) => told.push(m),
    { grace: 15_000, quiet: 60_000 },
  )
})
afterEach(() => vi.useRealTimers())
const writers = () => (told.filter((m) => m.type === 'writing').at(-1) as { people: { name: string }[] } | undefined)?.people.map((p) => p.name)

describe('people writing one description at once', () => {
  it('the saved text is loaded once, by the first to join; the others get it from the session', () => {
    const ann = new Browser(docs, 'Ann').join()
    const ben = new Browser(docs, 'Ben').join()
    expect([ann.seedAsked, ben.seedAsked]).toEqual([true, false])
    expect(ann.session).toBe(ben.session)
    // Ben types before the text is in: it isn't taken (it would end up under the text), and he starts again from
    // what the session has. (The editor doesn't let him: it can't be written in until the text is there.)
    ben.type('too early')
    expect([ben.resets, ben.text]).toEqual([1, ''])
    ann.seed('The saved text.')
    all(ann, ben)
    expect([ann.text, ben.text]).toEqual(['The saved text.', 'The saved text.'])
    const cy = new Browser(docs, 'Cy').join()
    expect([cy.seedAsked, cy.text]).toEqual([false, 'The saved text.'])
    expect(writers()).toEqual(['Ann', 'Ben', 'Cy'])
  })

  it('what each writes reaches the others, and five people typing at once end with the same text', () => {
    const people = ['Ann', 'Ben', 'Cy', 'Dee', 'Eli'].map((n) => new Browser(docs, n).join())
    people[0].seed('Start. ')
    all(...people)
    for (let round = 0; round < 40; round++) {
      const b = people[round % 5]
      // (Each at a place of their own, as five cursors in one text are.)
      b.type(`${round % 5 === 0 ? 'A' : round % 5}${round} `, Math.min(b.text.length, (round * 7) % 20))
      if (round % 3 === 0) all(...people)
    }
    all(...people)
    all(...people)
    const texts = new Set(people.map((b) => b.text))
    expect(texts.size).toBe(1)
    // Nothing is lost and nothing is there twice: the text that was loaded, and each of the forty pieces, once.
    const text = [...texts][0]
    let typed = 0
    for (let round = 0; round < 40; round++) typed += `${round % 5 === 0 ? 'A' : round % 5}${round} `.length
    expect(text.length).toBe('Start. '.length + typed)
    expect(text.replace(/[A0-9 ]/g, '')).toBe('Start.')
  })

  it('whoever was asked to load the text and left first is replaced', () => {
    const ann = new Browser(docs, 'Ann').join()
    const ben = new Browser(docs, 'Ben').join()
    ann.leave()
    all(ben)
    expect(ben.seedAsked).toBe(true)
    ben.seed('Saved.')
    const cy = new Browser(docs, 'Cy').join()
    expect([cy.seedAsked, cy.text]).toEqual([false, 'Saved.'])
    expect(writers()).toEqual(['Ben', 'Cy'])
  })

  it('someone who may only read can’t join, and who loses the right to write is put out', async () => {
    const vic = new Browser(docs, 'Vic', 'T1', false).join()
    expect(vic.refused).toMatch(/can read/)
    expect(vic.session).toBeUndefined()
    const ann = new Browser(docs, 'Ann').join()
    ann.seed('x')
    const ben = new Browser(docs, 'Ben').join()
    await docs.recheck('B1', async (userId) => userId !== 'ben')
    all(ann, ben)
    expect(ben.refused).toMatch(/any more/)
    // What he types now goes nowhere: told to join again, he is refused (the server looks his rights up each time).
    ben.who.canWrite = false
    ben.refused = null
    ben.type('after')
    all(ann, ben)
    expect(ann.text).toBe('x')
    expect([ben.resets, ben.refused]).toEqual([1, 'You can read this card, and can’t change it.'])
    expect(writers()).toEqual(['Ann'])
  })

  it('a browser that lost its connection carries on in the same session, with what it wrote meanwhile', () => {
    const ann = new Browser(docs, 'Ann').join()
    ann.seed('One. ')
    const ben = new Browser(docs, 'Ben').join()
    // Ben's connection goes: the server sees him leave, and he types on.
    ben.drop()
    ben.type('Typed offline. ')
    ann.type('Ann meanwhile. ', 0)
    ben.back()
    all(ann, ben)
    expect(ben.text).toBe(ann.text)
    expect(ann.text).toContain('Typed offline. ')
    expect(ann.text).toContain('Ann meanwhile. ')
  })

  it('a session nobody is in ends after a while, and a browser from an ended one starts afresh', () => {
    const ann = new Browser(docs, 'Ann').join()
    ann.seed('Old session. ')
    const old = ann.session
    ann.leave()
    expect(writers()).toEqual([])
    expect(docs.size).toBe(1)
    vi.advanceTimersByTime(15_001)
    expect(docs.size).toBe(0)
    // Back with the old document (say the server had started again): it is told to load the text itself, into a new one.
    ann.type('Unsaved tail.')
    ann.join()
    expect(ann.session).not.toBe(old)
    expect([ann.seedAsked, ann.text]).toEqual([true, ''])
    // Changes sent for a session that is gone are answered with "join again", and taken in by nobody.
    const ben = new Browser(docs, 'Ben', 'T2')
    ben.session = 'gone'
    ben.type('into nothing')
    expect([ben.resets, ben.text, ben.seedAsked]).toEqual([1, '', true])
    expect(ben.session).not.toBe('gone')
  })

  it('someone whose loading of the text never arrived doesn’t add theirs to another’s', () => {
    const ann = new Browser(docs, 'Ann').join()
    const ben = new Browser(docs, 'Ben').join()
    // Ann loads the text as her connection goes: the server never gets it, and asks Ben.
    ann.drop()
    ann.seed('Saved once.')
    all(ben)
    expect(ben.seedAsked).toBe(true)
    ben.seed('Saved once.')
    // Back in the same session with a document that has the text too: it isn't put with Ben's, she takes his.
    ann.back()
    all(ann, ben)
    expect([ann.text, ben.text]).toEqual(['Saved once.', 'Saved once.'])
    expect(ann.seeder).toBe(false)
    // (Had hers arrived, her document would have gone on.)
    ben.drop()
    ben.type(' More.')
    ben.back()
    all(ann, ben)
    expect([ann.text, ben.text]).toEqual(['Saved once. More.', 'Saved once. More.'])
  })

  it('a browser that built on a change the server never got joins again, and brings it', () => {
    const ann = new Browser(docs, 'Ann').join()
    ann.seed('Base. ')
    const ben = new Browser(docs, 'Ben').join()
    // One of Ben's changes is lost on the way; the next builds on it.
    ben.offline = true
    ben.type('lost ')
    ben.offline = false
    ben.type('next')
    all(ann, ben)
    expect(ben.resets).toBe(1)
    expect([ann.text, ben.text]).toEqual(['Base. lost next', 'Base. lost next'])
  })

  it('a change from outside waits while someone is writing, and not once they have stopped', () => {
    const ann = new Browser(docs, 'Ann').join()
    ann.seed('Text. ')
    const ben = new Browser(docs, 'Ben').join()
    // From anywhere else it waits; the writing itself being saved doesn't.
    expect(docs.blocks('B1', 'T1')).toEqual([
      { id: 'ann', name: 'Ann' },
      { id: 'ben', name: 'Ben' },
    ])
    expect(docs.blocks('B1', 'T1', 'another session')).toHaveLength(2)
    expect(docs.blocks('B1', 'T1', ann.session)).toBeNull()
    expect(docs.blocks('B1', 'T2')).toBeNull()
    // Nobody has written for a while (the window is only open): the change may go on.
    vi.advanceTimersByTime(60_001)
    expect(docs.blocks('B1', 'T1')).toBeNull()
    ben.type('Ben again. ')
    expect(docs.blocks('B1', 'T1')).toHaveLength(2)
    // After such a change everyone starts again, and the first back loads the text as it is saved now.
    const old = ann.session
    docs.restart('B1', 'T1')
    all(ann, ben)
    expect([ann.resets, ben.resets]).toEqual([1, 1])
    expect(ann.session).not.toBe(old)
    expect(ann.session).toBe(ben.session)
    expect([ann.seedAsked, ben.seedAsked, ann.text, ben.text]).toEqual([true, false, '', ''])
    // With nobody in it, nothing waits.
    ann.leave()
    ben.leave()
    expect(docs.blocks('B1', 'T1')).toBeNull()
  })

  it('says who is writing a card, and ends when the card goes', () => {
    const ann = new Browser(docs, 'Ann').join()
    const ann2 = new Browser(docs, 'Ann').join()
    const ben = new Browser(docs, 'Ben', 'T2').join()
    // (Two windows are one person.)
    expect(docs.sessionId('B1', 'T1')).toBe(ann.session)
    expect(docs.blocks('B1', 'T1')).toEqual([{ id: 'ann', name: 'Ann' }])
    expect(docs.writing('B1').map((w) => [w.taskId, w.people.map((p) => p.name)])).toEqual([
      ['T1', ['Ann']],
      ['T2', ['Ben']],
    ])
    expect(docs.sessionId('B1', 'nope')).toBeNull()
    docs.end('B1', 'T1')
    all(ann, ann2, ben)
    expect([ann.ended, ann2.ended, ben.ended]).toEqual([true, true, false])
    expect(docs.sessionId('B1', 'T1')).toBeNull()
    // The server stopping takes the rest with it.
    docs.stop()
    expect(docs.size).toBe(0)
  })

  it('passes cursors on, and takes a writer’s cursor away when they leave', () => {
    const ann = new Browser(docs, 'Ann').join()
    const ben = new Browser(docs, 'Ben').join()
    const mine = new Awareness(ann.doc)
    mine.setLocalState({ user: { name: 'Ann' } })
    ann.say({ type: 'doc', op: 'awareness', taskId: 'T1', data: b64(encodeAwarenessUpdate(mine, [ann.doc.clientID])) })
    const seen = () => ben.socket.got.filter((m) => m.type === 'doc' && m.op === 'awareness').length
    expect(seen()).toBe(1)
    // Someone joining later is told where everyone is.
    const cy = new Browser(docs, 'Cy').join()
    const joined = cy.socket.got.find((m) => m.type === 'doc' && m.op === 'joined') as Extract<DocMessage, { op: 'joined' }>
    expect(bytesOf(joined.awareness).length).toBeGreaterThan(2)
    ann.leave()
    expect(seen()).toBe(2)
    // Nonsense is neither taken in nor passed on.
    ben.say({ type: 'doc', op: 'awareness', taskId: 'T1', data: 'not-an-update' })
    ben.say({ type: 'doc', op: 'update', taskId: 'T1', session: ben.session!, data: b64(new Uint8Array([9, 9, 9])) })
    expect(ben.resets).toBeGreaterThan(0)
  })
})
