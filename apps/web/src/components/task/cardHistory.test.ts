import { describe, expect, it } from 'vitest'
import type { CardHistoryEntry } from '@kanbanto/model/api'
import { stretches } from './cardHistory'

const at = (min: number) => new Date(Date.UTC(2026, 9, 7, 12, 0) - min * 60_000).toISOString()
const ann = { id: 'ann', name: 'Ann' }
const bob = { id: 'bob', name: 'Bob' }
const entry = (minutesAgo: number, actor: CardHistoryEntry['actor'], text: string, via: string | null = null): CardHistoryEntry => ({
  at: at(minutesAgo),
  actor,
  via,
  lines: [{ text }],
})

describe('a card’s history, as visits', () => {
  it('changes by one person minutes apart are one stretch, its lines in the order they happened', () => {
    const s = stretches([
      entry(1, ann, 'set the priority to High'),
      entry(3, ann, 'assigned it to Bob'),
      entry(9, ann, 'moved it from To Do to Doing'),
    ])
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ at: at(1), oldest: at(9) })
    expect(s[0].lines.map((l) => l.text)).toEqual(['moved it from To Do to Doing', 'assigned it to Bob', 'set the priority to High'])
  })

  it('someone else, another app, or a long gap starts a new one', () => {
    const s = stretches([
      entry(1, ann, 'a'),
      entry(2, bob, 'b'),
      entry(3, ann, 'c'),
      entry(4, ann, 'd', 'Claude'),
      entry(5, ann, 'e', 'Claude'),
      entry(30, ann, 'f', 'Claude'),
      entry(31, null, 'g'),
    ])
    expect(s.map((x) => x.lines.map((l) => l.text).join('+'))).toEqual(['a', 'b', 'c', 'e+d', 'f', 'g'])
    // (Each is measured from the one before it, so a slow run of changes stays one visit.)
    expect(stretches([entry(1, ann, 'a'), entry(9, ann, 'b'), entry(17, ann, 'c')])).toHaveLength(1)
  })
})
