import { EDITOR_VERSION, type DocMessage, type DocRequest } from '@kanbanto/model/api'
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as Y from 'yjs'

// A card's description while several people write it at once.
//
// The description stays what it is: Markdown, saved on the card. While it is open for writing, its text lives in a
// shared document (Yjs) that every browser writing it holds a copy of: each key goes to the others through the
// board's live connection and the server (boards/liveDocs.ts there), and two people typing in the same sentence end
// with the same sentence. The editor is bound to that document (text/Editor.tsx, `shared`), and Description.tsx saves
// the Markdown as the writing goes.
//
// This is one browser's part in such a session: joining, taking in what the others write, sending what is written
// here, and coming back after the connection was lost. Coming back, the server says whether this browser's document
// is still the session's (`same`): then both are put together, and nothing typed meanwhile is lost. Otherwise the
// session it was in is over (everyone had left, or the server started again), and it starts again from the session
// there is now: two documents with different pasts are never put together, since every line would be there twice.

/**
 * What a description being written with others hears from the board's connection: what the server sends about it, and
 *  - up: the connection is there, the board is as the server has it, and what was waiting to be saved has gone
 *    (now, and each time it comes back);
 *  - down: it is gone;
 *  - unsaved: a save of that card's description was refused.
 */
export type DocEvent = DocMessage | { type: 'up' } | { type: 'down' } | { type: 'unsaved'; taskId: string }

/** What a shared description needs of the board's live connection (`BoardSync` has it). */
export interface DocLink {
  sendDoc: (m: DocRequest) => boolean
  onDoc: (l: (e: DocEvent) => void) => () => void
  isUp: () => boolean
}

export interface LiveState {
  /**
   * joining: asked, not answered yet. live: in the session. away: the connection is gone (what is typed stays in
   * this browser's document until it is back). refused: this person may only read, or (`reload`) this page was
   * opened before the app was updated and has to be loaded again to write. ended: the card is gone.
   */
  status: 'joining' | 'live' | 'away' | 'refused' | 'ended'
  /** Which document this is, counted: it goes up each time this browser starts again from the session's document. */
  epoch: number
  doc: Y.Doc | null
  awareness: Awareness | null
  session: string | null
  /** This browser is the one to load the saved text into the document (see `seedWith`). */
  seed: boolean
  /** Someone has written in the document since the saved text was loaded into it: it is to be saved. */
  touched: boolean
  error?: string
  reload?: boolean
}

/** Where changes that came from the others are marked as theirs (so they aren't sent back). */
const THEIRS = 'theirs'

const b64 = (bytes: Uint8Array) => {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}
const bytesOf = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** The saved text is in the document. */
export const isSeeded = (doc: Y.Doc) => doc.getMap('meta').get('seeded') === true
/** Someone has written in the document since the saved text was loaded into it. */
export const isTouched = (doc: Y.Doc) => doc.getMap('meta').get('touched') === true
export const markTouched = (doc: Y.Doc) => void (isTouched(doc) || doc.getMap('meta').set('touched', true))
/**
 * Loads the saved text into the document: `write` puts it in (the editor does, from Markdown), and the mark that
 * says it is there goes with it as one change, so no browser ever has one without the other. `has`: whether the
 * text is in after `write` (an editor that isn't on the page yet writes nothing: then nothing is marked, and it is
 * tried again). Does nothing in a document that has its text.
 */
export function seedWith(doc: Y.Doc, write: () => void, has: () => boolean): boolean {
  if (isSeeded(doc)) return false
  let done = false
  doc.transact(() => {
    write()
    if (!has()) return
    const meta = doc.getMap('meta')
    meta.set('seeded', true)
    // (Who loaded it: a browser back from a lost connection is asked whether the loading the session has is its own.)
    meta.set('by', doc.clientID)
    done = true
  })
  return done
}

export class LiveDoc {
  readonly taskId: string
  private link: DocLink
  private state: LiveState = { status: 'joining', epoch: 0, doc: null, awareness: null, session: null, seed: false, touched: false }
  private listeners = new Set<() => void>()
  private off: () => void
  /** This browser's document and the server's are in step: what is written here is sent as it is written. */
  private synced = false
  private gone = false
  /** Called just before this browser's document is replaced by the session's: what is in it is about to go. */
  onReplace: (() => void) | null = null
  /** Called when a save of this card's description was refused. */
  onUnsaved: (() => void) | null = null

  constructor(link: DocLink, taskId: string) {
    this.link = link
    this.taskId = taskId
    this.off = link.onDoc(this.hear)
    if (link.isUp()) this.join()
    else this.state = { ...this.state, status: 'away' }
  }

