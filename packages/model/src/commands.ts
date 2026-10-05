import { normalizeTaskDate } from './dates'
import { applyChanges, current } from './changes'
import { patchCustom, tidyCustom, type FieldDef, type FieldValue } from './fields'
import { buildIndex, descendantsOf, isLeaf, statusCol, wouldCycle, type TaskIndex } from './indexer'
import { comparePositions, positionBetween, positionsBetween } from './position'
import { stamp, type Change } from './records'
import type { Board, BoardData, Category, LabelDef, Priority, Reminder, StatusColumn, Task } from './types'
import type { ColorName } from './colors'

/**
 * Every change to board data is one of these. The UI never edits records directly: it sends a command,
 * `execute` checks it against the rules and returns the exact records that change.
 */
export type Command =
  | { type: 'task.create'; id?: string; parentId: string | null; fields: TaskFields & { title: string }; rankAfter?: string }
  | { type: 'task.update'; id: string; fields: TaskFields }
  | {
      type: 'task.move'
      id: string
      /** New parent (null = top level). Omit to keep the parent. */
      parentId?: string | null
      /** Place among its siblings in the outline. Omit: the end (only when the parent changes). */
      place?: Place
      status?: string
      /** null = unassign. Omit to leave as is. */
      assigneeId?: string | null
      /** The board list it was dropped into, in its new order (ids, including this task). */
      list?: string[]
    }
  | {
      type: 'tasks.moveToList'
      ids: string[]
      status: string
      assigneeId?: string | null
      /** The target list in its new order. Omit to drop the moved tasks' board positions (outline order). */
      list?: string[]
    }
  /** Deletes a task and its subtasks (an archived one too: that's for good). */
  | { type: 'task.delete'; id: string }
  /**
   * Puts a task and its subtasks away: out of every view and count, kept with their comments and files. `complete`:
   * finish it first (it and its unfinished subtasks go to the first done list), so it's archived as completed.
   */
  | { type: 'task.archive'; id: string; complete?: boolean }
  /**
   * Tidies a done list: archives its top-level cards that got done before `before` (a moment), each with its subtasks
   * (see `doneBefore`). A finished card under another card stays: it goes with that card, once that one is done.
   */
  | { type: 'tasks.archiveDone'; status: string; before: string }
  /** Brings an archived task (and its subtasks) back, where it was if it still can be. */
  | { type: 'task.restore'; id: string }
  /** Clears one of the board's fields on every card on the board (archived cards keep theirs). */
  | { type: 'tasks.clearField'; fieldId: string }
  | { type: 'column.create'; id?: string; name: string; category: Category }
  | { type: 'column.update'; id: string; fields: { name?: string; category?: Category; color?: ColorName | null } }
  | { type: 'column.move'; id: string; beforeId?: string }
  | { type: 'column.delete'; id: string; moveTo: string }
  | { type: 'label.create'; id?: string; name: string; color: ColorName }
  | { type: 'label.update'; id: string; fields: { name?: string; color?: ColorName } }
  | { type: 'label.delete'; id: string }
  | { type: 'board.update'; fields: { name?: string; mode?: Board['mode']; background?: Board['background'] | null; description?: string } }
  /**
   * Puts records back the way they were (undo/redo). Each change says what the record should become
   * (`after`) and what it's expected to be now (`before`): if someone changed it since, the restore is refused.
   */
  | { type: 'records.restore'; changes: Change[] }

/** Task fields a command may set. Structure (parent, positions) only changes through `task.move`. */
export type TaskFields = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'start' | 'due' | 'labels' | 'blockedBy'> & {
    assigneeId: string | null
    priority: Priority | null
    /** Replaces the task's reminders ([] removes them all). */
    reminders: Reminder[]
    color: ColorName | null
    /** Its values for the board's fields, by field id: sets the ones named (null clears one), leaves the others. */
    custom: Record<string, FieldValue | null>
  }
>

/** Where to put a task among its siblings. */
export type Place = { before: string } | { after: string } | { end: true }

export interface Context {
  /** ISO timestamp for createdAt / updatedAt. */
  now: string
  newId: () => string
  /** The board's index (parents, derived status), for rules that need the tree. */
  idx: TaskIndex
}

export type Result = { changes: Change[] } | { error: string }

