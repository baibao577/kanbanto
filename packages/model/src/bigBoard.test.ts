import { describe, expect, it } from 'vitest'
import { BIG_BOARD_ID, BIG_OTHER_BOARD_ID, bigBoard, bigFields, bigFieldSpecs } from './bigBoard'
import { todayDay } from './dates'
import { checkValue, FIELD_LIMITS, FIELD_TYPES, parseRef } from './fields'
import { buildIndex } from './indexer'
import { repairData } from './migrate'
import { BoardDataSchema } from './schema'
import type { BoardData } from './types'

const today = todayDay()

/** Every value on every card, checked the way a new value is (strictly): what it holds is what the check gives back. */
function checkValues(data: BoardData) {
  const people = new Set(data.members.map((m) => m.id))
  let values = 0
  for (const t of [...Object.values(data.tasks), ...Object.values(data.archived ?? {})]) {
    for (const [id, held] of Object.entries(t.custom ?? {})) {
      const def = data.fields.find((f) => f.id === id)
      expect(def, `a value for a field the board doesn’t use: ${id}`).toBeDefined()
      const r = checkValue(def!, held, false, {
        boardId: data.board.id,
        taskId: t.id,
        exists: (other) => other in data.tasks,
        isMember: (u) => people.has(u),
      })
      expect(r, `${def!.name} on “${t.title}”`).toEqual({ value: held })
      values++
    }
  }
  return values
}

describe('a big board, made up', () => {
  it('is a board the app would accept: its shape, its references and every value', () => {
    const { data, pick, linksElsewhere } = bigBoard({ cards: 1200, archived: 300, today })
    expect(Object.keys(data.tasks)).toHaveLength(1200)
    expect(Object.keys(data.archived!)).toHaveLength(300)
    // Nothing is dropped or changed by the checks a file from outside goes through.
    expect(BoardDataSchema.parse(data)).toEqual(data)
    expect(repairData(data)).toEqual(data)
    expect(Object.values(data.archived!).every((t) => t.archivedAt && t.archivedList)).toBe(true)

    // Twenty fields, of every kind, within what a board can use; four in five cards hold a value for each.
    expect(data.fields).toHaveLength(FIELD_LIMITS.perBoard)
    expect(new Set(data.fields.map((f) => f.type))).toEqual(new Set(FIELD_TYPES))
    expect(data.fields.filter((f) => f.front)).toHaveLength(FIELD_LIMITS.front)
    expect(data.fields.filter((f) => f.total)).toHaveLength(FIELD_LIMITS.totals)
    expect(pick.choice!.options).toHaveLength(FIELD_LIMITS.options)
    expect(Object.values(pick).every(Boolean)).toBe(true)
    const values = checkValues(data)
    expect(values / (1500 * 20)).toBeGreaterThan(0.75)
    expect(values / (1500 * 20)).toBeLessThan(0.85)

    // Links: to cards of the board the field names, to this board's own cards, and to both.
    const refs = (fieldId: string) => Object.values(data.tasks).flatMap((t) => (t.custom?.[fieldId] as string[] | undefined) ?? [])
    expect(refs(pick.toBoard!.id).every((r) => parseRef(r)!.boardId === BIG_OTHER_BOARD_ID)).toBe(true)
    expect(refs(pick.toSame!.id).every((r) => parseRef(r)!.boardId === BIG_BOARD_ID)).toBe(true)
    expect(new Set(refs(pick.toSpace!.id).map((r) => parseRef(r)!.boardId))).toEqual(new Set([BIG_BOARD_ID, BIG_OTHER_BOARD_ID]))
    expect(linksElsewhere).toBeGreaterThan(300)
  })

  it('nests about one card in twenty at the top, three levels down at most; or not at all', () => {
    const nested = bigBoard({ cards: 2000, today }).data
    const idx = buildIndex(nested.tasks, nested.board.mode, nested.columns, nested.members, nested.fields)
    expect(idx.roots).toHaveLength(100)
    expect(Math.max(...idx.depth.values())).toBe(3)
    expect(idx.preorder).toHaveLength(2000)
    const flat = bigBoard({ cards: 500, shape: 'flat', today }).data
    expect(Object.values(flat.tasks).every((t) => t.parentId === null)).toBe(true)
    expect(flat.archived).toBeUndefined()
  })

  it('is the same board for the same seed, and another one for another', () => {
    const make = (seed: number) => bigBoard({ seed, cards: 400, archived: 50, today }).data
    expect(make(7)).toEqual(make(7))
    expect(Object.keys(make(7).tasks)).not.toEqual(Object.keys(make(8).tasks))
  })

  it('takes the fields, the people and the other board’s cards it’s given', () => {
    const other = { boardId: '0198c0de-0000-7000-8000-0000000000aa', taskIds: ['a', 'b', 'c'] }
    const fields = bigFields(other.boardId).filter((f) => f.type === 'link' || f.type === 'person')
    const members = [
      { id: 'u1', name: 'Ann' },
      { id: 'u2', name: 'Bob' },
    ]
    const { data, linksElsewhere } = bigBoard({ cards: 300, shape: 'flat', fields, members, other, titles: 'names', today })
    expect(data.fields).toEqual(fields)
    expect(data.members.map((m) => m.id)).toEqual(['u1', 'u2'])
    expect(linksElsewhere).toBe(3)
    expect(checkValues(data)).toBeGreaterThan(300)
    expect(BoardDataSchema.parse(data)).toEqual(data)
    // (What a library is asked for has no ids yet: the same twenty, by name.)
    expect(bigFieldSpecs().map((f) => f.name)).toEqual(bigFields().map((f) => f.name))
  })
})
