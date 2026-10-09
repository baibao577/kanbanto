import type { DocRequest, LiveMessage } from '@kanbanto/model/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveDoc, seedWith, type DocEvent, type DocLink } from '../../web/src/data/liveDoc'
import { LiveDocs } from '../src/boards/liveDocs'

// The two halves of writing a description together, put end to end: the browser's part (the web's data/liveDoc.ts,
// as it runs there) and the server's (boards/liveDocs.ts), with a connection between them that delivers in order,
// can go, and can come back to a server that has started again. The text is a Y.Text in the shared document (in
// the app it is the editor's own structure there, which the two halves never look into).

type Sock = { readyState: number; OPEN: number }

/** The server, and what is on its way to and from it. */
class Net {
  server!: LiveDocs
  /** Messages on their way, in the order they were sent. */
  private queue: (() => void)[] = []
  peers = new Map<Sock, Peer>()
  writing: string[] = []
  constructor() {
    this.start()
  }
  /** The server starts (again): it remembers no session. */
  start() {
    this.server = new LiveDocs(
      (socket, m) => this.later(() => this.peers.get(socket as Sock)?.hear(socket as Sock, m)),
      (_board, m) => m.type === 'writing' && (this.writing = m.people.map((p) => p.name)),
      { grace: 1000, quiet: 60_000 },
    )
  }
  later(deliver: () => void) {
    this.queue.push(deliver)
  }
  /** Everything on its way arrives (and whatever that sets off, too). */
  settle() {
    for (let n = 0; this.queue.length; n++) {
      if (n > 100_000) throw new Error('messages without end')
      this.queue.shift()!()
    }
  }
  /** Only the next `n` messages arrive. */
  deliver(n: number) {
    while (n-- > 0 && this.queue.length) this.queue.shift()!()
  }
}

/** One person's browser with the card's description open for writing. */
class Peer {
  live: LiveDoc
  replaced = 0
  private socket: Sock = { readyState: 1, OPEN: 1 }
  private up = true
  private listeners = new Set<(e: DocEvent) => void>()
  private net: Net
  private who: { userId: string; name: string; canWrite: boolean }
  constructor(net: Net, name: string) {
    this.net = net
    this.who = { userId: name.toLowerCase(), name, canWrite: true }
    net.peers.set(this.socket, this)
    const link: DocLink = {
      sendDoc: (m: DocRequest) => {
        if (!this.up) return false
        const socket = this.socket
        net.later(() => net.peers.get(socket) === this && net.server.handle('B', socket, this.who, m))
        return true
      },
      onDoc: (l) => {
        this.listeners.add(l)
        return () => void this.listeners.delete(l)
      },
      isUp: () => this.up,
    }
    this.live = new LiveDoc(link, 'T')
    this.live.onReplace = () => this.replaced++
  }
  hear(socket: Sock, m: LiveMessage) {
    if (socket === this.socket && this.up && m.type === 'doc') this.listeners.forEach((l) => l(m))
  }
  private tell(e: DocEvent) {
    this.listeners.forEach((l) => l(e))
  }
  /** The connection goes. `seen`: the server notices (it doesn't when it is the server that went). */
  drop(seen = true) {
    this.up = false
    this.net.peers.delete(this.socket)
    if (seen) this.net.server.leaveAll(this.socket)
    this.tell({ type: 'down' })
  }
  back() {
    this.socket = { readyState: 1, OPEN: 1 }
    this.net.peers.set(this.socket, this)
    this.up = true
    this.tell({ type: 'up' })
  }
  get state() {
    return this.live.getState()
  }
  private get words() {
    return this.state.doc!.getText('t')
  }
  get text() {
    return this.state.doc ? this.words.toString() : null
  }
  /** Loads the saved text when this browser is the one asked to, as its editor does. */
  load(saved: string) {
    const { seed, doc } = this.state
    if (!seed || !doc) return false
    return seedWith(
      doc,
      () => this.words.insert(0, saved),
      () => true,
    )
  }
  type(more: string, at = this.words.length) {
    this.words.insert(Math.min(at, this.words.length), more)
  }
}

let net: Net
beforeEach(() => {
  vi.useFakeTimers()
  net = new Net()
})
afterEach(() => {
  net.server.stop()
  vi.useRealTimers()
})
/** How often `piece` is in `text`. */
const times = (text: string, piece: string) => text.split(piece).length - 1

