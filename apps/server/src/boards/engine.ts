import { cutItems, describeAllChanges, type ActivityItem } from '@kanbanto/model/activity'
import { planMove, type MovePlan, type MoveTarget } from '@kanbanto/model/moveBoard'
import { applyChanges } from '@kanbanto/model/changes'
import { execute, type Command } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import type { Change } from '@kanbanto/model/records'
import { withNumbers } from '@kanbanto/model/refs'
import type { BoardData, Task } from '@kanbanto/model/types'
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import {
  attachments,
  attachmentThumbs,
  boardActivity,
  boardFieldRows,
  boards,
  comments,
  descriptionVersions,
  notifications,
  taskFollowers,
  taskMoves,
  tasks,
  timeEntries,
} from '../db/schema'
import { HttpError } from '../http'
import type { LiveHub } from '../live'
import { ACTIVITY_DAYS, logLine } from './activityLog'
import { checkLinks, followMoved, gainedLinks, withoutLinks } from './links'
import { numberBoard } from './numbering'
import { loadBoard, writeChanges } from './store'
import { SITTING_MS } from './versions'

export interface MutationResult {
  seq: number
  changes: Change[]
}

/** Boards kept in memory, and how big they may be all together (in records: tasks, archived ones too, lists, labels, people). */
const CACHE_BOARDS = 200
const CACHE_RECORDS = 200_000
const REMEMBERED_MUTATIONS = 500

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Why a card's description can't be changed just now: the people writing it. */
function beingWritten(people: { name: string }[], title: string) {
  const [first, second] = people.map((p) => p.name)
  const who = people.length === 1 ? first : people.length === 2 ? `${first} and ${second}` : `${first} and ${people.length - 1} others`
  return `${who} ${people.length === 1 ? 'is' : 'are'} writing the description of “${title}” right now, so it wasn’t changed. Try again when they have finished, or open the card and write with them.`
}

