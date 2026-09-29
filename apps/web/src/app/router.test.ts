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
      ['#/forgot', { page: 'forgot' }],
      ['#/verify/v_tok', { page: 'verify', token: 'v_tok' }],
      ['#/reset/r-tok', { page: 'reset', token: 'r-tok' }],
    ]
    for (const [hash, route] of cases) {
      expect(parseRoute(hash)).toEqual(route)
      if (hash) expect(hrefFor(route)).toBe(hash)
    }
  })

  it('ignores an unknown tab rather than failing', () => {
    expect(parseRoute('#/b/abc/kanban?task=t')).toEqual({ page: 'board', id: 'abc', task: 't' })
  })
})
