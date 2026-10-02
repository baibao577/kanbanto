import { describe, expect, it } from 'vitest'
import { cardMoment, compareCards, hasWords, matchesCard, periodOf, resolveDays, resolveRange, wordsOf, type CardFacts } from './search'

const at = (day: string, time = '12:00') => new Date(`${day}T${time}:00`).getTime()
const card = (over: Partial<CardFacts> = {}): CardFacts => ({
  text: 'write the launch blog post',
  labels: ['marketing'],
  kind: 'doing',
  done: false,
  archived: false,
  leaf: true,
  createdAt: at('2026-07-01'),
  activeAt: at('2026-09-20'),
  doneAt: null,
  archivedAt: null,
  ...over,
})
const done = card({ kind: 'done', done: true, doneAt: at('2026-09-10'), activeAt: at('2026-09-25') })

describe('searching cards', () => {
  it('words: every one of them, anywhere in the text, whatever the case', () => {
    expect(wordsOf('  Launch  BLOG ')).toEqual(['launch', 'blog'])
    expect(hasWords(wordsOf('blog launch'), card().text)).toBe(true)
    expect(matchesCard(card(), { words: ['blog', 'newsletter'] })).toBe(false)
    expect(matchesCard(card(), {})).toBe(true)
  })

  it('who, what kind of list, done or not, priority, label, parents left out', () => {
    expect(matchesCard(card({ assigneeId: 'ann' }), { assignee: 'ann' })).toBe(true)
    expect(matchesCard(card({ assigneeId: 'ann' }), { assignee: '' })).toBe(false)
    expect(matchesCard(card(), { assignee: '' })).toBe(true)
    expect(matchesCard(card(), { kinds: ['backlog', 'todo'] })).toBe(false)
    expect(matchesCard(card(), { kinds: ['doing'], completed: false })).toBe(true)
    // An archived card that wasn't finished has no kind of list any more.
    expect(matchesCard(card({ kind: null, archived: true, archivedAt: at('2026-09-21') }), { kinds: ['doing'] })).toBe(false)
    expect(matchesCard(card({ priority: 'high' }), { priorities: ['urgent', 'high'] })).toBe(true)
    expect(matchesCard(card(), { priorities: ['urgent', ''] })).toBe(true)
    expect(matchesCard(card(), { label: 'marketing' })).toBe(true)
    expect(matchesCard(card(), { label: 'bug' })).toBe(false)
    expect(matchesCard(card({ leaf: false }), { leaves: true })).toBe(false)
  })

  it('due: overdue (not once done), in the next 7 days, or none', () => {
    const today = Date.UTC(2026, 9, 2) / 86_400_000
    expect(matchesCard(card({ due: '2020-01-01' }), { due: 'overdue', today })).toBe(true)
    expect(matchesCard(card({ ...done, due: '2020-01-01' }), { due: 'overdue', today })).toBe(false)
    expect(matchesCard(card({ due: '2026-10-09' }), { due: 'week', today })).toBe(true)
    expect(matchesCard(card({ due: '2026-10-10' }), { due: 'week', today })).toBe(false)
    expect(matchesCard(card(), { due: 'week', today })).toBe(false)
    expect(matchesCard(card(), { due: 'none', today })).toBe(true)
  })

  it('a range is about one date, or any of them; the row says which', () => {
    const sept = { from: at('2026-09-01', '00:00'), to: at('2026-10-01', '00:00') }
    expect(cardMoment(done, { when: 'done', ...sept })).toEqual({ at: done.doneAt, kind: 'done' })
    expect(cardMoment(done, { when: 'created', ...sept })).toBeNull()
    expect(cardMoment(card(), { when: 'done' })).toBeNull()
    // Anything in September: its latest date in the range (it was changed after it got done).
    expect(cardMoment(done, sept)).toEqual({ at: done.activeAt, kind: 'changed' })
    expect(cardMoment(done, { from: at('2026-07-01', '00:00'), to: at('2026-08-01', '00:00') })).toEqual({ at: done.createdAt, kind: 'created' })
    expect(matchesCard(done, { from: at('2026-08-01', '00:00'), to: at('2026-09-01', '00:00') })).toBe(false)
    // Moving a card to Done changes it at the same moment: it's "done", not "changed".
    const justDone = card({ kind: 'done', done: true, doneAt: at('2026-09-20'), activeAt: at('2026-09-20') })
    expect(cardMoment(justDone, sept)?.kind).toBe('done')
    // No range: when it was archived, else when it last changed.
    expect(cardMoment(card({ archived: true, archivedAt: at('2026-09-22') }), {})?.kind).toBe('archived')
    expect(cardMoment(card(), {})).toEqual({ at: card().activeAt, kind: 'changed' })
  })

  it('order: newest first, or by due date or priority with the cards that have none last', () => {
    const a = { at: 3, createdAt: 1, due: '2026-10-05', priority: 'low' as const }
    const b = { at: 2, createdAt: 3 }
    const c = { at: 1, createdAt: 2, due: '2026-10-01', priority: 'urgent' as const }
    const order = (sort: Parameters<typeof compareCards>[0]) => [a, b, c].sort(compareCards(sort))
    expect(order('recent')).toEqual([a, b, c])
    expect(order('created')).toEqual([b, c, a])
    expect(order('due')).toEqual([c, a, b])
    expect(order('priority')).toEqual([c, a, b])
  })

  it('named ranges move with the calendar; weeks start on Monday', () => {
    const now = new Date(2026, 9, 2, 15, 30) // Friday 2 October 2026
    const days = (r: { from: Date; to: Date }) => [r.from, r.to].map((d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`)
    expect(days(resolveRange('today', now))).toEqual(['2026-10-2', '2026-10-3'])
    expect(days(resolveRange('this-week', now))).toEqual(['2026-9-28', '2026-10-5'])
    expect(days(resolveRange('last-week', now))).toEqual(['2026-9-21', '2026-9-28'])
    expect(days(resolveRange('7d', now))).toEqual(['2026-9-26', '2026-10-3'])
    expect(days(resolveRange('90d', now))).toEqual(['2026-7-5', '2026-10-3'])
    expect(days(resolveRange('this-month', now))).toEqual(['2026-10-1', '2026-11-1'])
    expect(days(resolveRange('last-month', now))).toEqual(['2026-9-1', '2026-10-1'])
    expect(days(resolveRange('this-year', now))).toEqual(['2026-1-1', '2027-1-1'])
    // Days picked by hand: from the start of the first to the end of the last.
    const picked = resolveDays('2026-07-01', '2026-07-31')
    expect([picked.from?.getDate(), picked.to?.getMonth(), picked.to?.getDate()]).toEqual([1, 7, 1])
    expect(resolveDays(undefined, '2026-07-31').from).toBeUndefined()
  })

  it('headings for a list sorted by date', () => {
    const now = new Date(2026, 9, 2, 15, 30) // Friday 2 October 2026
    expect(periodOf(at('2026-10-02', '09:00'), now)).toBe('Today')
    expect(periodOf(at('2026-10-01'), now)).toBe('Yesterday')
    expect(periodOf(at('2026-09-28'), now)).toBe('Earlier this week')
    expect(periodOf(at('2026-09-23'), now)).toBe('Last week')
    expect(periodOf(at('2026-09-10'), now)).toBe('September 2026')
    expect(periodOf(at('2025-12-31'), now)).toBe('December 2025')
    expect(periodOf(at('2026-10-10'), new Date(2026, 9, 30))).toBe('Earlier this month')
    expect(periodOf(at('2026-10-03'), now)).toBe('Later')
  })
})