/** Runs a command against the board. Returns the changes, or why it isn't allowed. */
export function execute(data: BoardData, cmd: Command, ctx: Context): Result {
  try {
    return { changes: run(data, cmd, ctx) }
  } catch (e) {
    if (e instanceof Rejected) return { error: e.message }
    throw e
  }
}

class Rejected extends Error {}
const reject = (message: string): never => {
  throw new Rejected(message)
}

function run(data: BoardData, cmd: Command, ctx: Context): Change[] {
  const { now } = ctx
  const out: Change[] = []
  const task = (id: string) => data.tasks[id] ?? reject('That task no longer exists.')
  // When it got done: set on entering a done list, kept while it stays in one, gone once it leaves.
  const putTask = (before: Task | null, { doneAt, ...next }: Omit<Task, 'createdAt' | 'updatedAt' | 'version'>) => {
    const done = data.columns.some((c) => c.id === next.status && c.category === 'done')
    out.push({
      entity: 'task',
      id: next.id,
      before,
      after: stamp(before, { ...next, activeAt: activeAt(before, next, now), ...((done || next.archivedDone) && { doneAt: doneAt ?? now }) }, now),
    })
  }
  // Putting a task away: it keeps the list it was in and whether that was finished, for good; a finished one keeps
  // when it got done too (a parent that follows its subtasks has no moment of its own: the index has it).
  const putAway = (id: string, t: Task, col: StatusColumn) => {
    const was = ctx.idx.category.get(id) === 'done' ? ctx.idx.doneAt.get(id) : undefined
    putTask(data.tasks[id], {
      ...t,
      ...(!t.doneAt && was !== undefined && { doneAt: new Date(was).toISOString() }),
      archivedAt: now,
      archivedList: col.name,
      archivedDone: col.category === 'done',
    })
  }

  switch (cmd.type) {
    case 'task.create': {
      const id = cmd.id ?? ctx.newId()
      if (data.tasks[id]) reject('A task with that id already exists.')
      if (cmd.parentId && !data.tasks[cmd.parentId]) reject('The parent task no longer exists.')
      const fields = cleanFields(data, id, { status: ctx.idx.firstOf.todo, ...cmd.fields })
      const order = positionBetween(lastSibling(data, cmd.parentId, id)?.order, null)
      const after = cmd.rankAfter ? data.tasks[cmd.rankAfter]?.rank : undefined
      putTask(null, {
        id,
        parentId: cmd.parentId,
        order,
        labels: [],
        blockedBy: [],
        ...fields,
        title: fields.title!,
        status: fields.status!,
        ...(after ? { rank: positionBetween(after, null) } : {}),
      })
      break
    }

    case 'task.update': {
      const t = task(cmd.id)
      const fields = cleanFields(data, t.id, cmd.fields)
      if (fields.status && fields.status !== t.status) guardParentStatus(data, ctx, t)
      putTask(t, { ...t, ...fields })
      break
    }

    case 'task.move': {
      const t = task(cmd.id)
      const next: Task = { ...t }
      if (cmd.status !== undefined && cmd.status !== t.status) {
        if (!data.columns.some((c) => c.id === cmd.status)) reject('That list no longer exists.')
        guardParentStatus(data, ctx, t)
        next.status = cmd.status
      }
      if (cmd.assigneeId !== undefined) next.assigneeId = memberOrUndefined(data, cmd.assigneeId)
      const parentChanges = cmd.parentId !== undefined && cmd.parentId !== t.parentId
      if (parentChanges) {
        if (cmd.parentId && !data.tasks[cmd.parentId]) reject('The new parent no longer exists.')
        if (wouldCycle(data.tasks, t.id, cmd.parentId!)) reject('A task can’t go inside one of its own subtasks.')
        next.parentId = cmd.parentId!
      }
      if (parentChanges || cmd.place) next.order = orderAt(data, t.id, next.parentId, cmd.place ?? { end: true })
      const ranks = cmd.list ? listRanks(data, cmd.list, new Set([t.id])) : {}
      if (ranks[t.id] !== undefined) next.rank = ranks[t.id]
      putTask(t, next)
      for (const [id, rank] of Object.entries(ranks)) if (id !== t.id) putTask(data.tasks[id], { ...data.tasks[id], rank })
      break
    }

    case 'tasks.moveToList': {
      if (!data.columns.some((c) => c.id === cmd.status)) reject('That list no longer exists.')
      const ids = cmd.ids.filter((id) => data.tasks[id])
      for (const id of ids) if (data.tasks[id].status !== cmd.status) guardParentStatus(data, ctx, data.tasks[id])
      const ranks = cmd.list ? listRanks(data, cmd.list, new Set(ids)) : {}
      for (const id of ids) {
        const t = data.tasks[id]
        const next: Task = { ...t, status: cmd.status, rank: cmd.list ? (ranks[id] ?? t.rank) : undefined }
        if (cmd.assigneeId !== undefined) next.assigneeId = memberOrUndefined(data, cmd.assigneeId)
        putTask(t, next)
      }
      for (const [id, rank] of Object.entries(ranks)) if (!ids.includes(id)) putTask(data.tasks[id], { ...data.tasks[id], rank })
      break
    }

    case 'task.archive': {
      const t = task(cmd.id)
      const ids = [t.id, ...subtree(data.tasks, t.id)]
      let tasks = data.tasks
      let idx = ctx.idx
      if (cmd.complete) {
        if (!data.columns.some((c) => c.category === 'done')) reject('This board has no list for finished work.')
        // Unfinished tasks go to the first done list (in "decided by subtasks" boards, only tasks without subtasks:
        // their parents follow).
        tasks = { ...data.tasks }
        for (const id of ids)
          if (ctx.idx.category.get(id) !== 'done' && (data.board.mode === 'manual' || isLeaf(ctx.idx, id)))
            tasks[id] = { ...tasks[id], status: ctx.idx.firstOf.done }
        idx = buildIndex(tasks, data.board.mode, data.columns, data.members, data.fields)
      }
      for (const id of ids) putAway(id, tasks[id], statusCol(idx, id))
      break
    }

    case 'tasks.archiveDone': {
      const col = data.columns.find((c) => c.id === cmd.status) ?? reject('That list no longer exists.')
      if (col.category !== 'done') reject('Only a list for finished work can be tidied this way.')
      const before = Date.parse(cmd.before)
      if (Number.isNaN(before)) reject('That isn’t a date.')
      for (const top of doneBefore(ctx.idx, col.id, before))
        for (const id of [top, ...descendantsOf(ctx.idx, top)]) putAway(id, data.tasks[id], statusCol(ctx.idx, id))
      break
    }

    case 'task.restore': {
      const archived = data.archived ?? {}
      const t = archived[cmd.id] ?? reject('That task isn’t archived.')
      const ids = [t.id, ...subtree(archived, t.id)]
      const back = new Set(ids)
      const labels = new Set(data.labels.map((l) => l.id))
      for (const id of ids) {
        const { archivedAt: _gone, archivedList: _list, archivedDone: done, ...a } = archived[id]
        const root = id === t.id
        // Its parent may have gone (or been archived) since: then it comes back at the top level, at the end.
        const parentId = root ? (a.parentId && data.tasks[a.parentId] ? a.parentId : null) : a.parentId
        const next: Task = {
          ...a,
          parentId,
          order: root && parentId !== a.parentId ? positionBetween(lastSibling(data, parentId, id)?.order, null) : a.order,
          // Its list may have gone: then the first list of the kind it was archived from (finished or not).
          status: data.columns.some((c) => c.id === a.status) ? a.status : ctx.idx.firstOf[done ? 'done' : 'todo'],
          labels: a.labels.filter((l) => labels.has(l)),
          blockedBy: a.blockedBy.filter((b) => data.tasks[b] || back.has(b)),
        }
        if (next.assigneeId && !data.members.some((m) => m.id === next.assigneeId)) delete next.assigneeId
        putTask(
          archived[id],
          withFields(next, data.fields, (u) => data.members.some((m) => m.id === u)),
        )
      }
      break
    }

    case 'task.delete': {
      // Deleting an archived task is for good: it and its subtasks.
      const gone_ = data.archived?.[cmd.id]
      if (gone_) {
        for (const id of [gone_.id, ...subtree(data.archived!, gone_.id)]) out.push({ entity: 'task', id, before: data.archived![id], after: null })
        break
      }
      const t = task(cmd.id)
      // The task and everything under it; "waiting on" links to them go too.
      const gone = new Set([t.id])
      const stack = [t.id]
      while (stack.length) {
        for (const c of ctx.idx.childrenOf.get(stack.pop()!) ?? []) {
          if (gone.has(c)) continue
          gone.add(c)
          stack.push(c)
        }
      }
      for (const id of gone) out.push({ entity: 'task', id, before: data.tasks[id], after: null })
      for (const other of Object.values(data.tasks))
        if (!gone.has(other.id) && other.blockedBy.some((b) => gone.has(b)))
          putTask(other, { ...other, blockedBy: other.blockedBy.filter((b) => !gone.has(b)) })
      break
    }

    case 'column.create': {
      const id = cmd.id ?? ctx.newId()
      const name = cmd.name.trim() || reject('A list needs a name.')
      const position = positionBetween(data.columns.at(-1)?.position, null)
      const col: Omit<StatusColumn, 'createdAt' | 'updatedAt' | 'version'> = { id, name, category: cmd.category, position }
      out.push({ entity: 'column', id, before: null, after: stamp(null, col, now) })
      break
    }

    case 'column.update': {
      const c = data.columns.find((x) => x.id === cmd.id) ?? reject('That list no longer exists.')
      const next: StatusColumn = { ...c }
      if (cmd.fields.name !== undefined) next.name = cmd.fields.name.trim() || reject('A list needs a name.')
      if (cmd.fields.category) next.category = cmd.fields.category
      if (cmd.fields.color !== undefined) next.color = cmd.fields.color ?? undefined
      out.push({ entity: 'column', id: c.id, before: c, after: stamp(c, next, now) })
      break
    }

    case 'column.move': {
      const c = data.columns.find((x) => x.id === cmd.id) ?? reject('That list no longer exists.')
      const rest = data.columns.filter((x) => x.id !== c.id)
      const at = cmd.beforeId ? rest.findIndex((x) => x.id === cmd.beforeId) : -1
      const [prev, next] = at === -1 ? [rest.at(-1), undefined] : [rest[at - 1], rest[at]]
      const position = positionBetween(prev?.position, next?.position)
      out.push({ entity: 'column', id: c.id, before: c, after: stamp(c, { ...c, position }, now) })
      break
    }

    case 'column.delete': {
      const c = data.columns.find((x) => x.id === cmd.id) ?? reject('That list no longer exists.')
      if (data.columns.length < 2) reject('A board needs at least one list.')
      if (cmd.moveTo === c.id || !data.columns.some((x) => x.id === cmd.moveTo)) reject('Choose another list for its cards.')
      for (const t of Object.values(data.tasks)) if (t.status === c.id) putTask(t, { ...t, status: cmd.moveTo })
      out.push({ entity: 'column', id: c.id, before: c, after: null })
      break
    }

    case 'label.create': {
      const id = cmd.id ?? ctx.newId()
      const label: Omit<LabelDef, 'createdAt' | 'updatedAt' | 'version'> = { id, name: cmd.name.trim(), color: cmd.color }
      out.push({ entity: 'label', id, before: null, after: stamp(null, label, now) })
      break
    }

    case 'label.update': {
      const l = data.labels.find((x) => x.id === cmd.id) ?? reject('That label no longer exists.')
      const next = { ...l, ...cmd.fields, ...(cmd.fields.name !== undefined ? { name: cmd.fields.name.trim() } : {}) }
      out.push({ entity: 'label', id: l.id, before: l, after: stamp(l, next, now) })
      break
    }

    case 'label.delete': {
      const l = data.labels.find((x) => x.id === cmd.id) ?? reject('That label no longer exists.')
      for (const t of Object.values(data.tasks)) if (t.labels.includes(l.id)) putTask(t, { ...t, labels: t.labels.filter((x) => x !== l.id) })
      out.push({ entity: 'label', id: l.id, before: l, after: null })
      break
    }

    case 'tasks.clearField': {
      const field = data.fields.find((f) => f.id === cmd.fieldId) ?? reject('That field is no longer on this board.')
      for (const t of Object.values(data.tasks)) {
        if (t.custom?.[field.id] === undefined) continue
        const { [field.id]: _gone, ...left } = t.custom
        const { custom: _held, ...rest } = t
        // (Not through putTask: clearing a field everywhere isn't work on each card, so their age stays as it was.)
        out.push({ entity: 'task', id: t.id, before: t, after: stamp(t, Object.keys(left).length ? { ...rest, custom: left } : rest, now) })
      }
      break
    }

    case 'board.update': {
      const b = data.board
      const next: Board = { ...b }
      if (cmd.fields.name !== undefined) next.name = cmd.fields.name.trim() || reject('A board needs a name.')
      if (cmd.fields.mode) next.mode = cmd.fields.mode
      if (cmd.fields.background !== undefined) next.background = cmd.fields.background ?? undefined
      if (cmd.fields.description !== undefined) next.description = cmd.fields.description.trim() || undefined
      // Nothing different (e.g. the name field lost focus unchanged): not a change.
      if (next.name === b.name && next.mode === b.mode && next.background === b.background && next.description === b.description) break
      out.push({ entity: 'board', id: b.id, before: b, after: stamp(b, next, now) })
      break
    }

    case 'records.restore':
      out.push(...restore(data, cmd.changes, now))
      break
  }
  return out
}