  getState = () => this.state
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  private set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }

  private say(m: DocRequest) {
    return this.link.sendDoc(m)
  }
  private join() {
    const { doc, session } = this.state
    this.say({
      type: 'doc',
      op: 'join',
      taskId: this.taskId,
      editor: EDITOR_VERSION,
      ...(session && { session }),
      ...(doc && { client: doc.clientID, seeder: doc.getMap('meta').get('by') === doc.clientID }),
    })
  }

  private hear = (e: DocEvent) => {
    if (this.gone) return
    if (e.type === 'up') return this.join()
    if (e.type === 'down') {
      this.synced = false
      if (this.state.status === 'live' || this.state.status === 'joining') this.set({ status: 'away' })
      return
    }
    if (e.taskId !== this.taskId) return
    if (e.type === 'unsaved') {
      this.onUnsaved?.()
      // (Its session may be over without this browser knowing: asking to join again finds out.)
      if (this.synced) this.join()
      return
    }
    const { doc, awareness } = this.state
    switch (e.op) {
      case 'joined':
        return this.joined(e)
      case 'update':
        if (!doc || !this.synced) return
        try {
          Y.applyUpdate(doc, bytesOf(e.data), THEIRS)
        } catch {
          this.synced = false
          this.join()
        }
        return
      case 'awareness':
        if (awareness) applyAwarenessUpdate(awareness, bytesOf(e.data), THEIRS)
        return
      case 'seed':
        if (doc && !isSeeded(doc)) this.set({ seed: true })
        return
      case 'reset':
        this.synced = false
        return this.join()
      case 'ended':
        this.synced = false
        return this.set({ status: 'ended' })
      case 'refused':
        this.synced = false
        return this.set({ status: 'refused', error: e.error, reload: !!e.reload })
    }
  }

  private joined(m: Extract<DocMessage, { op: 'joined' }>) {
    let { doc, awareness, epoch } = this.state
    if (!doc || !awareness || !m.same) {
      if (doc) {
        this.onReplace?.()
        this.dispose()
      }
      const fresh = new Y.Doc()
      const theirs = new Awareness(fresh)
      Y.applyUpdate(fresh, bytesOf(m.state), THEIRS)
      fresh.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === THEIRS || !this.synced || this.state.doc !== fresh || !this.state.session) return
        this.say({ type: 'doc', op: 'update', taskId: this.taskId, session: this.state.session, data: b64(update) })
      })
      // (Only this browser's own cursor is its to tell: when it stops hearing of someone else's, that is no news.)
      theirs.on('update', (_: unknown, origin: unknown) => {
        if ((origin !== 'local' && origin !== 'leaving') || !this.synced || this.state.awareness !== theirs) return
        this.say({ type: 'doc', op: 'awareness', taskId: this.taskId, data: b64(encodeAwarenessUpdate(theirs, [fresh.clientID])) })
      })
      // The text is in (nobody is asked to load it any more), or someone has written in it.
      fresh.getMap('meta').observe(() => {
        if (this.state.doc !== fresh) return
        const seed = this.state.seed && !isSeeded(fresh)
        const touched = isTouched(fresh)
        if (seed !== this.state.seed || touched !== this.state.touched) this.set({ seed, touched })
      })
      doc = fresh
      awareness = theirs
      epoch++
    } else Y.applyUpdate(doc, bytesOf(m.state), THEIRS)
    applyAwarenessUpdate(awareness, bytesOf(m.awareness), THEIRS)
    this.synced = true
    this.set({ status: 'live', doc, awareness, epoch, session: m.session, seed: m.seed && !isSeeded(doc), touched: isTouched(doc), error: undefined })
    if (m.same) {
      // What was written here while the connection was gone, which the server doesn't have.
      const mine = Y.encodeStateAsUpdate(doc, bytesOf(m.vector))
      if (mine.length > 2) this.say({ type: 'doc', op: 'update', taskId: this.taskId, session: m.session, data: b64(mine) })
    }
    // Where this browser's cursor is, for everyone (again).
    if (awareness.getLocalState())
      this.say({ type: 'doc', op: 'awareness', taskId: this.taskId, data: b64(encodeAwarenessUpdate(awareness, [doc.clientID])) })
  }

  private dispose() {
    const { doc, awareness } = this.state
    awareness?.destroy()
    doc?.destroy()
  }

  /** Done writing: out of the session (the others stay in it), and nothing more is heard or sent. */
  leave() {
    if (this.gone) return
    const { doc, awareness } = this.state
    if (doc && awareness) removeAwarenessStates(awareness, [doc.clientID], 'leaving')
    this.say({ type: 'doc', op: 'leave', taskId: this.taskId })
    this.gone = true
    this.synced = false
    this.off()
    this.dispose()
    this.listeners.clear()
  }
}
