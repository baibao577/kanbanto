import { afterAll, describe, expect, it } from 'vitest'
import { bigBoard } from './bigBoard'
import { applyChanges } from './changes'
import { execute } from './commands'
import { fieldKey, linkRef, type BoardField } from './fields'
import { buildIndex, indexFor } from './indexer'
import { DEFAULT_DISPLAY } from './prefs'
import { matchesFilter, sortComparator, type TableFilter } from './table'
import { subtreeSums } from './totals'
import { flattenTree } from './tree'
import type { BoardData } from './types'
import { buildView } from './view'

/**
 * How long the board's own logic takes on a big board with every kind of field: 3,000 cards, nested, twenty fields
 * (see bigBoard.ts). Each limit is about five times what it took when it was set (and 50 ms at least), so this only
 * fails when something got much slower, not when the machine is busy. `PERF=1` prints what each one took:
 *
 *   PERF=1 pnpm --filter @kanbanto/model exec vitest run src/perf.test.ts --silent=false
 */
const CARDS = 3000
const big = bigBoard({ cards: CARDS, seed: 3 })
// The app never has a board as it was made up: it gets it as JSON, from the server or the database. So this one goes
// through JSON first. It matters: ids put together piece by piece compare more than twice as slowly as ids read from
// text, and sorting by a choice is mostly comparing ids.
const data: BoardData = JSON.parse(JSON.stringify(big.data))
const pick = Object.fromEntries(Object.entries(big.pick).map(([what, f]) => [what, data.fields.find((x) => x.id === f.id)])) as typeof big.pick
const idx = indexFor(data)
const took: [string, number, number][] = []

/** Runs it five times and takes the middle time: the first run (still warming up) and a pause don't decide it. */
function within(what: string, limit: number, run: () => unknown) {
  const times = Array.from({ length: 5 }, () => {
    const started = performance.now()
    run()
    return performance.now() - started
  }).sort((a, b) => a - b)
  took.push([what, times[2], limit])
  expect(times[2], `${what} (ms)`).toBeLessThan(limit)
}

afterAll(() => {
  if (!process.env.PERF) return
  const width = Math.max(...took.map(([what]) => what.length))
  console.info(
    [
      `${CARDS.toLocaleString('en-US')} cards, ${data.fields.length} fields: median of 5 runs, in ms (and the limit)`,
      ...took.map(([what, ms, limit]) => `  ${what.padEnd(width)}  ${ms.toFixed(ms < 1 ? 3 : 1).padStart(7)}  (${limit})`),
    ].join('\n'),
  )
})

describe('a board of 3,000 cards with twenty fields', () => {
  const someCard = idx.preorder[Math.floor(CARDS / 2)]
  const now = new Date().toISOString()

  it('is indexed quickly, from scratch and after a change', () => {
    within('buildIndex', 50, () => buildIndex(data.tasks, data.board.mode, data.columns, data.members, data.fields))
    // (The index is kept per version of the board: a board that changed is indexed again, whole.)
    within('indexFor, on a board that just changed', 50, () => indexFor({ ...data }))
    expect(idx.preorder).toHaveLength(CARDS)
  })

  it('takes one card’s change quickly', () => {
    const custom = { [pick.text!.id]: 'Somewhere new' }
    const command = { type: 'task.update' as const, id: someCard, fields: { custom } }
    const run = () => execute(data, command, { now, newId: () => 'new', idx })
    within('execute: one card’s field', 50, run)
    const r = run()
    if ('error' in r) throw new Error(r.error)
    within('applyChanges: one card', 50, () => applyChanges(data, r.changes))
    expect(applyChanges(data, r.changes).tasks[someCard].custom).toMatchObject(custom)
  })

  it('filters every card by three fields at once', () => {
    const filter: TableFilter = {
      fields: {
        [pick.choice!.id]: { in: pick.choice!.options!.slice(0, 10).map((o) => o.id) },
        [pick.number!.id]: { min: 5000 },
        [pick.date!.id]: { date: 'week' },
      },
    }
    let kept = 0
    within('matchesFilter: every card, three field filters', 50, () => {
      kept = idx.preorder.filter((id) => matchesFilter(idx, id, filter)).length
    })
    // (One card in five has one of those ten options; of those, some have the number and a date this week.)
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(CARDS / 5)
  })

  it('sorts every card by a field of each kind', () => {
    // What a card link's cards are called: the other board's by number, this board's own by their titles.
    const titles = new Map(Object.values(data.tasks).map((t) => [linkRef(data.board.id, t.id), t.title]))
    const titleOf = (ref: string) => titles.get(ref) ?? `Company ${ref.slice(ref.indexOf(':') + 2)}`
    const sorted = (f: BoardField) => {
      const cmp = sortComparator(idx, { key: fieldKey(f.id), dir: 'asc' }, new Map(), titleOf)
      return [...idx.preorder].sort(cmp)
    }
    // (Each card's value is worked out once per sort: before that, a date was read again and a choice's options looked
    // through at every comparison, which took six and ten times as long.)
    for (const [kind, f, limit] of [
      ['text', pick.text!, 50],
      ['number that adds up', pick.number!, 50],
      ['date', pick.date!, 50],
      ['choice of 50', pick.choice!, 50],
      ['checkbox', pick.checkbox!, 50],
      ['card link', pick.toBoard!, 50],
      ['person', pick.person!, 50],
    ] as const)
      within(`sort every card by a ${kind}`, limit, () => sorted(f))
    // Smallest first, and the cards with nothing for the field last.
    const byDate = sorted(pick.date!).map((id) => data.tasks[id].custom?.[pick.date!.id] as string | undefined)
    const filled = byDate.filter((d) => d !== undefined)
    expect(filled).toEqual([...filled].sort())
    expect(byDate.slice(filled.length).every((d) => d === undefined)).toBe(true)
  })

  it('adds up a number, and lays out the whole tree sorted by a field', () => {
    let sums = new Map<string, number>()
    within('subtreeSums: a number that adds up', 50, () => {
      sums = subtreeSums(idx, pick.number!)
    })
    const own = Object.values(data.tasks).reduce((sum, t) => sum + ((t.custom?.[pick.number!.id] as number | undefined) ?? 0), 0)
    expect(idx.roots.reduce((sum, id) => sum + (sums.get(id) ?? 0), 0)).toBe(own)

    const cmp = sortComparator(idx, { key: fieldKey(pick.choice!.id), dir: 'asc' }, new Map())
    const everything = new Set(idx.childrenOf.keys())
    let rows: string[] = []
    within('flattenTree: all open, sorted by a choice', 50, () => {
      rows = flattenTree(idx, idx.roots, everything, CARDS, undefined, (ids) => [...ids].sort(cmp)).rows
    })
    expect(rows).toHaveLength(CARDS)
  })

  it('is laid out as a board', () => {
    const view = () => buildView(idx, DEFAULT_DISPLAY.board, { now: Date.now() })
    within('buildView: the board, as a new one shows', 50, view)
    within('buildView: every task a card', 50, () => buildView(idx, { ...DEFAULT_DISPLAY.board, filter: 'all', groupByParent: false }, {}))
    expect(view().columns).toHaveLength(data.columns.length)
  })
})
