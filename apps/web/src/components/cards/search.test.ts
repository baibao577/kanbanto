import { describe, expect, it } from 'vitest'
import { parseRoute, type CardsRoute } from '@/app/router'
import { cardsQuery, isFiltered, momentWords, QUICK, quickOf, statusOf, whenWords, withStatus } from './search'

describe('the Search cards page', () => {
  it('asks the server with moments for a named range or picked days', () => {
    const now = new Date(2026, 9, 2, 15, 30) // Friday 2 October 2026
    const q = new URLSearchParams(cardsQuery({ state: 'all', assignee: 'me', when: 'done', range: 'this-week' }, { now }))
    expect(q.get('state')).toBe('all')
    expect(q.get('from')).toBe(new Date(2026, 8, 28).toISOString())
    expect(q.get('to')).toBe(new Date(2026, 9, 5).toISOString())
    const picked = new URLSearchParams(
      cardsQuery({ state: 'active', from: '2026-07-01', to: '2026-07-31', completed: false, leaves: true }, { offset: 50 }),
    )
    expect(picked.get('to')).toBe(new Date(2026, 7, 1).toISOString())
    expect([picked.get('completed'), picked.get('parents'), picked.get('offset')]).toEqual(['false', 'hide', '50'])
    expect(cardsQuery({ state: 'active' })).toBe('state=active')
    // One of the boards' own fields, and what it has to be.
    expect(cardsQuery({ state: 'active', field: 'f1', fv: '10..200' })).toBe('state=active&field=f1&fv=10..200')
    expect(cardsQuery({ state: 'active', fv: 'yes' })).toBe('state=active')
  })

  it('knows a quick search whatever board or words it has, and when anything is narrowing it', () => {
    for (const x of QUICK) expect(quickOf({ ...x.search, board: 'b1', q: 'logo', sort: 'due' })).toBe(x.id)
    // (The page's address is a search too.)
    expect(quickOf(parseRoute('#/cards?completed=no&assignee=me') as CardsRoute)).toBe('mine')
    expect(isFiltered(parseRoute('#/cards?q=logo') as CardsRoute)).toBe(false)
    expect(quickOf({ state: 'active', assignee: 'me' })).toBeUndefined()
    expect(isFiltered({ state: 'active', board: 'b1', q: 'logo' })).toBe(false)
    expect(isFiltered({ state: 'all' })).toBe(true)
    expect(isFiltered({ state: 'active', field: 'f1', fv: 'yes' })).toBe(true)
    expect(quickOf({ state: 'active', assignee: 'me', completed: false, field: 'f1' })).toBeUndefined()
  })

  it('status is one choice over done-or-not and kinds of list', () => {
    for (const s of ['any', 'open', 'todo', 'doing', 'done'] as const) expect(statusOf({ state: 'active', ...withStatus(s) })).toBe(s)
    expect(withStatus('todo')).toEqual({ completed: undefined, kinds: ['backlog', 'todo'] })
  })

  it('says the range and the date in words', () => {
    expect(whenWords({ state: 'active' })).toBe('Any time')
    expect(whenWords({ state: 'all', when: 'done', range: 'this-week' })).toBe('Done · This week')
    expect(whenWords({ state: 'active', when: 'created' })).toBe('Made, any time')
    expect(whenWords({ state: 'active', from: '2025-07-01', to: '2025-07-31' })).toBe('1 Jul 2025 – 31 Jul 2025')
    const now = new Date(2026, 9, 2, 15, 30).getTime()
    expect(momentWords('done', new Date(2026, 9, 2, 15, 25).toISOString(), now)).toBe('done 5m ago')
    expect(momentWords('archived', new Date(2026, 8, 30, 15, 0).toISOString(), now)).toBe('archived 2d ago')
    expect(momentWords('created', new Date(2026, 2, 12).toISOString(), now)).toBe('made 12 Mar')
    expect(momentWords('changed', new Date(2025, 2, 12).toISOString(), now)).toBe('changed 12 Mar 2025')
  })
})
