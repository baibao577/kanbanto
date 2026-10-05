import { describe, expect, it } from 'vitest'
import { linkRef, mergeCustom, mergeKeepsOne, mergeOptions, mergeProblem, type FieldDef, type LibraryField } from './fields'

const B = '01900000-0000-7000-8000-00000000000b'
const f = (type: FieldDef['type'], extra: Partial<LibraryField> = {}): [LibraryField, LibraryField] => [
  { id: 'from', name: 'Old', type, ...extra },
  { id: 'into', name: 'Kept', type, ...extra },
]
const merged = (
  type: FieldDef['type'],
  custom: Record<string, unknown>,
  extra: Partial<LibraryField> = {},
  fromShown = false,
  options?: Map<string, string>,
) => {
  const [from, into] = f(type, extra)
  return mergeCustom(custom as never, from, into, { fromShown, options })
}

describe('what a card holds after two fields are merged', () => {
  it('a value simply moves over when the card had nothing for the kept field', () => {
    expect(merged('text', { from: 'Acme', other: 1 })).toEqual({ into: 'Acme', other: 1 })
    expect(merged('number', { from: 5 })).toEqual({ into: 5 })
    expect(merged('date', { from: '2026-10-31' })).toEqual({ into: '2026-10-31' })
    expect(merged('checkbox', { from: true })).toEqual({ into: true })
    expect(merged('person', { from: ['ann'] })).toEqual({ into: ['ann'] })
    // A card that had nothing for the field that goes is the same object: nothing to write.
    const untouched = { into: 'x' }
    expect(merged('text', untouched)).toBe(untouched)
    expect(merged('text', undefined as never)).toBeUndefined()
  })

  it('where it had both, the one people can see on the board stays', () => {
    // The board shows the kept field (or both, or neither): its value stays.
    expect(merged('text', { from: 'Old Co', into: 'Kept Co' })).toEqual({ into: 'Kept Co' })
    expect(merged('number', { from: 1, into: 2 })).toEqual({ into: 2 })
    // The board only shows the field that goes: the kept one's value there was hidden, and doesn't replace it.
    expect(merged('text', { from: 'Old Co', into: 'Kept Co' }, {}, true)).toEqual({ into: 'Old Co' })
    expect(merged('date', { from: '2026-01-01', into: '2026-02-02' }, {}, true)).toEqual({ into: '2026-01-01' })
    expect(mergeKeepsOne({ id: 'x', name: 'x', type: 'text' })).toBe(true)
  })

  it('a checkbox is ticked if either was; lists that hold several are joined, the visible ones first', () => {
    expect(merged('checkbox', { from: true, into: true })).toEqual({ into: true })
    expect(merged('person', { from: ['ann', 'bob'], into: ['bob', 'cy'] }, { many: true })).toEqual({ into: ['bob', 'cy', 'ann'] })
    expect(merged('person', { from: ['ann', 'bob'], into: ['bob', 'cy'] }, { many: true }, true)).toEqual({ into: ['ann', 'bob', 'cy'] })
    const [a, b, c] = ['c1', 'c2', 'c3'].map((id) => linkRef(B, id))
    expect(merged('link', { from: [a, b], into: [c] }, { many: true })).toEqual({ into: [c, a, b] })
    expect(mergeKeepsOne({ id: 'x', name: 'x', type: 'link', many: true })).toBe(false)
    expect(mergeKeepsOne({ id: 'x', name: 'x', type: 'checkbox' })).toBe(false)
    // A field that holds one keeps one: its own, or the first of the other's.
    expect(merged('person', { from: ['ann', 'bob'] })).toEqual({ into: ['ann'] })
    expect(merged('person', { from: ['ann'], into: ['cy'] })).toEqual({ into: ['cy'] })
    expect(merged('link', { from: [a], into: [c] }, {}, true)).toEqual({ into: [a] })
    // Joined lists stop at what a field can hold.
    const crowd = (p: string) => Array.from({ length: 15 }, (_, i) => `${p}${i}`)
    expect((merged('person', { from: crowd('a'), into: crowd('b') }, { many: true })!.into as string[]).length).toBe(20)
  })

  it('a choice goes to the kept field’s option of the same name, and the rest are added to it', () => {
    const from: FieldDef = {
      id: 'from',
      name: 'Phase',
      type: 'choice',
      options: [
        { id: 'p-lead', name: 'lead', color: 'gray' },
        { id: 'won', name: 'Closed', color: 'green' },
        { id: 'p-old', name: 'Parked', color: 'amber', archived: true },
        { id: 'p-dead', name: 'Dead', color: 'red', archived: true },
        { id: 'p-shelved', name: 'Shelved', color: 'red' },
      ],
    }
    const into: FieldDef = {
      id: 'into',
      name: 'Stage',
      type: 'choice',
      options: [
        { id: 'lead', name: 'Lead', color: 'blue' },
        { id: 'won', name: 'Won', color: 'green' },
        { id: 's-shelved', name: 'Shelved', color: 'gray', archived: true },
      ],
    }
    let n = 0
    const { map, add } = mergeOptions(from, into, () => `new-${++n}`, new Set(['p-old']))
    // Lead by name; Closed is new there (its id is taken by Won); Parked is still on cards, Dead on none; Shelved is
    // the kept field's archived one.
    expect([...map]).toEqual([
      ['p-lead', 'lead'],
      ['won', 'new-1'],
      ['p-old', 'p-old'],
      ['p-shelved', 's-shelved'],
    ])
    expect(add).toEqual([
      { id: 'new-1', name: 'Closed', color: 'green' },
      { id: 'p-old', name: 'Parked', color: 'amber', archived: true },
    ])
    const move = (custom: Record<string, unknown>, fromShown = false) => mergeCustom(custom as never, from, into, { options: map, fromShown })
    expect(move({ from: ['won'] })).toEqual({ into: ['new-1'] })
    expect(move({ from: ['p-lead'], into: ['won'] })).toEqual({ into: ['won'] })
    expect(move({ from: ['p-lead'], into: ['won'] }, true)).toEqual({ into: ['lead'] })
    // An option that's nowhere any more leaves nothing, and never empties the kept field's own value.
    expect(move({ from: ['gone'], x: 1 })).toEqual({ x: 1 })
    expect(move({ from: ['gone'], into: ['won'] }, true)).toEqual({ into: ['won'] })
  })
})

