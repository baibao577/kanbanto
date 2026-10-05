import { fromDay, todayDay } from './dates'
import { positionsBetween } from './position'
import { makeTask } from './records'
import { builtIn, DEFAULT_COLUMNS, EXAMPLE_COLUMNS, type BoardData, type LabelDef, type Member, type Task, type TaskMap } from './types'

// Positions a0 < a1 < a2 … are valid position keys (see model/position.ts).
const at = (n: number) => `a${n}`
const t = (id: string, title: string, parentId: string | null, status: string, order: number, extra: Partial<Task> = {}): Task =>
  makeTask({ id, title, parentId, status, order: at(order), ...extra })

export const SAMPLE_MEMBERS: Member[] = [
  { id: 'mai', name: 'Mai', ...builtIn() },
  { id: 'ton', name: 'Ton', ...builtIn() },
  { id: 'ploy', name: 'Ploy', ...builtIn() },
]

export const SAMPLE_LABELS: LabelDef[] = [
  { id: 'ui', name: 'ui', color: 'blue', ...builtIn() },
  { id: 'brand', name: 'brand', color: 'green', ...builtIn() },
  { id: 'marketing', name: 'marketing', color: 'orange', ...builtIn() },
]

/** The running example from the design notes. Dates are relative to today so the timeline always looks current. */
export function sampleTasks(): TaskMap {
  const today = todayDay()
  const when = (from: number, to: number) => ({ start: fromDay(today + from), due: fromDay(today + to) })
  const list = [
    t('A', 'Launch website', null, 'todo', 1, { assigneeId: 'mai', ...when(-10, 20) }),
    t('A1', 'Buy domain', 'A', 'done', 1, { assigneeId: 'mai', ...when(-10, -8) }),
    t('A2', 'Design', 'A', 'doing', 2, { assigneeId: 'ton', ...when(-6, 8) }),
    t('A2a', 'Homepage', 'A2', 'doing', 1, { assigneeId: 'ton', labels: ['ui'], ...when(-5, 3) }),
    t('A2b', 'Logo', 'A2', 'todo', 2, { assigneeId: 'ton', labels: ['brand'], ...when(2, 8) }),
    t('A3', 'Deploy', 'A', 'todo', 3, { assigneeId: 'mai', ...when(9, 12) }),
    // Event is left unscheduled to show "click to schedule".
    t('B', 'Event', null, 'todo', 2, { assigneeId: 'ploy' }),
    t('B1', 'Send invites', 'B', 'doing', 1, { assigneeId: 'ploy', ...when(-1, 4) }),
  ]
  return Object.fromEntries(list.map((x) => [x.id, x]))
}

/**
 * The example board in the app: the running example plus some planned work in the Backlog list.
 * With `ownerId`, Mai's tasks are assigned to that person instead and the other sample people are left
 * out (on a server, a board's people are its members, not records in the board).
 */
export function exampleData(boardId: string, ownerId?: string): BoardData {
  const data = sampleBoard(boardId)
  if (!ownerId) return data
  const tasks: TaskMap = {}
  for (const task of Object.values(data.tasks)) {
    const { assigneeId, ...rest } = task
    tasks[task.id] = assigneeId === 'mai' ? { ...rest, assigneeId: ownerId } : rest
  }
  return { ...data, members: [], tasks }
}

function sampleBoard(boardId: string): BoardData {
  const today = todayDay()
  const when = (from: number, to: number) => ({ start: fromDay(today + from), due: fromDay(today + to) })
  const extra = [
    t('A4', 'Write the launch blog post', 'A', 'backlog', 4, { assigneeId: 'mai', labels: ['marketing'] }),
    t('B2', 'Book a photographer', 'B', 'backlog', 2, { assigneeId: 'ploy' }),
    t('C', 'Newsletter redesign', null, 'backlog', 3, { labels: ['marketing'], ...when(20, 40) }),
    t('C1', 'Pick a template', 'C', 'backlog', 1, { labels: ['brand'] }),
    t('C2', 'Draft the first issue', 'C', 'backlog', 2),
  ]
  return {
    board: { id: boardId, name: 'My board', mode: 'derived', ...builtIn() },
    members: SAMPLE_MEMBERS,
    columns: EXAMPLE_COLUMNS,
    labels: SAMPLE_LABELS,
    fields: [],
    tasks: { ...sampleTasks(), ...Object.fromEntries(extra.map((x) => [x.id, x])) },
  }
}

/** A new, empty board: To Do / Doing / Done (plus a Backlog list, hidden by default), no tasks. */
export function emptyBoard(id: string, name: string, now: string): BoardData {
  const keys = positionsBetween(null, null, EXAMPLE_COLUMNS.length)
  return {
    board: { id, name, mode: 'derived', createdAt: now, updatedAt: now, version: 1 },
    members: [],
    columns: EXAMPLE_COLUMNS.map((c, i) => ({ ...c, position: keys[i], createdAt: now, updatedAt: now })),
    labels: [],
    fields: [],
    tasks: {},
  }
}

/**
 * A person's Inbox: quick notes and cards that have no board yet. To Do / Doing / Done, and statuses set by hand, so
 * a card with steps under it can still be put in any list.
 */
export function inboxBoard(id: string, now: string): BoardData {
  const keys = positionsBetween(null, null, DEFAULT_COLUMNS.length)
  return {
    board: {
      id,
      name: 'Inbox',
      mode: 'manual',
      description: 'Quick notes and cards that have no board yet. Only you can see it.',
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    members: [],
    columns: DEFAULT_COLUMNS.map((c, i) => ({ ...c, position: keys[i], createdAt: now, updatedAt: now })),
    labels: [],
    fields: [],
    tasks: {},
  }
}
