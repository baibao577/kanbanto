import { describe, expect, it } from 'vitest'
import { applyChanges, invertChanges } from './changes'
import { execute, type Command } from './commands'
import { indexFor } from './indexer'
import { planMove } from './moveBoard'
import { exampleData } from './sample'
import { CommandSchema, TaskSchema } from './schema'
import { exportFile, readBoardFile } from './transfer'
import type { BoardData, Task } from './types'

const NOW = '2026-10-08T03:00:00.000Z'
const FILE = '01a11a5c-609c-7236-b2bd-0c3a10370e48'
const OTHER = '01a11a5c-609c-7236-b2bd-0c3a10370e49'

/** The example board, with a cover on "Deploy" (A3), as the server holds it once one is set. */
function board(): BoardData {
  const data = exampleData('b1', 'u1')
  return { ...data, tasks: { ...data.tasks, A3: { ...data.tasks.A3, cover: FILE } } }
}
let n = 0
const run = (data: BoardData, command: Command) => {
  const r = execute(data, command, { now: NOW, newId: () => `new${++n}`, idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return { changes: r.changes, data: applyChanges(data, r.changes) }
}

describe('a card’s cover', () => {
  it('is a file’s id; anything else is read as none', () => {
    const t = board().tasks.A3
    expect(TaskSchema.parse(t).cover).toBe(FILE)
    for (const cover of ['mug.jpg', '', 12, null, { id: FILE }]) expect(TaskSchema.parse({ ...t, cover }).cover).toBeUndefined()
  })

  it('no command sets one: a card that’s made or edited is given none, and one that has it keeps it', () => {
    const data = board()
    // What a command is allowed to say doesn't include it.
    const update = CommandSchema.safeParse({ type: 'task.update', id: 'A1', fields: { title: 'x', cover: OTHER } })
    expect(update.success && 'cover' in (update.data as { fields: object }).fields).toBe(false)
    // …and one that says it anyway (not checked) still gives none.
    const made = run(data, { type: 'task.create', id: 'n1', parentId: null, fields: { title: 'New', cover: OTHER } as never })
    expect(made.data.tasks.n1.cover).toBeUndefined()
    const edited = run(data, { type: 'task.update', id: 'A1', fields: { title: 'Renamed', cover: OTHER } as never })
    expect(edited.data.tasks.A1.cover).toBeUndefined()
    // Every change to the card that has one carries it along.
    for (const command of [
      { type: 'task.update', id: 'A3', fields: { title: 'Ship it', priority: 'high' } },
      { type: 'task.move', id: 'A3', parentId: null, index: 0 },
      { type: 'task.archive', id: 'A3' },
    ] as Command[]) {
      const after = run(data, command).data
      expect([command.type, (after.tasks.A3 ?? after.archived?.A3)?.cover]).toEqual([command.type, FILE])
    }
    const archived = run(data, { type: 'task.archive', id: 'A3' }).data
    expect(run(archived, { type: 'task.restore', id: 'A3' }).data.tasks.A3.cover).toBe(FILE)
  })

  it('an undo leaves it as it is now, whatever the record it puts back says', () => {
    const data = board()
    // An edit made before the cover was set, undone after: the title goes back, the cover stays.
    const before = { ...data, tasks: { ...data.tasks, A3: (({ cover: _c, ...t }) => t)(data.tasks.A3) as Task } }
    const edit = run(before, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    const now = { ...edit.data, tasks: { ...edit.data.tasks, A3: { ...edit.data.tasks.A3, cover: FILE } } }
    const undone = run(now, { type: 'records.restore', changes: invertChanges(now, edit.changes, NOW) }).data.tasks.A3
    expect([undone.title, undone.cover]).toEqual(['Deploy', FILE])
    // One made after it was removed doesn't bring it back, and a made-up one doesn't set another.
    const bare = run(before, { type: 'records.restore', changes: [{ entity: 'task', id: 'A3', before: before.tasks.A3, after: data.tasks.A3 }] })
    expect(bare.data.tasks.A3.cover).toBeUndefined()
    const forged = run(data, {
      type: 'records.restore',
      changes: [{ entity: 'task', id: 'A3', before: data.tasks.A3, after: { ...data.tasks.A3, cover: OTHER } }],
    })
    expect(forged.data.tasks.A3.cover).toBe(FILE)
    // A card that comes back from being deleted brings what its record says: the server checks that one (see the
    // server's covers tests).
    const del = run(data, { type: 'task.delete', id: 'A3' })
    expect(run(del.data, { type: 'records.restore', changes: invertChanges(del.data, del.changes, NOW) }).data.tasks.A3.cover).toBe(FILE)
  })

  it('goes with a card to another board', () => {
    const data = board()
    const target = exampleData('b2', 'u1')
    const plan = planMove(data, target, 'A3', {}, { now: NOW, newId: () => `m${++n}` })
    if ('error' in plan) throw new Error(plan.error)
    const there = applyChanges(target, plan.target)
    expect(there.tasks[plan.ids.get('A3')!].cover).toBe(FILE)
  })

  it('stays out of a board’s file, both ways: files don’t travel in it', () => {
    const data = board()
    const file = exportFile(data)
    expect(Object.values(file.data.tasks).some((t) => t.cover)).toBe(false)
    expect(file.data.tasks.A3.title).toBe('Deploy')
    // (A board with none is written as it is.)
    const plain = exampleData('b1', 'u1')
    expect(exportFile(plain).data).toBe(plain)
    // A file that names one anyway (made by hand, or by a version that wrote them) is read without it.
    const read = readBoardFile({ ...file, data: { ...data, archived: { Z: { ...data.tasks.B1, id: 'Z', archivedAt: NOW, cover: OTHER } } } }, 'b9')
    expect([...Object.values(read.tasks), ...Object.values(read.archived ?? {})].some((t) => t.cover)).toBe(false)
  })
})