/**
 * The changes that put records back, checked so the board stays whole: parents, lists and labels that
 * the restored records point at must exist, and nothing may be left pointing at a record that's removed.
 */
function restore(data: BoardData, changes: Change[], now: string): Change[] {
  const out: Change[] = []
  for (const c of changes) {
    if (c.entity === 'member') reject('People can’t be changed here.')
    if (c.entity === 'board' && (c.id !== data.board.id || !c.after)) reject('That isn’t this board.')
    const cur = current(data, c.entity, c.id)
    if ((cur?.version ?? null) !== (c.before?.version ?? null)) reject('Someone changed this in the meantime, so it can’t be undone.')
    // A record that's gone keeps the version it's given (the undo already counted the restore as a new version).
    const after = c.after && { ...c.after, id: c.id, updatedAt: now, version: cur ? cur.version + 1 : c.after.version }
    out.push({ entity: c.entity, id: c.id, before: cur, after } as Change)
  }
  const next = applyChanges(data, out)
  const columns = new Set(next.columns.map((x) => x.id))
  const labels = new Set(next.labels.map((x) => x.id))
  const members = new Set(next.members.map((x) => x.id))
  if (!columns.size) reject('A board needs at least one list.')
  for (const [i, c] of out.entries()) {
    if (c.entity !== 'task' || !c.after) continue
    const t = c.after
    // An archived task is inert: nothing to check until it's restored (task.restore tidies it then), except that
    // its parent links, which are followed while it's archived, can't go round in a loop.
    if (t.archivedAt) {
      if (loops({ ...next.archived, ...next.tasks }, t.id)) reject('A task can’t go inside one of its own subtasks.')
      out[i] = { ...c, after: withFields(t, next.fields, (u) => members.has(u)) }
      continue
    }
    if (t.parentId && !next.tasks[t.parentId]) reject('Its parent task no longer exists.')
    if (t.parentId && wouldCycle(next.tasks, t.id, t.parentId)) reject('A task can’t go inside one of its own subtasks.')
    if (!columns.has(t.status)) reject('Its list no longer exists.')
    // Links that no longer lead anywhere are dropped rather than refusing the whole undo.
    const tidy: Task = {
      ...withFields(t, next.fields, (u) => members.has(u)),
      assigneeId: t.assigneeId && members.has(t.assigneeId) ? t.assigneeId : undefined,
      labels: t.labels.filter((l) => labels.has(l)),
      blockedBy: t.blockedBy.filter((b) => next.tasks[b]),
    }
    if (!tidy.assigneeId) delete tidy.assigneeId
    // A reminder goes to whoever set it when nobody is assigned: that can only be someone on the board.
    if (t.reminders?.some((r) => r.by && !members.has(r.by)))
      tidy.reminders = t.reminders.map((r) => {
        if (!r.by || members.has(r.by)) return r
        const { by: _gone, ...rest } = r
        return rest
      })
    out[i] = { ...c, after: tidy }
  }
  // (Looked up once, not once per record taken away.)
  let used: { parents: Set<string>; lists: Set<string> } | null = null
  for (const c of out) {
    if (c.after) continue
    used ??= {
      parents: new Set(Object.values(next.tasks).flatMap((t) => (t.parentId ? [t.parentId] : []))),
      lists: new Set(Object.values(next.tasks).map((t) => t.status)),
    }
    if (c.entity === 'task' && used.parents.has(c.id)) reject('Its subtasks have changed since, so it can’t be undone.')
    if (c.entity === 'column' && used.lists.has(c.id)) reject('That list has cards in it now, so it can’t be undone.')
  }
  return out
}

