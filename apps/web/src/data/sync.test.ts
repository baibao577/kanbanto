import type { BoardSnapshot, MutationResult } from '@kanbanto/model/api'
import { applyChanges, invertChanges } from '@kanbanto/model/changes'
import { execute, type Command } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import { exampleData } from '@kanbanto/model/sample'
import type { BoardData } from '@kanbanto/model/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardSync, type SyncEvent } from './sync'

/**
 * BoardSync against a pretend server: `fetch` answers from a script, and the live connection is a stand-in that's
 * open at once (the browser globals the class uses don't exist in Node).
 */
class FakeSocket {
  static OPEN = 1
  readyState = 1
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  close() {
    this.readyState = 3
  }
}

type Answer = { status: number; body?: unknown } | 'offline'
let answers: Answer[]
let server: BoardData
let seq: number
let sent: { mutationId: string; command: Command }[]

/** The server's side of a mutation: runs it on its copy (like the real one) unless the script says otherwise. */
function mutationAnswer(body: { mutationId: string; command: Command }): { status: number; body: unknown } {
  const r = execute(server, body.command, { now: new Date().toISOString(), newId, idx: indexFor(server) })
  if ('error' in r) return { status: 422, body: { error: r.error } }
  server = applyChanges(server, r.changes)
  seq += 1
  return { status: 200, body: { seq, changes: r.changes } satisfies MutationResult }
}

const storage = new Map<string, string>()