describe('five browsers and the server, writing one text', () => {
  it('load the saved text once, and end with the same text whatever order their keys arrive in', () => {
    const people = ['Ann', 'Ben', 'Cy', 'Dee', 'Eli'].map((n) => new Peer(net, n))
    net.settle()
    // One of them was asked to load the text; the others can't until it is in.
    expect(people.map((p) => p.state.seed)).toEqual([true, false, false, false, false])
    expect(people.map((p) => p.load('The saved text. '))).toEqual([true, false, false, false, false])
    net.settle()
    expect(new Set(people.map((p) => p.text))).toEqual(new Set(['The saved text. ']))
    expect(people.every((p) => p.state.status === 'live' && !p.state.seed)).toBe(true)
    expect(net.writing).toEqual(['Ann', 'Ben', 'Cy', 'Dee', 'Eli'])
    // Everyone types at once, a word at a time, each at a place of their own; messages arrive a few at a time.
    let n = 7
    const random = () => (n = (n * 1103515245 + 12345) % 2147483648) / 2147483648
    const pieces: string[] = []
    for (let round = 0; round < 60; round++) {
      const who = people[Math.floor(random() * 5)]
      const piece = `<${who.state.doc!.clientID % 97}:${round}>`
      pieces.push(piece)
      who.type(piece, Math.floor(random() * 40))
      net.deliver(Math.floor(random() * 6))
    }
    net.settle()
    const texts = new Set(people.map((p) => p.text))
    expect(texts.size).toBe(1)
    const [text] = texts as Set<string>
    // Nothing lost, nothing twice: the text is the letters that were loaded and typed, each once. (A word typed
    // inside another one splits it, so it is the letters that are counted, not the words.)
    const letters = (t: string) => [...t].sort().join('')
    expect(letters(text)).toBe(letters('The saved text. ' + pieces.join('')))
    expect(people.every((p) => p.replaced === 0)).toBe(true)
  })

  it('take in what was typed while a connection was gone, on both sides', () => {
    const [ann, ben, cy] = ['Ann', 'Ben', 'Cy'].map((n) => new Peer(net, n))
    net.settle()
    ann.load('Start. ')
    net.settle()
    ben.drop()
    expect(ben.state.status).toBe('away')
    ben.type('Ben offline. ')
    ann.type('Ann meanwhile. ')
    cy.type('Cy too. ', 0)
    net.settle()
    expect(ann.text).toBe(cy.text)
    expect(times(ann.text!, 'Ben offline.')).toBe(0)
    ben.back()
    net.settle()
    expect(ben.state.status).toBe('live')
    // The same document went on: nothing of his was replaced, and everyone has everything once.
    expect(ben.replaced).toBe(0)
    expect(new Set([ann.text, ben.text, cy.text]).size).toBe(1)
    for (const piece of ['Start. ', 'Ben offline. ', 'Ann meanwhile. ', 'Cy too. ']) expect(times(ann.text!, piece)).toBe(1)
  })

  it('start again from the saved text when the server has started again, without putting two documents together', () => {
    const people = ['Ann', 'Ben', 'Cy'].map((n) => new Peer(net, n))
    net.settle()
    people[0].load('Saved. ')
    net.settle()
    people[1].type('Typed and never saved. ')
    net.settle()
    const before = people.map((p) => p.state.session)
    // The server goes and comes back knowing nothing. Each browser still holds the old session's document.
    for (const p of people) p.drop(false)
    net.start()
    people[2].type('Cy, while it was down. ')
    for (const p of [people[1], people[2], people[0]]) p.back()
    net.settle()
    // A new session; the first one back is asked to load the saved text, and nobody's old document is merged in.
    expect(people.every((p) => p.replaced === 1)).toBe(true)
    expect(new Set(people.map((p) => p.state.session)).size).toBe(1)
    expect(people[0].state.session).not.toBe(before[0])
    expect(people.map((p) => p.state.seed)).toEqual([false, true, false])
    expect(people.map((p) => p.text)).toEqual(['', '', ''])
    people[1].load('Saved. Typed and never saved. ')
    net.settle()
    expect(new Set(people.map((p) => p.text))).toEqual(new Set(['Saved. Typed and never saved. ']))
    expect(people.every((p) => p.state.epoch === 2)).toBe(true)
  })

  it('ask the next browser when the one loading the text goes first, and never have the text twice', () => {
    const [ann, ben] = ['Ann', 'Ben'].map((n) => new Peer(net, n))
    net.settle()
    // Ann's loading of the text never leaves her browser: her connection is gone as she does it.
    ann.drop()
    ann.load('Once. ')
    net.settle()
    expect(ben.state.seed).toBe(true)
    ben.load('Once. ')
    net.settle()
    ann.back()
    net.settle()
    expect([ann.text, ben.text]).toEqual(['Once. ', 'Once. '])
    expect(ann.replaced).toBe(1)
  })

  it('join again when told the text was changed from outside, and stop when the card goes or they leave', () => {
    const [ann, ben] = ['Ann', 'Ben'].map((n) => new Peer(net, n))
    net.settle()
    ann.load('Old text. ')
    net.settle()
    net.server.restart('B', 'T')
    net.settle()
    expect([ann.state.epoch, ben.state.epoch]).toEqual([2, 2])
    expect([ann.state.seed, ben.state.seed, ann.text]).toEqual([true, false, ''])
    ann.load('New text from outside. ')
    net.settle()
    expect(ben.text).toBe('New text from outside. ')
    // Ben leaves: he hears no more, and Ann writes on.
    ben.live.leave()
    net.settle()
    expect(net.writing).toEqual(['Ann'])
    ann.type('More.')
    net.settle()
    expect(ben.state.doc?.getText('t').toString() ?? '').not.toContain('More.')
    // The card is archived.
    net.server.end('B', 'T')
    net.settle()
    expect(ann.state.status).toBe('ended')
    expect(net.server.size).toBe(0)
  })
})
