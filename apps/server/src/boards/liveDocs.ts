import { randomUUID } from 'node:crypto'
import type { DocMessage, DocRequest, LiveMessage } from '@kanbanto/model/api'
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as Y from 'yjs'

// People writing one description at the same time. The description itself stays what it is, Markdown saved on
// the card: this is only the text while it is being written, shared key by key between the browsers that have it
// open (a Yjs document: see the web's data/liveDoc.ts), for as long as someone has. Each browser saves the Markdown
// as its writer pauses, the way one writer's browser always did. When the last one leaves, the session is over and
// nothing of it is kept.
//
// The server holds the document so a browser that joins later gets it whole, passes each change on, and sees to
// what a shared document doesn't do by itself:
//   - the saved text is loaded into it once, by one browser (two loading it would make every line appear twice);
//   - only people who may edit the card write in it;
//   - a browser whose document isn't this session's (the server restarted, the session ended and another began)
//     starts again from what it is given: two documents with different pasts are never put together;
//   - while people are writing, the description isn't changed from anywhere else (`blocks`): their next save would
//     write over it, unseen. Once they have stopped for a while it is, and they start again from the new text.

/** A browser with a description open, as the server knows it. */
type Socket = { readyState: number; OPEN: number }
/** Who a socket is, and whether they may write on this board. */
export interface Writer {
  userId: string
  name: string
  canWrite: boolean
}
interface Member extends Writer {
  /** The Yjs ids its cursors go by (to take them away when it leaves). */
  clients: Set<number>
}
interface Session {
  id: string
  boardId: string
  taskId: string
  doc: Y.Doc
  awareness: Awareness
  members: Map<Socket, Member>
  /** The browser asked to load the saved text, until it has. */
  seeder: Socket | null
  /** When something was last written in it. */
  written: number
  /** Who has written in it since it was last saved (see `took`). */
  wrote: Set<string>
  /** How much has been written into it, in bytes (see MAX_BYTES). */
  bytes: number
  ending: ReturnType<typeof setTimeout> | null
}

/**
 * A session's document keeps everything that was ever typed into it. One that has taken in this much starts again
 * from the saved text (which is at most 50,000 characters): hours of writing don't come near it.
 */
const MAX_BYTES = 8 * 1024 * 1024

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))
const keyOf = (boardId: string, taskId: string) => `${boardId}\u0000${taskId}`
/** The part of the document that says its text has been loaded (set by whoever loaded it, with the text). */
const seeded = (doc: Y.Doc) => doc.getMap('meta').get('seeded') === true
/** Something reached the document that builds on a part it doesn't have. */
const waiting = (doc: Y.Doc) => !!doc.store.pendingStructs

export class LiveDocs {
  private sessions = new Map<string, Session>()
  private send: (socket: Socket, message: LiveMessage) => void
  private announce: (boardId: string, message: LiveMessage) => void
  private grace: number
  private quiet: number

  /**
   * `send`: one message to one browser. `announce`: one to everyone with the board open (who is writing which card).
   * `grace`: how long a session with nobody in it is kept, for a browser that only lost its connection (ms).
   * `quiet`: how long after the last key a session still counts as being written in (ms).
   */
  constructor(
    send: (socket: Socket, message: LiveMessage) => void,
    announce: (boardId: string, message: LiveMessage) => void,
    { grace = 120_000, quiet = 120_000 }: { grace?: number; quiet?: number } = {},
  ) {
    this.send = send
    this.announce = announce
    this.grace = grace
    this.quiet = quiet
  }

