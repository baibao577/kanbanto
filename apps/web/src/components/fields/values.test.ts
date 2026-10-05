import { describe, expect, it } from 'vitest'
import { linkOf } from './values'

describe('a text value shown as a link', () => {
  it('opens web addresses, emails and phone numbers, and nothing else', () => {
    expect(linkOf({ format: 'link' }, 'kanbanto.com/guides')).toBe('https://kanbanto.com/guides')
    expect(linkOf({ format: 'link' }, 'http://example.com')).toBe('http://example.com/')
    expect(linkOf({ format: 'link' }, 'javascript:alert(1)')).toBeNull()
    expect(linkOf({ format: 'link' }, 'just words')).toBeNull()
    expect(linkOf({ format: 'email' }, 'ann@example.com')).toBe('mailto:ann@example.com')
    expect(linkOf({ format: 'email' }, 'ann at example')).toBeNull()
    expect(linkOf({ format: 'phone' }, '+66 (0)81 234-5678')).toBe('tel:+660812345678')
    expect(linkOf({ format: 'phone' }, 'call me')).toBeNull()
    expect(linkOf({}, 'kanbanto.com')).toBeNull()
  })
})
