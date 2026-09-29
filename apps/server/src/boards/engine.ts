import { applyChanges } from '@kanbanto/model/changes'
import { execute, type Command } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import type { Change } from '@kanbanto/model/records'
import type { BoardData } from '@kanbanto/model/types'
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { boards } from '../db/schema'
import { HttpError } from '../http'
import type { LiveHub } from '../live'
import { loadBoard, writeChanges } from './store'

export interface MutationResult {
  seq: number
  changes: Change[]
}

/** Boards kept in memory, and how big they may be all together (in records: tasks, lists, labels, people). */
const CACHE_BOARDS = 200
const CACHE_RECORDS = 200_000
const REMEMBERED_MUTATIONS = 500

const sizeOf = (d: BoardData) => Object.keys(d.tasks).length + d.columns.length + d.labels.length + d.members.length + 1

/**
 * Runs commands against boards: the same `execute` the app runs, but here it's the one that counts.
 * Writes to one board happen one at a time (the board row is locked), each gets the next `seq`, and
 * everyone with the board open is sent the changes.
 *
 * Boards are kept in memory between commands (checked against `seq`, so a change made some other way
 * just means a reload). Retried requests (same mutation id) get the first answer back instead of running twice.
 */
export class BoardEngine {
  private cache = new Map<string, { seq: number; data: BoardData; size: number }>()
  private cached = 0
  private done = new Map<string, MutationResult>()
  private readonly db: Db
  private readonly hub: LiveHub

  constructor(db: Db, hub: LiveHub) {
    this.db = db
    this.hub = hub
  }

  /** The board as it is now. */
  async snapshot(boardId: string): Promise<{ data: BoardData; seq: number }> {
    const [row] = await this.db.select({ seq: boards.seq }).from(boards).where(eq(boards.id, boardId))
    if (!row) throw new HttpError(404, 'This board doesn’t exist.')
    const hit = this.cache.get(boardId)
    if (hit && hit.seq === row.seq) return { data: hit.data, seq: hit.seq }
    const loaded = await loadBoard(this.db, boardId)
    if (!loaded) throw new HttpError(404, 'This board doesn’t exist.')
    this.remember(boardId, loaded)
    return loaded
  }

  /**
   * Runs `command` for `userId`. A retry (same mutation id from the same person) gets the first answer back. A command
   * that trips over something unexpected is refused like any other (422), so the app doesn't retry it forever.
   */
  async mutate(boardId: string, mutationId: string, command: Command, userId: string): Promise<MutationResult> {
    const key = `${boardId}:${userId}:${mutationId}`
    const prior = this.done.get(key)
    if (prior) return prior

    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ seq: boards.seq }).from(boards).where(eq(boards.id, boardId)).for('update')
      if (!row) throw new HttpError(404, 'This board no longer exists.')
      const hit = this.cache.get(boardId)
      const data = hit && hit.seq === row.seq ? hit.data : (await loadBoard(tx, boardId))!.data
      let r: ReturnType<typeof execute>
      try {
        r = execute(data, command, { now: new Date().toISOString(), newId, idx: indexFor(data) })
      } catch (e) {
        throw Object.assign(new HttpError(422, 'That change couldn’t be applied to this board.'), { cause: e })
      }
      if ('error' in r) throw new HttpError(422, r.error)
      if (!r.changes.length) return { seq: row.seq, changes: [], data }
      await writeChanges(tx, boardId, r.changes)
      const seq = row.seq + 1
      await tx.update(boards).set({ seq, activityAt: new Date() }).where(eq(boards.id, boardId))
      return { seq, changes: r.changes, data: applyChanges(data, r.changes) }
    })

    this.remember(boardId, { seq: result.seq, data: result.data })
    const out = { seq: result.seq, changes: result.changes }
    this.done.set(key, out)
    if (this.done.size > REMEMBERED_MUTATIONS) this.done.delete(this.done.keys().next().value!)
    if (out.changes.length) this.hub.broadcast(boardId, { type: 'changes', ...out, mutationId })
    return out
  }

  /** Something changed outside commands (people, a new board): bump `seq` so every cached copy is refreshed. */
  async touch(boardId: string) {
    this.drop(boardId)
    await this.db
      .update(boards)
      .set({ seq: sql`${boards.seq} + 1`, activityAt: new Date() })
      .where(eq(boards.id, boardId))
  }

  forget(boardId: string) {
    this.drop(boardId)
  }

  private drop(boardId: string) {
    const hit = this.cache.get(boardId)
    if (!hit) return
    this.cached -= hit.size
    this.cache.delete(boardId)
  }

  /** Keeps the most recently used boards, within both limits (a Map iterates oldest first). */
  private remember(boardId: string, entry: { seq: number; data: BoardData }) {
    this.drop(boardId)
    const size = sizeOf(entry.data)
    this.cache.set(boardId, { ...entry, size })
    this.cached += size
    while (this.cache.size > 1 && (this.cache.size > CACHE_BOARDS || this.cached > CACHE_RECORDS)) this.drop(this.cache.keys().next().value!)
  }
}