  /** What a browser sent about a description it has open. Anything out of place is answered, never thrown. */
  handle(boardId: string, socket: Socket, who: Writer, m: DocRequest) {
    if (m.op === 'join') return this.join(boardId, socket, who, m)
    const s = this.sessions.get(keyOf(boardId, m.taskId))
    const member = s?.members.get(socket)
    if (m.op === 'leave') return void (s && member && this.remove(s, socket))
    // Not in this card's session (it ended, or the server started again): told to join again, with nothing taken in.
    if (!s || !member) return this.reset(socket, m.taskId)
    if (m.op === 'awareness') {
      try {
        applyAwarenessUpdate(s.awareness, bytesOf(m.data), socket)
      } catch {
        // (Not an awareness update: nothing to pass on.)
      }
      return
    }
    if (m.session !== s.id) return this.reset(socket, m.taskId)
    // Until the saved text is in, only the browser asked to load it writes. Anyone else's keys would end up under
    // it, and what they write next would build on keys the server never took: they start again from what is here.
    if (!seeded(s.doc) && s.seeder !== socket) return this.reset(socket, m.taskId)
    const data = bytesOf(m.data)
    const whole = !waiting(s.doc)
    // (Loading the saved text into it isn't writing.)
    const writes = seeded(s.doc)
    try {
      Y.applyUpdate(s.doc, data, socket)
    } catch {
      return this.reset(socket, m.taskId)
    }
    s.written = Date.now()
    s.bytes += data.length
    if (writes) s.wrote.add(member.userId)
    if (s.seeder === socket && seeded(s.doc)) s.seeder = null
    // It built on something the server doesn't have (a change of theirs was lost on the way): they join again, and
    // what they have that the server lacks comes with it.
    if (whole && waiting(s.doc)) return this.reset(socket, m.taskId)
    // The document has grown past all use: everyone starts again from the saved text.
    if (s.bytes > MAX_BYTES) this.restart(boardId, m.taskId)
  }

  private reset(socket: Socket, taskId: string) {
    this.send(socket, { type: 'doc', op: 'reset', taskId })
  }

  private join(boardId: string, socket: Socket, who: Writer, m: Extract<DocRequest, { op: 'join' }>) {
    const { taskId } = m
    if (!who.canWrite) return this.send(socket, { type: 'doc', op: 'refused', taskId, error: 'You can read this card, and can’t change it.' })
    const s = this.sessions.get(keyOf(boardId, taskId)) ?? this.open(boardId, taskId)
    if (s.ending) clearTimeout(s.ending)
    s.ending = null
    const known = s.members.get(socket)
    if (!known) s.members.set(socket, { ...who, clients: new Set() })
    // Asked to load the saved text: the first to join a session that has none, when nobody else is at it.
    let seed = false
    if (!seeded(s.doc) && (!s.seeder || !s.members.has(s.seeder) || s.seeder === socket)) {
      s.seeder = socket
      seed = true
    }
    // Their document goes on when they were in this very session a moment ago: then what they wrote meanwhile comes
    // in too. Unless they loaded the saved text themselves and it isn't their loading the session has (it never
    // arrived, and someone else was asked since): put together, the text would be there twice.
    // And not before the saved text is in, unless they are the one loading it: nothing they have can be kept under it.
    const same =
      m.session === s.id &&
      (seeded(s.doc) || s.seeder === socket) &&
      (!m.seeder || (m.client !== undefined && s.doc.getMap('meta').get('by') === m.client))
    const reply: DocMessage = {
      type: 'doc',
      op: 'joined',
      taskId,
      session: s.id,
      same,
      seed,
      state: b64(Y.encodeStateAsUpdate(s.doc)),
      vector: b64(Y.encodeStateVector(s.doc)),
      awareness: b64(encodeAwarenessUpdate(s.awareness, [...s.awareness.getStates().keys()])),
    }
    this.send(socket, reply)
    if (!known) this.tellWriters(s)
  }

