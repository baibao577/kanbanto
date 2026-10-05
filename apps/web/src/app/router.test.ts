import { describe, expect, it } from 'vitest'
import { hrefFor, parseRoute, type Route } from './router'

describe('router', () => {
  it('reads and writes board addresses', () => {
    const cases: [string, Route][] = [
      ['#/', { page: 'home' }],
      ['', { page: 'home' }],
      ['#/b/abc', { page: 'board', id: 'abc' }],
      ['#/b/abc/outline', { page: 'board', id: 'abc', layout: 'outline' }],
      ['#/b/abc/timeline?focus=t1', { page: 'board', id: 'abc', layout: 'timeline', focus: 't1' }],
      ['#/b/abc/board?focus=t1&task=t2', { page: 'board', id: 'abc', layout: 'board', focus: 't1', task: 't2' }],
      ['#/join/tok_1-x', { page: 'join', token: 'tok_1-x' }],
      ['#/signin', { page: 'signin' }],
      ['#/signup?next=%23%2Fjoin%2Fabc', { page: 'signup', next: '#/join/abc' }],
      ['#/admin', { page: 'admin' }],
      ['#/admin/storage', { page: 'admin', section: 'storage' }],
      ['#/account', { page: 'account' }],
      ['#/account/password', { page: 'account', section: 'password' }],
      ['#/account/calendar?problem=denied', { page: 'account', section: 'calendar', problem: 'denied' }],
      ['#/forgot', { page: 'forgot' }],
      ['#/w/w-1', { page: 'workspace', id: 'w-1' }],
      ['#/w/w-1/planning', { page: 'workspace', id: 'w-1', section: 'planning' }],
      ['#/w/w-1/planning?by=person&zoom=days', { page: 'workspace', id: 'w-1', section: 'planning', by: 'person', zoom: 'days' }],
      ['#/w/w-1/planning?zoom=months', { page: 'workspace', id: 'w-1', section: 'planning', zoom: 'months' }],
      ['#/authorize?client_id=c&state=s', { page: 'authorize', query: 'client_id=c&state=s' }],
      ['#/cards', { page: 'cards', state: 'active' }],
      ['#/time', { page: 'time' }],
      ['#/time?week=2026-09-28', { page: 'time', week: '2026-09-28' }],
      ['#/cards?state=archived&board=b1&q=old+idea&completed=yes', { page: 'cards', state: 'archived', board: 'b1', q: 'old idea', completed: true }],
      ['#/cards?state=all&assignee=me&when=done&range=this-week', { page: 'cards', state: 'all', assignee: 'me', when: 'done', range: 'this-week' }],
      [
        '#/cards?place=personal&kind=backlog%2Ctodo&priority=urgent%2Cnone&label=Bug&due=overdue&from=2026-07-01&to=2026-07-31&parents=hide&following=yes&sort=due',
        {
          page: 'cards',
          state: 'active',
          place: 'personal',
          kinds: ['backlog', 'todo'],
          priorities: ['urgent', 'none'],
          label: 'Bug',
          due: 'overdue',
          from: '2026-07-01',
          to: '2026-07-31',
          leaves: true,
          following: true,
          sort: 'due',
        },
      ],
      ['#/cards?field=f1&fv=o1%2C-', { page: 'cards', state: 'active', field: 'f1', fv: 'o1,-' }],
      ['#/cards?field=f1', { page: 'cards', state: 'active', field: 'f1' }],
      ['#/verify/v_tok', { page: 'verify', token: 'v_tok' }],
      ['#/reset/r-tok', { page: 'reset', token: 'r-tok' }],
    ]
    for (const [hash, route] of cases) {
      expect(parseRoute(hash)).toEqual(route)
      if (hash) expect(hrefFor(route)).toBe(hash)
    }
  })

  it('a search address with something it doesn’t know is read without it', () => {
    expect(parseRoute('#/cards?state=nope&when=any&range=fortnight&from=July&kind=doing,zzz&sort=recent')).toEqual({
      page: 'cards',
      state: 'active',
      kinds: ['doing'],
    })
    // What a field has to be means nothing without the field.
    expect(parseRoute('#/cards?fv=yes')).toEqual({ page: 'cards', state: 'active' })
    // A named range wins over days.
    expect(parseRoute('#/cards?range=7d&from=2026-07-01')).toEqual({ page: 'cards', state: 'active', range: '7d' })
  })

  it('ignores an unknown tab rather than failing', () => {
    expect(parseRoute('#/b/abc/kanban?task=t')).toEqual({ page: 'board', id: 'abc', task: 't' })
  })

  it('a workspace address with something it doesn’t know opens its people', () => {
    expect(parseRoute('#/w/w-1/people')).toEqual({ page: 'workspace', id: 'w-1' })
    expect(parseRoute('#/w/w-1/zzz?by=person')).toEqual({ page: 'workspace', id: 'w-1' })
    expect(parseRoute('#/w/w-1/planning?by=team&zoom=hours')).toEqual({ page: 'workspace', id: 'w-1', section: 'planning' })
    // Its fields, and your own.
    expect(parseRoute('#/w/w-1/fields')).toEqual({ page: 'workspace', id: 'w-1', section: 'fields' })
    expect(hrefFor({ page: 'workspace', id: 'w-1', section: 'fields' })).toBe('#/w/w-1/fields')
    expect(parseRoute('#/account/fields')).toEqual({ page: 'account', section: 'fields' })
  })
})