/** Checks and tidies task fields: known list, person, labels and blockers only; valid dates; a title. */
function cleanFields(data: BoardData, id: string, f: TaskFields): Partial<Task> {
  const out: Partial<Task> = {}
  if (f.title !== undefined) out.title = f.title.trim() || reject('A task needs a title.')
  if (f.description !== undefined) out.description = f.description || undefined
  if (f.status !== undefined) {
    if (!data.columns.some((c) => c.id === f.status)) reject('That list no longer exists.')
    out.status = f.status
  }
  if (f.assigneeId !== undefined) out.assigneeId = memberOrUndefined(data, f.assigneeId)
  for (const key of ['start', 'due'] as const) {
    const v = f[key]
    if (v === undefined) continue
    if (!v) {
      out[key] = undefined
      continue
    }
    out[key] = normalizeTaskDate(v) ?? reject('Dates look like 2026-10-31, or 2026-10-31T14:30:00Z with a time.')
  }
  if (f.labels) out.labels = [...new Set(f.labels)].filter((l) => data.labels.some((x) => x.id === l))
  if (f.blockedBy) out.blockedBy = [...new Set(f.blockedBy)].filter((b) => b !== id && data.tasks[b])
  if (f.priority !== undefined) out.priority = f.priority ?? undefined
  if (f.reminders) {
    const clean = f.reminders.map((r): Reminder => {
      const at = r.at ? (normalizeTaskDate(r.at) ?? reject('A reminder’s time looks like 2026-10-31T14:30:00Z.')) : undefined
      if (at && at.length <= 10) reject('A reminder needs a time of day.')
      if (!at && r.beforeDue === undefined) reject('A reminder is either at a time or before the due date.')
      return {
        id: r.id,
        ...(at ? { at } : { beforeDue: r.beforeDue, ...(r.tz && { tz: r.tz }) }),
        ...(r.by && data.members.some((m) => m.id === r.by) && { by: r.by }),
      }
    })
    out.reminders = clean.length ? clean : undefined
  }
  if (f.color !== undefined) out.color = f.color ?? undefined
  if (f.custom) {
    // (A card link is checked with what this board knows, a person against its people: see `checkValue`.)
    const r = patchCustom(data.fields, data.tasks[id]?.custom, f.custom, {
      boardId: data.board.id,
      taskId: id,
      exists: (other) => other in data.tasks || !!data.archived?.[other],
      isMember: (u) => data.members.some((m) => m.id === u),
    })
    out.custom = 'error' in r ? reject(r.error) : r.custom
  }
  return out
}