  private open(boardId: string, taskId: string): Session {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    // (The server shows no cursor of its own.)
    awareness.setLocalState(null)
    const s: Session = {
      id: randomUUID(),
      boardId,
      taskId,
      doc,
      awareness,
      members: new Map(),
      seeder: null,
      written: Date.now(),
      wrote: new Set(),
      bytes: 0,
      ending: null,
    }
    // Every change goes on to the other browsers in the session, as it came.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const data = b64(update)
      for (const other of s.members.keys()) if (other !== origin) this.send(other, { type: 'doc', op: 'update', taskId, data })
    })
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const from = s.members.get(origin as Socket)
      if (from) for (const id of added) from.clients.add(id)
      const data = b64(encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]))
      for (const other of s.members.keys()) if (other !== origin) this.send(other, { type: 'doc', op: 'awareness', taskId, data })
    })
    this.sessions.set(keyOf(boardId, taskId), s)
    return s
  }

  private remove(s: Session, socket: Socket) {
    const member = s.members.get(socket)
    if (!member) return
    s.members.delete(socket)
    // Their cursor goes with them.
    removeAwarenessStates(s.awareness, [...member.clients], 'left')
    if (s.seeder === socket) {
      s.seeder = null
      // They left before the saved text was in: the next one is asked.
      const next = !seeded(s.doc) ? s.members.keys().next().value : undefined
      if (next) {
        s.seeder = next
        this.send(next, { type: 'doc', op: 'seed', taskId: s.taskId })
      }
    }
    this.tellWriters(s)
    if (!s.members.size) s.ending = setTimeout(() => this.drop(s), this.grace)
  }

  private drop(s: Session) {
    if (s.ending) clearTimeout(s.ending)
    if (this.sessions.get(keyOf(s.boardId, s.taskId)) === s) this.sessions.delete(keyOf(s.boardId, s.taskId))
    s.awareness.destroy()
    s.doc.destroy()
  }

  private tellWriters(s: Session) {
    this.announce(s.boardId, { type: 'writing', taskId: s.taskId, people: this.people(s) })
  }

  /** The people in a session, each once (someone with two windows open is one person). */
  private people(s: Session) {
    const seen = new Map<string, { id: string; name: string }>()
    for (const m of s.members.values()) if (!seen.has(m.userId)) seen.set(m.userId, { id: m.userId, name: m.name })
    return [...seen.values()]
  }

  /** A browser went away: it is out of every session it was in. */
  leaveAll(socket: Socket) {
    for (const s of [...this.sessions.values()]) if (s.members.has(socket)) this.remove(s, socket)
  }

  /**
   * Asked before a card's description is changed: the people writing it now, when the change has to wait for them
   * (it would be written over by their next save, without anyone seeing). Null when it may go on: nobody is writing
   * it, `session` says the change is that writing being saved, or they stopped a while ago (after such a change,
   * `restart` gives them the new text).
   */
  blocks(boardId: string, taskId: string, session?: string): { id: string; name: string }[] | null {
    const s = this.sessions.get(keyOf(boardId, taskId))
    if (!s || session === s.id || !s.members.size) return null
    return Date.now() - s.written < this.quiet ? this.people(s) : null
  }

  /**
   * The people who have written in a card's session since this was last asked: asked when its text is saved, which
   * one browser does for everyone (whoever's stopped typing first), so the save can be put down to all of them.
   */
  took(boardId: string, taskId: string): string[] {
    const s = this.sessions.get(keyOf(boardId, taskId))
    if (!s) return []
    const wrote = [...s.wrote]
    s.wrote.clear()
    return wrote
  }

  /** The id of the session a card's description is being written in (none: null). */
  sessionId(boardId: string, taskId: string): string | null {
    return this.sessions.get(keyOf(boardId, taskId))?.id ?? null
  }

  /** Who is writing which card on a board, for a browser that has just opened it. */
  writing(boardId: string): { taskId: string; people: { id: string; name: string }[] }[] {
    return [...this.sessions.values()]
      .filter((s) => s.boardId === boardId && s.members.size)
      .map((s) => ({ taskId: s.taskId, people: this.people(s) }))
  }

  /**
   * The description was changed from outside the session (or its document can't go on): the session is over, and
   * the browsers in it are told to join again. The first back loads the text as it is saved now.
   */
  restart(boardId: string, taskId: string) {
    this.close(boardId, taskId, 'reset')
  }

  /** The card is gone (deleted, archived, moved to another board): its session is over, and everyone in it is told. */
  end(boardId: string, taskId: string) {
    this.close(boardId, taskId, 'ended')
  }

  private close(boardId: string, taskId: string, op: 'reset' | 'ended') {
    const s = this.sessions.get(keyOf(boardId, taskId))
    if (!s) return
    const had = [...s.members.keys()]
    s.members.clear()
    this.drop(s)
    for (const socket of had) this.send(socket, { type: 'doc', op, taskId })
    if (had.length) this.announce(boardId, { type: 'writing', taskId, people: [] })
  }

  /** Someone's rights on a board changed: whoever may no longer write is out of its sessions. */
  async recheck(boardId: string, canWrite: (userId: string) => Promise<boolean>) {
    for (const s of [...this.sessions.values()]) {
      if (s.boardId !== boardId) continue
      for (const [socket, m] of [...s.members]) {
        if (await canWrite(m.userId)) continue
        this.send(socket, { type: 'doc', op: 'refused', taskId: s.taskId, error: 'You can read this card, and can’t change it any more.' })
        this.remove(s, socket)
      }
    }
  }

  /** The server is stopping: nothing is kept (browsers that come back start again from the saved text). */
  stop() {
    for (const s of [...this.sessions.values()]) this.drop(s)
  }

  /** How many sessions are open (for the server's own figures, and tests). */
  get size() {
    return this.sessions.size
  }
}
