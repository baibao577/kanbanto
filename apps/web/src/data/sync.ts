import type { BoardAccess, BoardSnapshot, DocRequest, LiveMessage, MutationResult, TaskCounts } from '@kanbanto/model/api'
import { applyChanges } from '@kanbanto/model/changes'
import { execute, type Command } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import type { Change } from '@kanbanto/model/records'
import type { BoardData, Task } from '@kanbanto/model/types'
import { api, ApiError } from '@/api/client'
import { writeDraft } from './drafts'
import type { DocEvent } from './liveDoc'
import { LinkStore } from './links'

export type Connection = 'connecting' | 'live' | 'offline'

/** Things the screen should tell the person about. */
export type SyncEvent =
  /** A change of yours was refused (someone else's edit got there first, or you lost edit rights). */
  | { type: 'refused'; message: string }
  /** The board was deleted, or you can no longer open it. */
  | { type: 'gone'; reason: 'deleted' | 'access-lost' }
  /** Your session ended. Unsaved changes are kept in this tab and sent once you've signed in again. */
  | { type: 'signed-out' }

/** A comment or file changed on some card (the open task dialog listens for its own). */
export type TaskActivity = Extract<LiveMessage, { type: 'comment' | 'attachment' | 'time' }>

export interface SyncState {
  /** The board as you see it: the server's copy with your unsaved changes on top. */
  data: BoardData
  access: BoardAccess
  /** Comments and files per card. */
  counts: TaskCounts
  canComment: boolean
  /** A card here may have cards linking to it (some card link is in use in the board's space). */
  canBeLinked: boolean
  connection: Connection
  /** Changes made here that the server hasn't confirmed yet. */
  unsaved: number
  /** Who is writing which card's description at this moment (cards nobody is writing aren't in it). */
  writers: Record<string, { id: string; name: string }[]>
}

interface Pending {
  id: string
  command: Command
  /** Sent at least once (it may already be on the server). */
  sent: boolean
}

const ctx = (data: BoardData) => ({ now: new Date().toISOString(), newId, idx: indexFor(data) })
const backoff = (attempt: number) => Math.min(10_000, 500 * 2 ** attempt)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** A change the server keeps failing on (a problem on its side, not a refusal) is given up after this many tries. */
const SERVER_TRIES = 5

/** Unsaved changes survive signing in again (same tab), kept here in between. */
const pendingKey = (boardId: string) => `kankan:pending:${boardId}`
function takeSavedPending(boardId: string): Pending[] {
  try {
    const raw = sessionStorage.getItem(pendingKey(boardId))
    sessionStorage.removeItem(pendingKey(boardId))
    const saved = raw ? (JSON.parse(raw) as { id: string; command: Command }[]) : []
    return saved.map((p) => ({ ...p, sent: false }))
  } catch {
    return []
  }
}
function savePending(boardId: string, pending: Pending[]) {
  try {
    sessionStorage.setItem(pendingKey(boardId), JSON.stringify(pending.map(({ id, command }) => ({ id, command }))))
  } catch {
    // Storage unavailable: the changes are lost with the tab, as before.
  }
}

/** Creates get their id here, so the server makes exactly the same record. */
function withId(cmd: Command): Command {
  if ((cmd.type === 'task.create' || cmd.type === 'column.create' || cmd.type === 'label.create') && !cmd.id) return { ...cmd, id: newId() }
  return cmd
}

/**
 * Keeps one open board in step with the server.
 *
 * Your commands run here at once (so the screen never waits), then go to the server one at a time, in order.
 * The server runs them again with the same rules and sends the resulting changes to everyone with the board open,
 * each numbered (`seq`). This keeps the server's copy (`confirmed`) and your commands not yet confirmed
 * (`pending`); what you see is the pending commands replayed on top of the confirmed copy. When someone else's
 * change arrives, your pending commands are replayed on the new copy; one that no longer works is dropped and
 * you're told why. A missed number means something was lost in transit: the board is fetched again.
 */
export class BoardSync {
  readonly boardId: string
  /** What the cards' links point at (see LinkStore). */
  readonly links: LinkStore
  private confirmed: BoardData
  private seq: number
  private pending: Pending[] = []
  private state: SyncState
  private socket: WebSocket | null = null
  private sending = false
  private closed = false
  /** Signed out: nothing more is sent until the board is opened again (after signing in). */
  private signedOut = false
  private attempts = 0
  /** Server errors in a row for the change at the front of the queue. */
  private serverErrors = 0
  private resyncing: Promise<void> | null = null
  private listeners = new Set<() => void>()
  private eventListeners = new Set<(e: SyncEvent) => void>()
  private activityListeners = new Set<(m: TaskActivity) => void>()
  private templateListeners = new Set<() => void>()
  private docListeners = new Set<(e: DocEvent) => void>()
  /** The live connection is up and the board is in step (see `DocEvent`'s "up"). */
  private up = false
  /** The next try at the live connection, after it was lost. */
  private retry: ReturnType<typeof setTimeout> | undefined
  private unwatch: () => void = () => {}

