import { describe, expect, it } from 'vitest'
import { toDay } from './dates'
import { indexFor } from './indexer'
import { exampleData } from './sample'
import { boardStats, HEAT_WEEKS } from './stats'
import type { BoardData, Task } from './types'

const DAY = 86_400_000

/**
 * The example board (cards: A1 done, A2a and B1 doing, A2b and A3 to do, A4, B2, C1 and C2 in the backlog), all made on
 * 1 January, except: A1 made 10 June and done on the 12th, A3 made 14 June, and an archived card made 1 June and
 * archived as completed on the 14th. Today is 15 June.
 */
function board(): BoardData {
  const base = exampleData('b1')
  const at = (day: string) => `${day}T12:00:00`
  const tasks = Object.fromEntries(
    Object.values(base.tasks).map((t) => [t.id, { ...t, createdAt: at('2026-01-01'), updatedAt: at('2026-01-01'), activeAt: at('2026-01-02') }]),
  )
  tasks.A1 = { ...tasks.A1, createdAt: at('2026-06-10'), activeAt: at('2026-06-12') }
  tasks.A3 = { ...tasks.A3, createdAt: at('2026-06-14'), activeAt: at('2026-06-14'), due: '2026-06-18' }
  tasks.B1 = { ...tasks.B1, activeAt: at('2026-06-01') }
  const gone: Task = { ...tasks.A2b, id: 'Z', title: 'Shipped', createdAt: at('2026-06-01'), archivedAt: at('2026-06-14'), archivedDone: true }
  return { ...base, tasks, archived: { Z: gone } }
}
const today = toDay('2026-06-15')
const stats = (days: number) => {
  const data = board()
  return boardStats(data, indexFor(data), { days, today })
}

describe('board stats', () => {
  it('counts cards (tasks without subtasks): open now, made and done in the period and the one before', () => {
    const s = stats(7)
    expect(s.open).toBe(8)
    expect(s.inProgress).toBe(2)
    expect([s.created, s.createdBefore]).toEqual([2, 0])
    expect([s.done, s.doneBefore]).toEqual([2, 0])
    // The archived card was made on 1 June: in the month, not in the week.
    expect(stats(30).created).toBe(3)
  })

  it('time to done: the median from made to done, and how the cards spread from quick to slow', () => {
    const s = stats(7)
    expect(s.timeToDone).toBe(7.5 * DAY) // 2 days and 13 days
    expect([s.quickest, s.slowest]).toEqual([2 * DAY, 13 * DAY])
    expect(s.buckets).toEqual([0, 1, 0, 1, 0])
    expect(s.timeToDoneBefore).toBeNull()
  })

  it('cards made and done day by day, and week by week over a long period', () => {
    const week = stats(7).flow
    expect(week).toHaveLength(7)
    expect(week.map((f) => f.created)).toEqual([0, 1, 0, 0, 0, 1, 0])
    expect(week.map((f) => f.done)).toEqual([0, 0, 0, 1, 0, 1, 0])
    const quarter = stats(90).flow
    expect(quarter).toHaveLength(13)
    expect(quarter.at(-1)).toMatchObject({ to: today, from: today - 6, created: 2, done: 2 })
    expect(quarter[0].to - quarter[0].from).toBeLessThanOrEqual(6)
  })

  it('where open cards sit, the oldest, the longest untouched, and what is due', () => {
    const s = stats(7)
    expect(s.lists.map((l) => [l.column.id, l.count])).toEqual([
      ['backlog', 4],
      ['todo', 2],
      ['doing', 2],
    ])
    expect(s.oldest).toHaveLength(5)
    expect(s.oldest[0].days).toBe(today - toDay('2026-01-01'))
    // Everything else was last touched on 2 January; B1 on 1 June, A3 yesterday.
    expect(s.untouched[0].days).toBe(today - toDay('2026-01-02'))
    expect(s.untouched.map((c) => c.id)).not.toContain('A3')
    expect(s.dueSoon).toBe(1)
  })

  it('done each day: whole weeks from a Monday up to today', () => {
    const { heat } = stats(7)
    expect(heat.at(-1)!.day).toBe(today)
    expect(new Date(heat[0].day * DAY).getUTCDay()).toBe(1)
    expect(heat.length).toBeGreaterThan((HEAT_WEEKS - 1) * 7)
    expect(heat.find((h) => h.day === toDay('2026-06-12'))!.count).toBe(1)
    expect(heat.reduce((n, h) => n + h.count, 0)).toBe(2)
  })
})
