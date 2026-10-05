import { describeChanges, type ActivityItem } from '@kanbanto/model/activity'
import { planMove, type MovePlan, type MoveTarget } from '@kanbanto/model/moveBoard'
import { applyChanges } from '@kanbanto/model/changes'
import { execute, type Command } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import type { Change } from '@kanbanto/model/records'
import type { BoardData } from '@kanbanto/model/types'
import { and, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { attachments, boardActivity, boards, comments, notifications, taskFollowers, timeEntries } from '../db/schema'
import { HttpError } from '../http'
import type { LiveHub } from '../live'
import { ACTIVITY_DAYS } from './activityLog'
import { loadBoard, writeChanges } from './store'

export interface MutationResult {
  seq: number
  changes: Change[]
}

/** Boards kept in memory, and how big they may be all together (in records: tasks, archived ones too, lists, labels, people). */
const CACHE_BOARDS = 200
const CACHE_RECORDS = 200_000
const REMEMBERED_MUTATIONS = 500

const sizeOf = (d: BoardData) =>
  Object.keys(d.tasks).length + Object.keys(d.archived ?? {}).length + d.columns.length + d.labels.length + d.members.length + 1

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

  /** Told after each command that changed something (webhooks). */
  onChanged:
    ((boardId: string, e: { board: { id: string; name: string }; userId: string; command: string; seq: number; changes: Change[] }) => void) | null =
    null

  /**
   * Run after each command that changed something, before its answer goes back (following cards and telling people):
   * what it does is there by the time the person who made the change looks. `data`: the board after the change.
   */
  afterChange: ((boardId: string, e: { userId: string; command: string; changes: Change[]; data: BoardData }) => Promise<void>) | null = null

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
   * `via`: the app it came through (logged with the activity).
   */
  async mutate(boardId: string, mutationId: string, command: Command, userId: string, via?: string): Promise<MutationResult> {
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
      // The activity log: what this change did, in words (reordering alone isn't logged).
      const items = describeChanges(data, r.changes)
      if (items.length)
        await tx.insert(boardActivity).values({ id: newId(), boardId, actorId: userId, command: command.type, items, via: via ?? null })
      const seq = row.seq + 1
      await tx.update(boards).set({ seq, activityAt: new Date() }).where(eq(boards.id, boardId))
      return { seq, changes: r.changes, data: applyChanges(data, r.changes) }
    })

    this.remember(boardId, { seq: result.seq, data: result.data })
    const out = { seq: result.seq, changes: result.changes }
    this.done.set(key, out)
    if (this.done.size > REMEMBERED_MUTATIONS) this.done.delete(this.done.keys().next().value!)
    if (out.changes.length) {
      this.hub.broadcast(boardId, { type: 'changes', ...out, mutationId })
      const board = { id: boardId, name: result.data.board.name }
      this.onChanged?.(boardId, { board, userId, command: command.type, seq: out.seq, changes: out.changes })
      await this.afterChange?.(boardId, { userId, command: command.type, changes: out.changes, data: result.data })
    }
    return out
  }

  /**
   * Moves a task, with its subtasks, to another board (see model/moveBoard.ts): both boards change together, and its
   * comments, files and mentions go with it. Not undoable from either board (undo there would only see half of it).
   */
  async transfer(
    fromId: string,
    toId: string,
    taskId: string,
    to: MoveTarget,
    userId: string,
    via?: string,
  ): Promise<{ id: string; summary: MovePlan['summary']; board: { id: string; name: string } }> {
    const result = await this.db.transaction(async (tx) => {
      // Lock both boards, always in the same order, so two moves in opposite directions can't deadlock.
      const locked = new Map<string, number>()
      for (const id of [fromId, toId].sort()) {
        const [row] = await tx.select({ seq: boards.seq }).from(boards).where(eq(boards.id, id)).for('update')
        if (!row) throw new HttpError(404, 'This board no longer exists.')
        locked.set(id, row.seq)
      }
      const load = async (id: string) => {
        const hit = this.cache.get(id)
        return hit && hit.seq === locked.get(id) ? hit.data : (await loadBoard(tx, id))!.data
      }
      const source = await load(fromId)
      const target = await load(toId)
      const plan = planMove(source, target, taskId, to, { now: new Date().toISOString(), newId })
      if ('error' in plan) throw new HttpError(422, plan.error)
      await writeChanges(tx, fromId, plan.source)
      await writeChanges(tx, toId, plan.target)

      // Its comments, files, mentions, followers and logged time follow it (files stay where they're stored, and count where they did).
      for (const [oldId, id] of plan.ids) {
        const at = (t: typeof comments | typeof attachments | typeof notifications) => and(eq(t.boardId, fromId), eq(t.taskId, oldId))
        await tx.update(comments).set({ boardId: toId, taskId: id }).where(at(comments))
        await tx.update(attachments).set({ boardId: toId, taskId: id }).where(at(attachments))
        await tx.update(notifications).set({ boardId: toId, taskId: id }).where(at(notifications))
        // Its followers too, the ones who can open the board it went to (the bell checks that when it's read).
        await tx
          .update(taskFollowers)
          .set({ boardId: toId, taskId: id })
          .where(and(eq(taskFollowers.boardId, fromId), eq(taskFollowers.taskId, oldId)))
        await tx
          .update(timeEntries)
          .set({ boardId: toId, taskId: id })
          .where(and(eq(timeEntries.boardId, fromId), eq(timeEntries.taskId, oldId)))
      }

      // (Neither board's log names the other: people on one may not know the other exists.)
      const more = plan.summary.subtasks ? ` with ${plan.summary.subtasks} subtask${plan.summary.subtasks === 1 ? '' : 's'}` : ''
      const q = `“${plan.summary.title}”`
      const log = (boardId: string, items: ActivityItem[]) =>
        tx.insert(boardActivity).values({ id: newId(), boardId, actorId: userId, command: 'task.moveToBoard', items, via: via ?? null })
      await log(fromId, [{ taskId, text: `moved ${q}${more} to another board` }])
      await log(toId, [{ taskId: plan.ids.get(taskId)!, text: `moved ${q}${more} here from another board` }])
      const bump = async (id: string) => {
        const seq = locked.get(id)! + 1
        await tx.update(boards).set({ seq, activityAt: new Date() }).where(eq(boards.id, id))
        return seq
      }
      return {
        plan,
        from: { seq: await bump(fromId), data: applyChanges(source, plan.source) },
        to: { seq: await bump(toId), data: applyChanges(target, plan.target) },
      }
    })

    const { plan, from, to: dest } = result
    for (const [id, side, changes] of [
      [fromId, from, plan.source],
      [toId, dest, plan.target],
    ] as const) {
      this.remember(id, side)
      this.hub.broadcast(id, { type: 'changes', seq: side.seq, changes })
      this.onChanged?.(id, { board: { id, name: side.data.board.name }, userId, command: 'task.moveToBoard', seq: side.seq, changes })
    }
    // The other board's comment and file counts changed too.
    this.hub.broadcast(toId, { type: 'reload' })
    return { id: plan.ids.get(taskId)!, summary: plan.summary, board: { id: toId, name: dest.data.board.name } }
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

/** The activity log is kept ACTIVITY_DAYS days: older lines are removed. */
export async function pruneActivity(db: Db) {
  await db.delete(boardActivity).where(lt(boardActivity.at, new Date(Date.now() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000)))
}