  constructor(boardId: string, snap: BoardSnapshot) {
    this.boardId = boardId
    this.confirmed = snap.data
    this.seq = snap.seq
    this.links = new LinkStore(boardId)
    this.links.learn(snap.linked ?? {})
    this.links.see(snap.data)
    this.state = {
      data: snap.data,
      access: snap.access,
      counts: snap.counts,
      canComment: snap.canComment,
      canBeLinked: !!snap.canBeLinked,
      connection: 'connecting',
      unsaved: 0,
      writers: {},
    }
    // Changes made before a sign-out in this tab: replayed on the current board and sent now.
    this.pending = takeSavedPending(boardId)
    if (this.pending.length) {
      this.replay()
      void this.flush()
    }
    this.connect()
    this.unwatch = this.watchNetwork()
  }

  getState = () => this.state
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  onActivity(l: (m: TaskActivity) => void) {
    this.activityListeners.add(l)
    return () => void this.activityListeners.delete(l)
  }
  /** The board's card templates changed (someone saved, renamed or removed one): they're to be asked for again. */
  onTemplates(l: () => void) {
    this.templateListeners.add(l)
    return () => void this.templateListeners.delete(l)
  }
  onEvent(l: (e: SyncEvent) => void) {
    this.eventListeners.add(l)
    return () => void this.eventListeners.delete(l)
  }

  // ── Descriptions written with others (see liveDoc.ts) ────────────────────

  /** Listens to what concerns descriptions being written together. */
  onDoc = (l: (e: DocEvent) => void) => {
    this.docListeners.add(l)
    return () => void this.docListeners.delete(l)
  }
  /** Says something about one over the board's live connection. False: there's no connection just now. */
  sendDoc = (m: DocRequest): boolean => {
    if (!this.up || this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(m))
    return true
  }
  /** The connection is up and the board is in step: a description can be joined. */
  isUp = () => this.up && this.socket?.readyState === WebSocket.OPEN
  private tellDocs(e: DocEvent) {
    this.docListeners.forEach((l) => l(e))
  }
  private goneDown() {
    if (!this.up) return
    this.up = false
    this.tellDocs({ type: 'down' })
  }
  /** After "hello": once the board is as the server has it and what waited to be saved has gone (or a moment has passed). */
  private async comeUp(ws: WebSocket, stale: boolean) {
    if (stale) await this.resync()
    for (let waited = 0; this.pending.length && waited < 3000 && this.socket === ws; waited += 50) await sleep(50)
    if (this.socket !== ws || ws.readyState !== WebSocket.OPEN || this.closed) return
    this.up = true
    this.tellDocs({ type: 'up' })
  }

  /** Runs a command: shown at once, saved in the background. Returns its changes, or why it isn't allowed. */
  run(cmd: Command): { changes: Change[] } | { error: string } {
    if (this.state.access.role === 'viewer') return { error: 'You can view this board, but not change it.' }
    const command = withId(cmd)
    const r = execute(this.state.data, command, ctx(this.state.data))
    if ('error' in r || !r.changes.length) return r
    this.pending.push({ id: newId(), command, sent: false })
    this.set({ data: applyChanges(this.state.data, r.changes), unsaved: this.pending.length })
    void this.flush()
    return r
  }

  /**
   * Archived cards fetched from the server (a board comes without them): kept with the server's copy, so they can be
   * shown and restored like before. Ones already here, or back on the board since, are left as they are.
   */
  learnArchived(tasks: Task[]) {
    const known = this.confirmed.archived ?? {}
    const fresh = tasks.filter((t) => t.archivedAt && !this.confirmed.tasks[t.id] && !known[t.id])
    if (!fresh.length) return
    this.confirmed = { ...this.confirmed, archived: { ...known, ...Object.fromEntries(fresh.map((t) => [t.id, t])) } }
    this.replay()
  }

  /**
   * A change the server made for you outside the commands sent from here (cards added from a spreadsheet): taken in
   * now, without waiting for the live connection to bring it (which then has nothing new to say).
   */
  learn(seq: number, changes: Change[]) {
    this.receive(seq, changes)
  }

