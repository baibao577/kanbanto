import { describe, expect, it } from 'vitest'
import { dbErrorCode, loggable } from '../src/errors'

describe('errors in the logs', () => {
  it('a failed query is logged with the database’s reason, without its SQL and values', () => {
    const cause = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' })
    const failed = Object.assign(new Error('Failed query: insert into tasks … params: secret board text,ann@example.com'), {
      query: 'insert into tasks …',
      params: ['secret board text', 'ann@example.com'],
      cause,
    })
    const logged = JSON.stringify(loggable(failed))
    expect(logged).toContain('invalid byte sequence')
    expect(logged).not.toContain('secret board text')
    expect(logged).not.toContain('ann@example.com')
    expect(dbErrorCode(failed)).toBe('22021')
    // Other errors are logged as they are.
    const plain = new Error('something else')
    expect(loggable(plain)).toBe(plain)
    expect(dbErrorCode(plain)).toBeUndefined()
  })
})