/**
 * A task that comes back from somewhere (undo, the archive), holding only values that fit the board's fields now,
 * and in its person fields only people who are on the board (like its assignee).
 */
function withFields(t: Task, fields: FieldDef[], isMember: (userId: string) => boolean): Task {
  const { custom: _held, ...rest } = t
  const custom = tidyCustom(t.custom, fields, isMember)
  return custom ? { ...rest, custom } : rest
}

function memberOrUndefined(data: BoardData, id: string | null): string | undefined {
  if (id === null) return undefined
  if (!data.members.some((m) => m.id === id)) reject('That person is no longer on this board.')
  return id
}

/** When parents follow their subtasks, a parent's status can't be set by hand. */
function guardParentStatus(data: BoardData, ctx: Context, t: Task) {
  if (data.board.mode === 'derived' && !isLeaf(ctx.idx, t.id))
    reject(`“${t.title}” follows its subtasks. Move its subtasks instead, or set parent status yourself in Board settings.`)
}

const siblingsOf = (data: BoardData, parentId: string | null, except: string) =>
  Object.values(data.tasks)
    .filter((t) => t.parentId === parentId && t.id !== except)
    .sort((a, b) => comparePositions(a.order, b.order))

/**
 * The cards `tasks.archiveDone` puts away: the top-level cards showing in list `status` that got done before `before`
 * (ms), oldest first. When a card got done is the index's `doneAt`: the moment it entered a done list, or, for a
 * parent that follows its subtasks, the moment the last of them did.
 */