  close() {
    this.closed = true
    this.goneDown()
    clearTimeout(this.retry)
    this.unwatch()
    this.socket?.close()
    this.socket = null
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  private async flush() {
    if (this.sending || this.closed || this.signedOut) return
    this.sending = true
    try {
      while (this.pending.length && !this.closed && !this.signedOut) {
        const p = this.pending[0]
        p.sent = true
        try {
          const res = await api<MutationResult>('POST', `/boards/${encodeURIComponent(this.boardId)}/mutations`, {
            mutationId: p.id,
            command: p.command,
          })
          this.attempts = 0
          this.serverErrors = 0
          // Saving works again: the "Offline" badge goes, if the live connection is up.
          if (this.state.connection === 'offline' && this.socket?.readyState === WebSocket.OPEN) this.set({ connection: 'live' })
          this.receive(res.seq, res.changes, p.id)
        } catch (e) {
          const status = e instanceof ApiError ? e.status : 0
          if (status === 401) {
            // Signed out (session ended elsewhere, or expired): keep the changes for when you're back.
            this.signedOut = true
            savePending(this.boardId, this.pending)
            this.emit({ type: 'signed-out' })
          } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            this.drop(p, (e as Error).message, e instanceof ApiError ? e.code : undefined)
            // Rights may have changed (or the board is gone): get the current state.
            if (status === 403 || status === 404) void this.resync()
          } else if (status >= 500 && ++this.serverErrors >= SERVER_TRIES) {
            // The server keeps failing on this change: give up on it rather than hold up everything after it.
            this.drop(p, 'A change couldn’t be saved because of a problem on the server, so it was undone.')
            void this.resync()
          } else {
            // Can't reach the server, or it had a problem: keep the change and try again.
            this.set({ connection: 'offline' })
            await sleep(backoff(this.attempts++))
          }
        }
      }
    } finally {
      this.sending = false
    }
  }

  /** Gives up on a change: it's taken off what you see, and you're told why. */
  private drop(p: Pending, message: string, code?: string) {
    this.pending = this.pending.filter((x) => x !== p)
    this.serverErrors = 0
    this.replay()
    const c = p.command
    const text = c.type === 'task.update' ? c.fields.description : undefined
    // A description that wasn't saved.
    if (c.type === 'task.update' && text !== undefined) {
      // Refused because the card's description is being written by others, in a session this save isn't part of:
      // the text is kept as a draft, to offer back.
      const taken = code === 'being-written'
      if (taken) writeDraft(`${this.boardId}:${c.id}`, text)
      // Whoever has the description open is told (see Description.tsx: the text is still in its editor, and is
      // saved again, or it shows the draft).
      this.tellDocs({ type: 'unsaved', taskId: c.id })
      // Writing saved as it goes, from a session that is over: its browser joins the one there is now, quietly.
      if (taken && c.session) return
      if (taken) return this.emit({ type: 'refused', message: `${message} What you wrote is kept: it’s offered back on the card.` })
    }
    this.emit({ type: 'refused', message })
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  private receive(seq: number, changes: Change[], mutationId?: string) {
    const before = this.pending.length
    if (mutationId) this.pending = this.pending.filter((p) => p.id !== mutationId)
    const confirmedMine = this.pending.length !== before
    if (!changes.length || seq <= this.seq) {
      // Nothing new (a no-op, or a change we already have from the other channel).
      if (confirmedMine) this.replay()
      return
    }
    if (seq !== this.seq + 1) {
      void this.resync()
      return
    }
    this.confirmed = applyChanges(this.confirmed, changes)
    this.seq = seq
    this.replay()
  }

  /** What you see = the confirmed copy + your pending commands, replayed. */
  private replay() {
    let data = this.confirmed
    const kept: Pending[] = []
    for (const p of this.pending) {
      const r = execute(data, p.command, ctx(data))
      if ('error' in r) {
        // A sent command may already be in the confirmed copy (seen after a refetch): nothing to report.
        if (!p.sent) this.emit({ type: 'refused', message: `Your change couldn’t be applied: ${r.error}` })
        continue
      }
      data = applyChanges(data, r.changes)
      kept.push(p)
    }
    this.pending = kept
    this.set({ data, unsaved: kept.length })
  }

  /** Fetches the whole board again (missed changes, people or sharing changed). */
  resync(): Promise<void> {
    this.resyncing ??= (async () => {
      try {
        const snap = await api<BoardSnapshot>('GET', `/boards/${encodeURIComponent(this.boardId)}`)
        // The archived cards fetched so far stay (the board comes without them), unless they're back on it.
        const learned = Object.entries(this.confirmed.archived ?? {}).filter(([id]) => !snap.data.tasks[id])
        this.confirmed = learned.length ? { ...snap.data, archived: Object.fromEntries(learned) } : snap.data
        this.seq = snap.seq
        this.links.learn(snap.linked ?? {})
        this.set({ access: snap.access, counts: snap.counts, canComment: snap.canComment, canBeLinked: !!snap.canBeLinked })
        this.replay()
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) this.emit({ type: 'gone', reason: 'access-lost' })
      } finally {
        this.resyncing = null
      }
    })()
    return this.resyncing
  }

