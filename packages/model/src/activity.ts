import type { Command } from './commands'
import { linksOf, parseRef, sameValue, valueText, type FieldValue } from './fields'
import type { Change } from './records'
import { PRIORITY_LABEL, type BoardData, type Task } from './types'

/** One line of a board's activity: what happened, in words (the actor is added by whoever shows it). */
export interface ActivityItem {
  /** The task it's about, if any (it may have been deleted since). */
  taskId?: string
  /** Lowercase, to follow a name: "moved “Deploy” to Done". */
  text: string
  /**
   * The same line as it reads in that task's own history, where its name needn't be said and there's room for what
   * it was before: "moved it from To Do to Done". A date in it is written `{date}`, for whoever shows it to put in
   * the reader's own words (see `date`). Lines logged before this was kept have none, and are shown as `text`.
   */
  own?: string
  /** The date `own` speaks of: a day ("2026-10-20") or a moment. */
  date?: string
}

/** Where a line's date goes in `own`. */
export const OWN_DATE = '{date}'

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
  return cutItems(describeAllChanges(before, changes, command))
}

/** The lines the log keeps of one change: the first ones, and how many more there were. */
export function cutItems(items: ActivityItem[]): ActivityItem[] {
  if (items.length <= MAX_ITEMS) return items
  return [...items.slice(0, MAX_ITEMS - 1), { text: `and made ${items.length - MAX_ITEMS + 1} more changes` }]
}

/** Every line of a change, however many (a chat webhook counts them itself). */
export function describeAllChanges(before: BoardData, changes: Change[], command?: Command): ActivityItem[] {
  // Clearing a field on every card is one thing that happened, not one per card.
  if (command?.type === 'tasks.clearField') {
    const n = changes.filter((c) => c.entity === 'task').length
    const name = before.fields.find((f) => f.id === command.fieldId)?.name ?? 'a field'
    return n ? [{ text: `cleared ${name} on ${n} ${n === 1 ? 'card' : 'cards'}` }] : []
  }
  // So is adding many cards from a spreadsheet: the log says how many, and the lists that came with them.
  if (command?.type === 'tasks.import') {
    const n = changes.filter((c) => c.entity === 'task' && !c.before).length
    const lists = changes.flatMap((c) => (c.entity === 'column' && c.after ? [q((c.after as { name: string }).name)] : []))
    return [
      ...(n ? [{ text: `imported ${n.toLocaleString('en')} ${n === 1 ? 'card' : 'cards'}` }] : []),
      ...(lists.length ? [{ text: `added the ${lists.length === 1 ? 'list' : 'lists'} ${lists.join(', ')}` }] : []),
    ]
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
  // Labels as the card's own history says them: by name, when they all have one.
  const labelWords = (ids: string[]) => {
    const names = ids.map((id) => before.labels.find((l) => l.id === id)?.name.trim() ?? '')
    if (!names.length || names.some((n) => !n)) return null
    return `${names.length === 1 ? 'the label' : 'the labels'} ${names.map(q).join(', ')}`
  }
  const items: ActivityItem[] = []
  /** A line about a task: as the board's log says it, and as the task's own history does. */
  const say = (taskId: string, text: string, own: string, date?: string) => items.push({ taskId, text, own, ...(date && { date }) })
  for (const c of changes) {
    if (c.entity === 'task') {
      const a = c.before as Task | null
      const b = c.after as Task | null
      if (!a && b) {
        const parent = title(b.parentId)
        const under = parent ? ` under ${q(parent)}` : ''
        say(b.id, `added ${q(b.title)}${under}`, `added it${under}`)
      } else if (a && !b) say(a.id, `deleted ${q(a.title)}`, 'deleted it')
      else if (a && b && flipped.has(b.id)) {
        if (!(b.parentId && flipped.has(b.parentId))) {
          const did = b.archivedAt ? ['archived', b.archivedDone ? ' as completed' : ''] : ['restored', '']
          say(b.id, `${did[0]} ${q(b.title)}${did[1]}`, `${did[0]} it${did[1]}`)
        }
      } else if (a && b) {
        const t = q(b.title)
        if (a.title !== b.title) say(b.id, `renamed ${q(a.title)} to ${t}`, `renamed it from ${q(a.title)} to ${t}`)
        if (a.status !== b.status) say(b.id, `moved ${t} to ${list(b.status)}`, `moved it from ${list(a.status)} to ${list(b.status)}`)
        if (a.parentId !== b.parentId) {
          const where = b.parentId ? `under ${q(title(b.parentId)!)}` : 'to the top level'
          say(b.id, `moved ${t} ${where}`, `moved it ${where}`)
        }
        if (a.assigneeId !== b.assigneeId) {
          if (b.assigneeId) say(b.id, `assigned ${t} to ${person(b.assigneeId)}`, `assigned it to ${person(b.assigneeId)}`)
          else say(b.id, `unassigned ${t}`, 'unassigned it')
        }
        if (a.due !== b.due) {
          if (b.due) say(b.id, `set ${t} due ${b.due}`, `set it due ${OWN_DATE}`, b.due)
          else say(b.id, `cleared the due date of ${t}`, 'cleared its due date')
        }
        if (a.start !== b.start) {
          if (b.start) say(b.id, `set ${t} to start ${b.start}`, `set it to start ${OWN_DATE}`, b.start)
          else say(b.id, `cleared the start date of ${t}`, 'cleared its start date')
        }
        if ((a.description ?? '') !== (b.description ?? '')) say(b.id, `edited the description of ${t}`, 'edited the description')
        const ra = a.reminders?.length ?? 0
        const rb = b.reminders?.length ?? 0
        if (rb > ra) say(b.id, `set a reminder on ${t}`, 'set a reminder')
        else if (rb < ra)
          say(b.id, rb ? `removed a reminder from ${t}` : `removed the reminders from ${t}`, rb ? 'removed a reminder' : 'removed the reminders')
        else if (JSON.stringify(a.reminders ?? []) !== JSON.stringify(b.reminders ?? []))
          say(b.id, `changed a reminder on ${t}`, 'changed a reminder')
        if (a.priority !== b.priority) {
          if (b.priority) say(b.id, `set the priority of ${t} to ${b.priority}`, `set the priority to ${PRIORITY_LABEL[b.priority]}`)
          else say(b.id, `cleared the priority of ${t}`, 'cleared the priority')
        }
        if (a.labels.join() !== b.labels.join()) {
          // (Which ones, where they can be named: "added the label “API”", "removed the labels “Old”, “Draft”".)
          const added = labelWords(b.labels.filter((l) => !a.labels.includes(l)))
          const removed = labelWords(a.labels.filter((l) => !b.labels.includes(l)))
          const which = [added && `added ${added}`, removed && `removed ${removed}`].filter(Boolean).join(' and ')
          say(b.id, `changed the labels of ${t}`, which || 'changed the labels')
        }
        if (a.blockedBy.join() !== b.blockedBy.join()) say(b.id, `changed what ${t} waits on`, 'changed what it waits on')
        for (const f of before.fields) {
          const value = b.custom?.[f.id]
          if (sameValue(a.custom?.[f.id], value)) continue
          if (value === undefined) {
            say(b.id, `cleared ${f.name} of ${t}`, `cleared ${f.name}`)
            continue
          }
          // (People are named as the board knew them before the change: its people aren't changed by commands.)
          const words = short(
            f.type === 'link' ? linkedText(before, value) : valueText(f, value, (id) => before.members.find((m) => m.id === id)?.name),
          )
          say(b.id, `set ${f.name} of ${t} to ${words}`, `set ${f.name} to ${words}`)
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
  return items
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