export function doneBefore(idx: TaskIndex, status: string, before: number): string[] {
  return idx.roots
    .filter((id) => idx.status.get(id) === status && idx.doneAt.has(id) && idx.doneAt.get(id)! < before)
    .sort((a, b) => idx.doneAt.get(a)! - idx.doneAt.get(b)!)
}

/** Do the parent links from `id` come back round to it? */
function loops(tasks: Record<string, Task | undefined>, id: string): boolean {
  const seen = new Set<string>()
  for (let at = tasks[id]?.parentId; at; at = tasks[at]?.parentId) {
    if (at === id) return true
    if (seen.has(at)) return false
    seen.add(at)
  }
  return false
}

/** Everything under `id` in a set of tasks (by parent links; for archived tasks, which aren't indexed). */
function subtree(tasks: Record<string, Task>, id: string): string[] {
  const kids = new Map<string, string[]>()
  for (const t of Object.values(tasks)) {
    if (!t.parentId) continue
    const of = kids.get(t.parentId)
    if (of) of.push(t.id)
    else kids.set(t.parentId, [t.id])
  }
  const out: string[] = []
  // (Stored parent links are followed as they are, so a loop among them must not keep this going for ever.)
  const seen = new Set([id])
  const stack = [...(kids.get(id) ?? [])]
  while (stack.length) {
    const c = stack.pop()!
    if (seen.has(c)) continue
    seen.add(c)
    out.push(c)
    stack.push(...(kids.get(c) ?? []))
  }
  return out
}