describe('which fields can be merged', () => {
  it('two in use, of the same kind; card links only from the same place; options that fit', () => {
    const [from, into] = f('text')
    expect(mergeProblem(from, into)).toBeNull()
    expect(mergeProblem(from, from)).toMatch(/another field/)
    expect(mergeProblem({ ...from, archived: true }, into)).toMatch(/Restore the archived field first/)
    expect(mergeProblem(from, { ...into, archived: true })).toMatch(/Restore/)
    expect(mergeProblem(from, { ...into, type: 'number' })).toBe('“Old” is a text and “Kept” a number: only fields of the same kind can be merged.')
    const [l1, l2] = f('link')
    expect(mergeProblem(l1, l2)).toBeNull()
    expect(mergeProblem({ ...l1, linkTo: 'space' }, l2)).toBeNull()
    expect(mergeProblem({ ...l1, linkTo: 'same' }, l2)).toMatch(/different places/)
    expect(mergeProblem({ ...l1, linkTo: 'board', board: B }, { ...l2, linkTo: 'board', board: 'other' })).toMatch(/different places/)
    expect(mergeProblem({ ...l1, linkTo: 'board', board: B }, { ...l2, linkTo: 'board', board: B, many: true })).toBeNull()
    const many = (p: string, count: number) => Array.from({ length: count }, (_, i) => ({ id: `${p}${i}`, name: `${p}${i}`, color: 'gray' as const }))
    const [c1, c2] = f('choice')
    expect(mergeProblem({ ...c1, options: many('a', 30) }, { ...c2, options: many('b', 20) })).toBeNull()
    expect(mergeProblem({ ...c1, options: many('a', 30) }, { ...c2, options: many('b', 21) })).toMatch(/more options than a field can hold \(50\)/)
    // Options of the same name don't count twice.
    expect(mergeProblem({ ...c1, options: many('a', 50) }, { ...c2, options: many('a', 50) })).toBeNull()
  })
})