  private connect() {
    clearTimeout(this.retry)
    if (this.closed || this.socket) return
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/boards/${encodeURIComponent(this.boardId)}/live`
    const ws = new WebSocket(url)
    this.socket = ws
    ws.onmessage = (e) => this.socket === ws && this.onMessage(JSON.parse(String(e.data)) as LiveMessage, ws)
    ws.onclose = (e) => {
      if (this.socket !== ws || this.closed) return
      this.socket = null
      // (Told why in a message just before: the board is gone, or closed to this person.)
      this.lost(e.code !== 4403 && e.code !== 4404)
    }
  }

  /** The live connection is gone. `again`: it is tried again, after a moment that grows with each try. */
  private lost(again: boolean) {
    this.goneDown()
    // (Who was writing what is told again when the connection is back.)
    if (Object.keys(this.state.writers).length) this.set({ writers: {} })
    if (!again) return
    this.set({ connection: 'offline' })
    clearTimeout(this.retry)
    this.retry = setTimeout(() => this.connect(), backoff(this.attempts++))
  }

  /**
   * The browser says the network is gone, or back. A connection that is only open in name tells nobody for a long
   * while (what is typed into a shared description would go nowhere, unnoticed): it is let go at once, and made
   * again the moment the network is back.
   */
  private watchNetwork() {
    if (typeof window === 'undefined') return () => {}
    const gone = () => {
      const ws = this.socket
      if (!ws || this.closed) return
      this.socket = null
      ws.close()
      this.lost(true)
    }
    const back = () => this.connect()
    window.addEventListener('offline', gone)
    window.addEventListener('online', back)
    return () => {
      window.removeEventListener('offline', gone)
      window.removeEventListener('online', back)
    }
  }

  private onMessage(m: LiveMessage, ws: WebSocket) {
    switch (m.type) {
      case 'hello':
        this.attempts = 0
        this.set({ connection: 'live', writers: {} })
        if (this.pending.length) void this.flush()
        void this.comeUp(ws, m.seq !== this.seq)
        break
      case 'writing': {
        const { [m.taskId]: _was, ...others } = this.state.writers
        this.set({ writers: m.people.length ? { ...others, [m.taskId]: m.people } : others })
        break
      }
      case 'doc':
        this.tellDocs(m)
        break
      case 'changes':
        this.receive(m.seq, m.changes, m.mutationId)
        break
      case 'reload':
        void this.resync()
        break
      case 'access-lost':
        this.emit({ type: 'gone', reason: 'access-lost' })
        break
      case 'signed-out':
        this.signedOut = true
        savePending(this.boardId, this.pending)
        this.emit({ type: 'signed-out' })
        break
      case 'deleted':
        this.emit({ type: 'gone', reason: 'deleted' })
        break
      case 'comment':
      case 'attachment':
        this.bumpCount(m)
        this.activityListeners.forEach((l) => l(m))
        break
      case 'templates':
        this.templateListeners.forEach((l) => l())
        break
      case 'time':
        // The card's new total, as the server counts it.
        this.set({ counts: { ...this.state.counts, time: { ...this.state.counts.time, [m.taskId]: m.total } } })
        this.activityListeners.forEach((l) => l(m))
        break
    }
  }

  /** Keeps the card badges right as comments and files come and go. */
  private bumpCount(m: Extract<TaskActivity, { type: 'comment' | 'attachment' }>) {
    const kind = m.type === 'comment' ? 'comments' : 'attachments'
    const delta = m.action === 'added' ? 1 : m.action === 'deleted' ? -1 : 0
    if (!delta) return
    const per = { ...this.state.counts[kind] }
    per[m.taskId] = Math.max(0, (per[m.taskId] ?? 0) + delta)
    // A new comment is activity on the card (card age).
    const lastComment =
      m.type === 'comment' && delta > 0 ? { ...this.state.counts.lastComment, [m.taskId]: new Date().toISOString() } : this.state.counts.lastComment
    this.set({ counts: { ...this.state.counts, [kind]: per, lastComment } })
  }

  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch }
    if (patch.data) this.links.see(patch.data)
    this.listeners.forEach((l) => l())
  }

  private emit(e: SyncEvent) {
    this.eventListeners.forEach((l) => l(e))
  }
}