const lastSibling = (data: BoardData, parentId: string | null, except: string) => siblingsOf(data, parentId, except).at(-1)

/** An outline position among `parentId`'s children. */
function orderAt(data: BoardData, id: string, parentId: string | null, place: Place): string {
  const sibs = siblingsOf(data, parentId, id)
  if ('before' in place) {
    const i = sibs.findIndex((s) => s.id === place.before)
    if (i !== -1) return positionBetween(sibs[i - 1]?.order, sibs[i].order)
  }
  if ('after' in place) {
    const i = sibs.findIndex((s) => s.id === place.after)
    if (i !== -1) return positionBetween(sibs[i].order, sibs[i + 1]?.order)
  }
  return positionBetween(sibs.at(-1)?.order, null)
}

/**
 * Board positions for a list in its new order. Normally only the moved cards get a new position (one
 * write each). If the list has cards that were never placed by hand, the whole list gets positions once.
 */
export function listRanks(data: BoardData, order: string[], moved: Set<string>): Record<string, string> {
  const ids = order.filter((id) => data.tasks[id])
  const fixed = ids.filter((id) => !moved.has(id))
  const ranked = fixed.every((id) => data.tasks[id].rank !== undefined)
  const increasing = fixed.every((id, i) => i === 0 || comparePositions(data.tasks[fixed[i - 1]].rank!, data.tasks[id].rank!) < 0)
  if (!ranked || !increasing) {
    const keys = positionsBetween(null, null, ids.length)
    return Object.fromEntries(ids.map((id, i) => [id, keys[i]]).filter(([id, key]) => data.tasks[id].rank !== key))
  }
  // Give each run of moved cards positions between its (unmoved) neighbours.
  const out: Record<string, string> = {}
  for (let i = 0; i < ids.length;) {
    if (!moved.has(ids[i])) {
      i++
      continue
    }
    let j = i
    while (j < ids.length && moved.has(ids[j])) j++
    const keys = positionsBetween(data.tasks[ids[i - 1]]?.rank, data.tasks[ids[j]]?.rank, j - i)
    for (let k = i; k < j; k++) out[ids[k]] = keys[k - i]
    i = j
  }
  return out
}

/** Changes that count as work on a card (the ones the activity feed reports, except moving it in the tree). */
const ACTIVE_FIELDS = [
  'title',
  'status',
  'assigneeId',
  'start',
  'due',
  'description',
  'priority',
  'labels',
  'blockedBy',
  'reminders',
  'archivedAt',
  'custom',
] as const

/** When a card last saw real work: now, if this change is some; otherwise as it was (reordering doesn't count). */
function activeAt(before: Task | null, next: Omit<Task, 'createdAt' | 'updatedAt' | 'version'>, now: string) {
  if (!before) return now
  const same = (k: (typeof ACTIVE_FIELDS)[number]) => JSON.stringify(before[k] ?? null) === JSON.stringify(next[k] ?? null)
  // (An older card without one keeps its last change as its last activity, so reordering it doesn't reset its age.)
  return ACTIVE_FIELDS.every(same) ? (before.activeAt ?? before.updatedAt) : now
}