const sizeOf = (d: BoardData) =>
  Object.keys(d.tasks).length + Object.keys(d.archived ?? {}).length + d.columns.length + d.labels.length + d.members.length + d.fields.length + 1

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
  /** Boards being read from the database right now, by id and the change counter that was seen. */
  private loading = new Map<string, Promise<{ data: BoardData; seq: number } | null>>()
  private done = new Map<string, MutationResult>()
  private readonly db: Db
  private readonly hub: LiveHub

  /**
   * Told after each command that changed something (webhooks). `items`: the change in words, every line of it.
   * `autosave`: it is a description being written, saved as it goes (see `docs`): there's another every few seconds.
   */
  onChanged:
    | ((
        boardId: string,
        e: {
          board: { id: string; name: string }
          userId: string
          command: string
          seq: number
          changes: Change[]
          items: ActivityItem[]
          mutationId?: string
          autosave?: boolean
        },
      ) => void)
    | null = null

  /**
   * The descriptions people are writing together just now (boards/liveDocs.ts). `blocks`: who is writing a card's,
   * when a change to it from anywhere else has to wait for them. `sessionId`: the session a card's is written in.
   */
  docs: {
    blocks: (boardId: string, taskId: string, session?: string) => { id: string; name: string }[] | null
    sessionId: (boardId: string, taskId: string) => string | null
    took: (boardId: string, taskId: string) => string[]
  } | null = null
  /** When each person's writing of a card's description was last put in the activity log (see `firstOfSitting`). */
  private sittings = new Map<string, number>()

  /**
   * Run after each command that changed something, before its answer goes back (the board's rules, following cards
   * and telling people): what it does is there by the time the person who made the change looks. `data`: the board
   * after the change; `before`: as it was (a rule asks which cards arrived or left between the two).
   */
  afterChange:
    | ((
        boardId: string,
        e: {
          userId: string
          command: string
          changes: Change[]
          data: BoardData
          before: BoardData
          via?: string
          /** The session the command says it is saving for (a description written together). */
          session?: string
          /** It is such a save, and not the first of anyone's sitting: what was said then isn't said again. */
          again?: boolean
          /**
           * Who such a save is put down to, when not the person whose browser made it: they wrote the text, and
           * left before their own browser saved it.
           */
          by?: string
        },
      ) => Promise<void>)
    | null = null

  /**
   * Run for each of the two boards after a card moved from one to the other, which is no command (`transfer`): the
   * boards' rules only. (Followers aren't told through here: to one board it would read as a card deleted, to the
   * other as a card made.)
   */
  afterMove: ((boardId: string, e: { userId: string; changes: Change[]; data: BoardData; before: BoardData }) => Promise<void>) | null = null

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
    const loaded = await this.load(boardId, row.seq)
    if (!loaded) throw new HttpError(404, 'This board doesn’t exist.')
    return loaded
  }

  /**
   * Reads a board from the database and remembers it: once for everyone who asks while it's being read. (A field
   * renamed on a big board makes everyone who has it open ask for it at the same moment: read once each, eight people
   * waited a second and a half for what one read gives them all.) Asked again after another change, it's read again.
   */
  private load(boardId: string, seq: number) {
    const key = `${boardId}:${seq}`
    let going = this.loading.get(key)
    if (!going) {
      going = loadBoard(this.db, boardId)
        .then((loaded) => {
          if (loaded) this.remember(boardId, loaded)
          return loaded ?? null
        })
        .finally(() => this.loading.delete(key))
      this.loading.set(key, going)
    }
    return going
  }

  /** Several boards as they are now, with one look at all their change counters (boards that are gone are left out). */
  async snapshots(boardIds: string[]): Promise<Map<string, BoardData>> {
    const ids = [...new Set(boardIds)]
    const out = new Map<string, BoardData>()
    if (!ids.length) return out
    const rows = await this.db.select({ id: boards.id, seq: boards.seq }).from(boards).where(inArray(boards.id, ids))
    for (const row of rows) {
      const hit = this.cache.get(row.id)
      if (hit && hit.seq === row.seq) {
        out.set(row.id, hit.data)
        continue
      }
      const loaded = await this.load(row.id, row.seq)
      if (loaded) out.set(row.id, loaded.data)
    }
    return out
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
      const [row] = await tx
        .select({ seq: boards.seq, nextNumber: boards.nextNumber, code: boards.code })
        .from(boards)
        .where(eq(boards.id, boardId))
        .for('update')
      if (!row) throw new HttpError(404, 'This board no longer exists.')
      // A board that slipped past the numbering done at start-up (made by a server still running the version before,
      // while this one was starting) gets its letters and numbers now, before anything else happens to it.
      const healed = row.code === null ? await numberBoard(tx, boardId) : null
      if (healed) row.nextNumber = healed.nextNumber
      const hit = this.cache.get(boardId)
      const data = !healed && hit && hit.seq === row.seq ? hit.data : (await loadBoard(tx, boardId))!.data
      if (command.type === 'records.restore') await this.fieldsStillThere(tx, boardId, data, command.changes)
      let r: ReturnType<typeof execute>
      try {
        r = execute(data, command, { now: new Date().toISOString(), newId, idx: indexFor(data) })
      } catch (e) {
        throw Object.assign(new HttpError(422, 'That change couldn’t be applied to this board.'), { cause: e })
      }
      if ('error' in r) throw new HttpError(422, r.error)
      // A description people are writing together just now is theirs to save: a change to it from anywhere else
      // (another window, an assistant, an undo) would be written over by their next save without anyone seeing.
      const session = command.type === 'task.update' ? command.session : undefined
      for (const c of r.changes) {
        if (c.entity !== 'task' || !c.before || !c.after || (c.before.description ?? '') === (c.after.description ?? '')) continue
        const people = this.docs?.blocks(boardId, c.id, session)
        if (people) throw new HttpError(422, beingWritten(people, c.after.title), 'being-written')
        // Writing saved from a session that is over (its browser was away while the others finished, or the server
        // started again): the text may have been written on since, by people it never heard from. It isn't put over
        // theirs: its browser keeps it as a draft and joins the session there is now.
        if (session && this.docs && this.docs.sessionId(boardId, c.id) !== session)
          throw new HttpError(
            422,
            'That writing was going on in a session that is over, and the text may have changed since: it wasn’t saved over it.',
            'being-written',
          )
      }
      // Such writing, saved as it goes: nothing but the description, from the session the card's is written in.
      const autosave =
        command.type === 'task.update' &&
        !!session &&
        this.docs?.sessionId(boardId, command.id) === session &&
        Object.keys(command.fields).every((k) => k === 'description')
      const nothing = { seq: row.seq, changes: [], data, before: data, stripped: false, said: [], autosave, again: false, by: userId }
      if (!r.changes.length && !healed) return nothing
      // Links to cards on other boards: what this board can't check by itself (see links.ts). A new link that fails
      // is refused. An undo that would bring one back goes through without it: the rest of it is still wanted.
      let changes = r.changes
      // (Healed: every open copy reads the board again, as when a change is written differently from how it was sent.)
      let stripped = !!healed
      const gained = gainedLinks(data.fields, changes)
      if (gained.length) {
        const bad = await checkLinks(tx, boardId, userId, data.fields, gained)
        if (bad.length && command.type !== 'records.restore') throw new HttpError(422, bad[0].error)
        if (bad.length) {
          changes = withoutLinks(changes, bad)
          stripped = true
        }
      }
      // A cover is the server's to set (`setCover`), so the only one a command can bring is on a card that's coming
      // back: an undo of its delete. It keeps it when the file is still that card's; otherwise it comes back without.
      const covered = changes.filter((c) => c.entity === 'task' && !c.before && c.after?.cover)
      if (covered.length) {
        const lost = await this.coversGone(
          tx,
          boardId,
          covered.map((c) => ({ taskId: c.id, file: (c.after as Task).cover! })),
        )
        if (lost.size) {
          changes = changes.map((c) => {
            if (c.entity !== 'task' || !c.after || !lost.has(c.id)) return c
            const { cover: _gone, ...after } = c.after
            return { ...c, after }
          })
          stripped = true
        }
      }
      // Card numbers are given here, never by the command (see model/refs.ts): new cards take the next ones, and a
      // card that has one keeps it. The answer carries them, so the person's own copy has them a moment later.
      const numbered = withNumbers(data, changes, row.nextNumber)
      changes = numbered.changes
      await writeChanges(
        tx,
        boardId,
        changes,
        data.fields.map((f) => f.id),
      )
      // The activity log: what this change did, in words (reordering alone isn't logged).
      const said = describeAllChanges(data, changes, command)
      const items = cutItems(said)
      // Writing saved as it goes is one text, saved for everyone by the browser of whoever stopped typing first: the
      // line is each writer's (the people who wrote since it was last saved, still on the board), and one for a
      // sitting, not one every few seconds.
      const cardId = command.type === 'task.update' ? command.id : ''
      const wrote = autosave ? this.docs!.took(boardId, cardId).filter((id) => id === userId || data.members.some((m) => m.id === id)) : []
      const authors = wrote.length ? wrote : [userId]
      const lines = autosave ? authors.filter((id) => this.firstOfSitting(`${boardId}:${cardId}:${id}`)) : authors
      const again = autosave && !lines.length
      if (items.length)
        for (const actorId of lines)
          await tx
            .insert(boardActivity)
            .values({ id: newId(), boardId, actorId, command: command.type, items, via: actorId === userId ? (via ?? null) : null })
      const by = authors.includes(userId) ? userId : authors[0]
      const seq = row.seq + 1
      await tx
        .update(boards)
        .set({ seq, activityAt: new Date(), ...(numbered.next !== row.nextNumber && { nextNumber: numbered.next }) })
        .where(eq(boards.id, boardId))
      return { seq, changes, data: applyChanges(data, changes), before: data, stripped, said, autosave, again, by }
    })

    this.remember(boardId, { seq: result.seq, data: result.data })
    const out = { seq: result.seq, changes: result.changes }
    this.done.set(key, out)
    if (this.done.size > REMEMBERED_MUTATIONS) this.done.delete(this.done.keys().next().value!)
    // (A board numbered on the way by a command that then changed nothing: its open copies still read it again.)
    if (!out.changes.length && result.stripped) this.hub.broadcast(boardId, { type: 'reload' })
    if (out.changes.length) {
      this.hub.broadcast(boardId, { type: 'changes', ...out, mutationId })
      // (What was written isn't quite what the person's own copy did: it fetches the board again.)
      if (result.stripped) this.hub.broadcast(boardId, { type: 'reload' })
      const board = { id: boardId, name: result.data.board.name }
      this.onChanged?.(boardId, {
        board,
        userId,
        command: command.type,
        seq: out.seq,
        changes: out.changes,
        items: result.said,
        mutationId,
        autosave: result.autosave,
      })
      await this.afterChange?.(boardId, {
        userId,
        command: command.type,
        changes: out.changes,
        data: result.data,
        before: result.before,
        via,
        session: command.type === 'task.update' ? command.session : undefined,
        again: result.again,
        ...(result.by !== userId && { by: result.by }),
      })
    }
    return out
  }

  /**
   * Whether this is the first save of a person's sitting at a card's description (true once, then not again for
   * `SITTING_MS`). Kept in memory: after a restart the next save is a first one again, which is one line more.
   */
  private firstOfSitting(key: string) {
    const now = Date.now()
    const last = this.sittings.get(key)
    if (last && now - last < SITTING_MS) return false
    if (this.sittings.size > 5000) for (const [k, at] of this.sittings) if (now - at >= SITTING_MS) this.sittings.delete(k)
    this.sittings.set(key, now)
    return true
  }

  /**
   * An undo puts whole cards back as they were. One that holds a value for a field this board has nothing to do with
   * any more (not shown on it, and not kept hidden either) was made before the board's fields changed under it: the
   * field was merged into another one, or the board moved to another space and got that space's fields. Put back,
   * the card would lose what it holds for the fields it has now, so that undo is refused. (A field merely taken off
   * the board, or archived, keeps its row here: such an undo goes through, as before, without that value.)
   */
  private async fieldsStillThere(tx: Tx, boardId: string, data: BoardData, changes: Change[]) {
    const shown = new Set(data.fields.map((f) => f.id))
    const named = new Set<string>()
    for (const c of changes)
      if (c.entity === 'task' && c.after?.custom) for (const id of Object.keys(c.after.custom)) if (!shown.has(id)) named.add(id)
    if (!named.size) return
    // (A field's id is a uuid: anything else was never a field of any board.)
    const ids = [...named].filter((id) => UUID.test(id)).slice(0, 500)
    const kept = ids.length
      ? await tx
          .select({ id: boardFieldRows.fieldId })
          .from(boardFieldRows)
          .where(and(eq(boardFieldRows.boardId, boardId), inArray(boardFieldRows.fieldId, ids)))
      : []
    if (kept.length < named.size) throw new HttpError(422, 'This board’s fields changed since, so it can’t be undone.')
  }

  /**
   * Of these cards coming back with a cover, the ones whose cover can't come with them: the file isn't theirs, was
   * removed, or has no small copy. A file that went to the trash because its card was deleted (which housekeeping
   * does some hours later) comes back with the card here, since the Board is about to draw it.
   */
  private async coversGone(tx: Tx, boardId: string, cards: { taskId: string; file: string }[]) {
    const files = [...new Set(cards.map((c) => c.file))].slice(0, 2000)
    const rows = await tx
      .select({ id: attachments.id, taskId: attachments.taskId, trashed: attachments.deletedAt, orphaned: attachments.orphaned })
      .from(attachments)
      .innerJoin(attachmentThumbs, eq(attachmentThumbs.attachmentId, attachments.id))
      .where(and(eq(attachments.boardId, boardId), inArray(attachments.id, files), eq(attachments.draft, false)))
    const usable = new Map(rows.filter((r) => !r.trashed || r.orphaned).map((r) => [r.id, r]))
    const kept = cards.filter((c) => usable.get(c.file)?.taskId === c.taskId)
    const back = kept.filter((c) => usable.get(c.file)!.trashed).map((c) => c.file)
    if (back.length) await tx.update(attachments).set({ deletedAt: null, orphaned: false }).where(inArray(attachments.id, back))
    const ok = new Set(kept.map((c) => c.taskId))
    return new Set(cards.filter((c) => !ok.has(c.taskId)).map((c) => c.taskId))
  }

  /**
   * Makes one of a card's files its cover, or (`file` null) takes its cover away. Not a command: nothing a browser
   * sends sets a cover, an undo doesn't change one, and the card isn't counted as edited (its version stays, so what
   * was done to it before can still be undone). The board is locked as for a command, the file is checked there (it
   * is this card's, it isn't in the trash, and it has its small copy: see routes/covers.ts), and the change goes to
   * every open copy as any other does. Answers with the change, or with none when the cover was already that.
   * `said`: left out when the cover goes because its file did, which has its own line in the log.
   */
  async setCover(
    boardId: string,
    taskId: string,
    file: string | null,
    by: { userId: string; via?: string | null; said?: boolean },
  ): Promise<MutationResult> {
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ seq: boards.seq }).from(boards).where(eq(boards.id, boardId)).for('update')
      if (!row) throw new HttpError(404, 'This board no longer exists.')
      const hit = this.cache.get(boardId)
      const data = hit && hit.seq === row.seq ? hit.data : (await loadBoard(tx, boardId))!.data
      const card = data.tasks[taskId]
      if (!card)
        throw new HttpError(
          data.archived?.[taskId] ? 409 : 404,
          data.archived?.[taskId] ? 'An archived card can’t be changed.' : 'That card no longer exists.',
        )
      if ((card.cover ?? null) === file) return { seq: row.seq, changes: [] as Change[], data }
      let name: string | null = null
      if (file) {
        const [a] = await tx
          .select({ name: attachments.name, small: attachmentThumbs.attachmentId })
          .from(attachments)
          .leftJoin(attachmentThumbs, eq(attachmentThumbs.attachmentId, attachments.id))
          .where(
            and(
              eq(attachments.id, file),
              eq(attachments.boardId, boardId),
              eq(attachments.taskId, taskId),
              eq(attachments.draft, false),
              sql`${attachments.deletedAt} is null`,
            ),
          )
        if (!a) throw new HttpError(404, 'That file is no longer on this card.')
        // (The app sends the small copy first; see routes/covers.ts.)
        if (!a.small) throw new HttpError(409, 'This picture has no small copy yet.', 'needs-thumb')
        name = a.name
      }
      const { cover: _was, ...rest } = card
      const after: Task = file ? { ...rest, cover: file } : rest
      const changes: Change[] = [{ entity: 'task', id: taskId, before: card, after }]
      await tx
        .update(tasks)
        .set({ cover: file })
        .where(and(eq(tasks.boardId, boardId), eq(tasks.id, taskId)))
      if (by.said !== false)
        await logLine(tx, {
          boardId,
          actorId: by.userId,
          command: file ? 'cover.set' : 'cover.remove',
          via: by.via,
          item: {
            taskId,
            text: file ? `made “${name}” the cover of “${card.title}”` : `removed the cover of “${card.title}”`,
            own: file ? `made “${name}” the cover` : 'removed the cover',
          },
        })
      const seq = row.seq + 1
      await tx.update(boards).set({ seq, activityAt: new Date() }).where(eq(boards.id, boardId))
      return { seq, changes, data: applyChanges(data, changes) }
    })
    if (!result.changes.length) return { seq: result.seq, changes: [] }
    this.remember(boardId, { seq: result.seq, data: result.data })
    this.hub.broadcast(boardId, { type: 'changes', seq: result.seq, changes: result.changes })
    return { seq: result.seq, changes: result.changes }
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
      const counters = new Map<string, number>()
      for (const id of [fromId, toId].sort()) {
        const [row] = await tx.select({ seq: boards.seq, nextNumber: boards.nextNumber }).from(boards).where(eq(boards.id, id)).for('update')
        if (!row) throw new HttpError(404, 'This board no longer exists.')
        locked.set(id, row.seq)
        counters.set(id, row.nextNumber)
      }
      const load = async (id: string) => {
        const hit = this.cache.get(id)
        return hit && hit.seq === locked.get(id) ? hit.data : (await loadBoard(tx, id))!.data
      }
      const source = await load(fromId)
      const target = await load(toId)
      const planned = planMove(source, target, taskId, to, { now: new Date().toISOString(), newId })
      if ('error' in planned) throw new HttpError(422, planned.error)
      // On the board it lands on, each card takes a number of that board's (see model/refs.ts).
      const arriving = withNumbers(target, planned.target, counters.get(toId)!)
      const plan = { ...planned, target: arriving.changes }
      counters.set(toId, arriving.next)
      const ids = (d: BoardData) => d.fields.map((f) => f.id)
      await writeChanges(tx, fromId, plan.source, ids(source))
      await writeChanges(tx, toId, plan.target, ids(target))

      // Where each card went, so the number and the address it had still find it; and what led to it before leads on.
      for (const [oldId, id] of plan.ids) {
        await tx
          .update(taskMoves)
          .set({ toBoardId: toId, toTaskId: id })
          .where(and(eq(taskMoves.toBoardId, fromId), eq(taskMoves.toTaskId, oldId)))
        const went = { fromNumber: source.tasks[oldId]?.number ?? null, toBoardId: toId, toTaskId: id, movedAt: new Date() }
        await tx
          .insert(taskMoves)
          .values({ fromBoardId: fromId, fromTaskId: oldId, ...went })
          .onConflictDoUpdate({ target: [taskMoves.fromBoardId, taskMoves.fromTaskId], set: went })
      }

      // Its comments, files, mentions, followers and logged time follow it (files stay where they're stored, and count where they did).
      for (const [oldId, id] of plan.ids) {
        const at = (t: typeof comments | typeof attachments | typeof notifications | typeof descriptionVersions) =>
          and(eq(t.boardId, fromId), eq(t.taskId, oldId))
        await tx.update(comments).set({ boardId: toId, taskId: id }).where(at(comments))
        // (So do the earlier versions of its description.)
        await tx.update(descriptionVersions).set({ boardId: toId, taskId: id }).where(at(descriptionVersions))
        await tx.update(attachments).set({ boardId: toId, taskId: id }).where(at(attachments))
        // (What a rule of the board it leaves told people stays there: it was about that board's lists.)
        await tx
          .update(notifications)
          .set({ boardId: toId, taskId: id })
          .where(and(at(notifications), ne(notifications.kind, 'rule')))
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
      // (`own`: the line as the card's own history says it. On the board it arrives on, that's where its history starts.)
      const left: ActivityItem[] = [{ taskId, text: `moved ${q}${more} to another board`, own: `moved it${more} to another board` }]
      const arrived: ActivityItem[] = [
        { taskId: plan.ids.get(taskId)!, text: `moved ${q}${more} here from another board`, own: `moved it${more} here from another board` },
      ]
      await log(fromId, left)
      await log(toId, arrived)
      const bump = async (id: string) => {
        const seq = locked.get(id)! + 1
        await tx
          .update(boards)
          .set({ seq, activityAt: new Date(), nextNumber: counters.get(id)! })
          .where(eq(boards.id, id))
        return seq
      }
      return {
        plan,
        from: { seq: await bump(fromId), data: applyChanges(source, plan.source), before: source, said: left },
        to: { seq: await bump(toId), data: applyChanges(target, plan.target), before: target, said: arrived },
      }
    })

    const { plan, from, to: dest } = result
    for (const [id, side, changes] of [
      [fromId, from, plan.source],
      [toId, dest, plan.target],
    ] as const) {
      this.remember(id, side)
      this.hub.broadcast(id, { type: 'changes', seq: side.seq, changes })
      this.onChanged?.(id, {
        board: { id, name: side.data.board.name },
        userId,
        command: 'task.moveToBoard',
        seq: side.seq,
        changes,
        items: side.said,
      })
    }
    // The other board's comment and file counts changed too.
    this.hub.broadcast(toId, { type: 'reload' })
    // Each board's rules: the card left one and arrived on the other.
    await this.afterMove?.(fromId, { userId, changes: plan.source, data: from.data, before: from.before })
    await this.afterMove?.(toId, { userId, changes: plan.target, data: dest.data, before: dest.before })
    // Links to the cards that moved follow them (or go, where they can't): once the move itself is done and settled.
    const linksRemoved = await followMoved({ db: this.db, engine: this }, fromId, toId, plan.ids).catch(() => 0)
    return { id: plan.ids.get(taskId)!, summary: { ...plan.summary, linksRemoved }, board: { id: toId, name: dest.data.board.name } }
  }

  /**
   * Something about these boards is changing outside commands, in `tx` (their fields, a field's definition, values
   * taken out of their cards). Their rows are locked, one by one and always in the same order (like `transfer`), and
   * their `seq` goes up with the change itself: a command that was running finishes first, and the next one loads
   * the board afresh. Once it's committed, `reloaded` tells everyone who has them open.
   */
  async bump(tx: Tx, boardIds: string[]) {
    for (const id of [...new Set(boardIds)].sort()) {
      await tx.select({ seq: boards.seq }).from(boards).where(eq(boards.id, id)).for('update')
      await tx
        .update(boards)
        .set({ seq: sql`${boards.seq} + 1` })
        .where(eq(boards.id, id))
    }
  }

  /** After `bump` is committed: the cached copies go, and every open copy fetches the board again. */
  reloaded(boardIds: string[]) {
    for (const id of new Set(boardIds)) {
      this.drop(id)
      this.hub.broadcast(id, { type: 'reload' })
    }
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
