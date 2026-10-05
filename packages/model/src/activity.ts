import type { Command } from './commands'
import { linksOf, parseRef, sameValue, valueText, type FieldValue } from './fields'
import type { Change } from './records'
import type { BoardData, Task } from './types'

/** One line of a board's activity: what happened, in words (the actor is added by whoever shows it). */
export interface ActivityItem {
  /** The task it's about, if any (it may have been deleted since). */
  taskId?: string
  /** Lowercase, to follow a name: "moved “Deploy” to Done". */
  text: string
}

/** Lines kept per change: undoing a big delete restores many records at once. */
const MAX_ITEMS = 20

const q = (s: string) => `“${s}”`
/** A value, cut short: the log says what changed, it doesn't keep the whole text. */
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s)

/**
 * What a change did, in words, for the activity log: "added “Logo”", "moved “Deploy” to Done", "assigned “Deploy” to
 * Ann". `before` is the board before the change (for list, parent and people names). Reordering alone isn't worth a
 * line, so a change that only moves things around its list says nothing.
 */
export function describeChanges(before: BoardData, changes: Change[], command?: Command): ActivityItem[] {
  // Clearing a field on every card is one thing that happened, not one per card.
  if (command?.type === 'tasks.clearField') {
    const n = changes.filter((c) => c.entity === 'task').length
    const name = before.fields.find((f) => f.id === command.fieldId)?.name ?? 'a field'
    return n ? [{ text: `cleared ${name} on ${n} ${n === 1 ? 'card' : 'cards'}` }] : []
  }
  const list = (id: string) => before.columns.find((c) => c.id === id)?.name ?? 'another list'
  const person = (id: string | undefined) => (id ? (before.members.find((m) => m.id === id)?.name ?? 'someone') : null)
  // A parent may be created in the same change (e.g. undo), so look in the change too.
  const created = new Map(changes.flatMap((c) => (c.entity === 'task' && c.after ? [[c.id, c.after as Task] as const] : [])))
  const title = (id: string | null) => (id ? (before.tasks[id]?.title ?? created.get(id)?.title ?? 'a task') : null)

  // Archiving or restoring moves a whole subtree: one line for the task at its top.
  const flipped = new Set(
    changes.flatMap((c) =>
      c.entity === 'task' && c.before && c.after && !(c.before as Task).archivedAt !== !(c.after as Task).archivedAt ? [c.id] : [],
    ),
  )
  const items: ActivityItem[] = []
  for (const c of changes) {
    if (c.entity === 'task') {
      const a = c.before as Task | null
      const b = c.after as Task | null
      if (!a && b) {
        const parent = title(b.parentId)
        items.push({ taskId: b.id, text: `added ${q(b.title)}${parent ? ` under ${q(parent)}` : ''}` })
      } else if (a && !b) items.push({ taskId: a.id, text: `deleted ${q(a.title)}` })
      else if (a && b && flipped.has(b.id)) {
        if (!(b.parentId && flipped.has(b.parentId)))
          items.push({
            taskId: b.id,
            text: b.archivedAt ? `archived ${q(b.title)}${b.archivedDone ? ' as completed' : ''}` : `restored ${q(b.title)}`,
          })
      } else if (a && b) {
        const t = q(b.title)
        if (a.title !== b.title) items.push({ taskId: b.id, text: `renamed ${q(a.title)} to ${t}` })
        if (a.status !== b.status) items.push({ taskId: b.id, text: `moved ${t} to ${list(b.status)}` })
        if (a.parentId !== b.parentId)
          items.push({ taskId: b.id, text: b.parentId ? `moved ${t} under ${q(title(b.parentId)!)}` : `moved ${t} to the top level` })
        if (a.assigneeId !== b.assigneeId)
          items.push({ taskId: b.id, text: b.assigneeId ? `assigned ${t} to ${person(b.assigneeId)}` : `unassigned ${t}` })
        if (a.due !== b.due) items.push({ taskId: b.id, text: b.due ? `set ${t} due ${b.due}` : `cleared the due date of ${t}` })
        if (a.start !== b.start) items.push({ taskId: b.id, text: b.start ? `set ${t} to start ${b.start}` : `cleared the start date of ${t}` })
        if ((a.description ?? '') !== (b.description ?? '')) items.push({ taskId: b.id, text: `edited the description of ${t}` })
        const ra = a.reminders?.length ?? 0
        const rb = b.reminders?.length ?? 0
        if (rb > ra) items.push({ taskId: b.id, text: `set a reminder on ${t}` })
        else if (rb < ra) items.push({ taskId: b.id, text: rb ? `removed a reminder from ${t}` : `removed the reminders from ${t}` })
        else if (JSON.stringify(a.reminders ?? []) !== JSON.stringify(b.reminders ?? []))
          items.push({ taskId: b.id, text: `changed a reminder on ${t}` })
        if (a.priority !== b.priority)
          items.push({ taskId: b.id, text: b.priority ? `set the priority of ${t} to ${b.priority}` : `cleared the priority of ${t}` })
        if (a.labels.join() !== b.labels.join()) items.push({ taskId: b.id, text: `changed the labels of ${t}` })
        if (a.blockedBy.join() !== b.blockedBy.join()) items.push({ taskId: b.id, text: `changed what ${t} waits on` })
        for (const f of before.fields) {
          const value = b.custom?.[f.id]
          if (sameValue(a.custom?.[f.id], value)) continue
          if (f.type === 'link' && value !== undefined) {
            items.push({ taskId: b.id, text: `set ${f.name} of ${t} to ${short(linkedText(before, value))}` })
            continue
          }
          items.push({
            taskId: b.id,
            text: value === undefined ? `cleared ${f.name} of ${t}` : `set ${f.name} of ${t} to ${short(valueText(f, value))}`,
          })
        }
      }
    } else if (c.entity === 'column') {
      const a = c.before as { name: string } | null
      const b = c.after as { name: string } | null
      if (!a && b) items.push({ text: `added the list ${q(b.name)}` })
      else if (a && !b) items.push({ text: `deleted the list ${q(a.name)}` })
      else if (a && b && a.name !== b.name) items.push({ text: `renamed the list ${q(a.name)} to ${q(b.name)}` })
    } else if (c.entity === 'board') {
      const a = c.before as { name: string; description?: string } | null
      const b = c.after as { name: string; description?: string } | null
      if (a && b && a.name !== b.name) items.push({ text: `renamed the board to ${q(b.name)}` })
      if (a && b && a.description !== b.description) items.push({ text: 'changed what the board is for' })
    }
  }
  if (items.length <= MAX_ITEMS) return items
  return [...items.slice(0, MAX_ITEMS - 1), { text: `and made ${items.length - MAX_ITEMS + 1} more changes` }]
}

/**
 * A card link's cards, as the log says them: by title when they're all on this board, and without a name otherwise
 * ("a card on another board", "3 cards"). People who read this board's log may not be able to open the other one.
 */
function linkedText(board: BoardData, value: FieldValue): string {
  const refs = linksOf(value)
  const titles = refs.flatMap((ref) => {
    const to = parseRef(ref)
    const card = to && to.boardId === board.board.id ? (board.tasks[to.taskId] ?? board.archived?.[to.taskId]) : undefined
    return card ? [`“${card.title}”`] : []
  })
  if (titles.length === refs.length) return titles.join(', ')
  return refs.length === 1 ? 'a card on another board' : `${refs.length} cards`
}