beforeEach(() => {
  server = exampleData('b1', 'u1')
  seq = 1
  answers = []
  sent = []
  storage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'kanbanto.test' })
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body?: string }) => {
      if (url.endsWith('/mutations')) {
        const body = JSON.parse(init.body!)
        sent.push(body)
        const scripted = answers.shift()
        if (scripted === 'offline') throw new TypeError('Failed to fetch')
        const a = scripted ?? mutationAnswer(body)
        return new Response(JSON.stringify(a.body ?? {}), { status: a.status })
      }
      // Fetching the board again.
      return new Response(JSON.stringify(snapshot()), { status: 200 })
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// (Like the real server: the board comes without its archived cards.)
const onBoard = ({ archived: _putAway, ...data }: BoardData): BoardData => data
const snapshot = (): BoardSnapshot => ({
  data: onBoard(server),
  seq,
  access: { role: 'editor', via: 'member', visibility: 'invited', publicLink: false, workspace: null, archivedAt: null, inbox: false },
  counts: { comments: {}, attachments: {}, lastComment: {}, time: {} },
  canComment: true,
})

function open() {
  const sync = new BoardSync('b1', snapshot())
  const events: SyncEvent[] = []
  sync.onEvent((e) => events.push(e))
  // The live connection says hello, so the board counts as live.
  const socket = (sync as unknown as { socket: FakeSocket }).socket
  socket.onmessage?.({ data: JSON.stringify({ type: 'hello', seq }) })
  return { sync, events }
}

const rename = (title: string): Command => ({ type: 'task.update', id: 'A', fields: { title } })
const settle = () => vi.advanceTimersByTimeAsync(60_000)

describe('BoardSync', () => {
  it('shows a change at once and saves it', async () => {
    const { sync } = open()
    sync.run(rename('Launch v2'))
    expect(sync.getState().data.tasks.A.title).toBe('Launch v2')
    await settle()
    expect(server.tasks.A.title).toBe('Launch v2')
    expect(sync.getState().unsaved).toBe(0)
  })

  it('keeps a change while the server can’t be reached, and clears “Offline” once saving works again', async () => {
    const { sync } = open()
    answers.push('offline', 'offline')
    sync.run(rename('Offline edit'))
    await vi.advanceTimersByTimeAsync(10)
    expect(sync.getState().connection).toBe('offline')
    await settle()
    expect(server.tasks.A.title).toBe('Offline edit')
    expect(sync.getState().connection).toBe('live')
  })

  it('gives up on a change the server keeps failing on, instead of holding up everything after it', async () => {
    const { sync, events } = open()
    answers.push(...Array(5).fill({ status: 500, body: { error: 'Something went wrong on our side.' } }))
    sync.run(rename('Broken'))
    sync.run(rename('After it'))
    await settle()
    expect(events).toContainEqual(expect.objectContaining({ type: 'refused', message: expect.stringMatching(/problem on the server/) }))
    expect(server.tasks.A.title).toBe('After it')
    expect(sync.getState().unsaved).toBe(0)
  })

  it('undo is a command too: a deleted task comes back, on the server as well', async () => {
    const { sync } = open()
    const del = sync.run({ type: 'task.delete', id: 'A3' })
    await settle()
    expect(server.tasks.A3).toBeUndefined()
    if ('error' in del) throw new Error(del.error)
    const inverse = invertChanges(sync.getState().data, del.changes, new Date().toISOString())
    sync.run({ type: 'records.restore', changes: inverse })
    expect(sync.getState().data.tasks.A3?.title).toBe('Deploy')
    await settle()
    expect(server.tasks.A3?.title).toBe('Deploy')
  })

  it('a refused change is taken back, and you’re told why', async () => {
    const { sync, events } = open()
    answers.push({ status: 422, body: { error: 'Someone changed this in the meantime.' } })
    const before = sync.getState().data.tasks.A.title
    sync.run(rename('Mine'))
    await settle()
    expect(sync.getState().data.tasks.A.title).toBe(before)
    expect(events).toContainEqual({ type: 'refused', message: 'Someone changed this in the meantime.' })
  })

  it('signed out: unsaved changes wait in the tab and are sent after signing in again', async () => {
    const first = open()
    answers.push({ status: 401, body: { error: 'Please sign in.' } })
    first.sync.run(rename('Written before the session ended'))
    await settle()
    expect(first.events).toContainEqual({ type: 'signed-out' })
    expect(server.tasks.A.title).not.toBe('Written before the session ended')
    first.sync.close()
    // Signed in again: the board opens anew, and the waiting change goes out.
    const again = open()
    expect(again.sync.getState().data.tasks.A.title).toBe('Written before the session ended')
    await settle()
    expect(server.tasks.A.title).toBe('Written before the session ended')
    expect(storage.size).toBe(0)
  })

  it('archived cards come apart from the board: once fetched, one can be restored, and they stay through a refetch', async () => {
    // Archived before the board was opened: "Design", with its two subtasks.
    const put = execute(server, { type: 'task.archive', id: 'A2' }, { now: new Date().toISOString(), newId, idx: indexFor(server) })
    if ('error' in put) throw new Error(put.error)
    server = applyChanges(server, put.changes)
    const { sync } = open()
    expect(sync.getState().data.archived).toBeUndefined()
    expect(sync.run({ type: 'task.restore', id: 'A2' })).toEqual({ error: 'That task isn’t archived.' })

    sync.learnArchived(Object.values(server.archived!))
    expect(Object.keys(sync.getState().data.archived!).sort()).toEqual(['A2', 'A2a', 'A2b'])
    // Fetching the board again (a missed change, say) doesn't lose them.
    await sync.resync()
    expect(Object.keys(sync.getState().data.archived!).sort()).toEqual(['A2', 'A2a', 'A2b'])

    expect('changes' in sync.run({ type: 'task.restore', id: 'A2' })).toBe(true)
    expect(sync.getState().data.tasks.A2a.parentId).toBe('A2')
    await settle()
    expect(server.tasks.A2).toBeDefined()
    expect(sync.getState().data.archived).toEqual({})
    // What's back on the board isn't taken for archived again, whatever an old answer says.
    sync.learnArchived(put.changes.map((c) => c.after as BoardData['tasks'][string]))
    expect(sync.getState().data.archived).toEqual({})
  })

  it('archiving a done list’s older cards is one change, and undo brings them all back', async () => {
    const { sync } = open()
    const done = server.columns.find((c) => c.category === 'done')!.id
    for (const title of ['Shipped', 'Also shipped']) sync.run({ type: 'task.create', parentId: null, fields: { title, status: done } })
    await settle()
    const before = Object.keys(sync.getState().data.tasks).length
    const r = sync.run({ type: 'tasks.archiveDone', status: done, before: new Date(Date.now() + 1000).toISOString() })
    if ('error' in r) throw new Error(r.error)
    expect(r.changes).toHaveLength(2)
    expect(Object.keys(sync.getState().data.tasks)).toHaveLength(before - 2)
    await settle()
    expect(Object.keys(server.archived!)).toHaveLength(2)
    // Undo, the way the app does it: the same records put back.
    const undo = sync.run({ type: 'records.restore', changes: invertChanges(sync.getState().data, r.changes, new Date().toISOString()) })
    expect('changes' in undo).toBe(true)
    await settle()
    expect(Object.keys(server.tasks)).toHaveLength(before)
    expect(server.archived).toEqual({})
  })
})
