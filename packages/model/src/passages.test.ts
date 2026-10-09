import { describe, expect, it } from 'vitest'
import { locate, PassageSchema, plainWords, quoteLine, squeeze, stillThere, tidyPassage } from './passages'

const TEXT = `## What we recommend

Renew the session when the page comes back into view. **Keep sessions for 30 days**, and ask for the password
again only before an email or a password is changed.

- Keep sessions short on shared computers.
- 📎session-flow.png shows the steps.

| Who | How long |
|---|---|
| Admins | 14 days |
| Everyone else | 30 days |`

/** The letters between two places, to say what was found. */
const found = (text: string, at: { start: number; end: number } | null) => (at ? squeeze(text).slice(at.start, at.end) : null)

describe('the words a comment is about', () => {
  it('are compared by their letters: spaces, line breaks and the file mark don’t count', () => {
    expect(squeeze('  Keep   sessions\nfor 30\tdays ')).toBe('Keepsessionsfor30days')
    expect(squeeze('📎session-flow.png shows')).toBe('session-flow.pngshows')
  })

  it('are found again in the text as it reads, laid out however it is', () => {
    const text = plainWords(TEXT)
    const p = tidyPassage({ quote: 'Keep sessions for 30 days,', before: 'comes back into view.', after: 'and ask for the password' })
    expect(found(text, locate(text, p))).toBe('Keepsessionsfor30days,')
    // The same words across a line break, and with other spacing, are the same words.
    expect(locate(text, { quote: 'ask for the password again only before', before: '', after: '' })).not.toBeNull()
    expect(locate(text, { quote: 'Keep  sessions for\n30 days', before: '', after: '' })).toEqual(
      locate(text, { quote: 'Keep sessions for 30 days', before: '', after: '' }),
    )
  })

  it('there twice, are the ones whose surroundings fit best', () => {
    const text = plainWords(TEXT)
    const first = locate(text, { quote: '30 days', before: 'Keep sessions for', after: ', and ask' })!
    const table = locate(text, { quote: '30 days', before: 'Everyone else', after: '' })!
    expect(first.start).toBeLessThan(table.start)
    expect(squeeze(text).slice(table.start - 12, table.start)).toBe('Everyoneelse')
    // Nothing to go by: the first of them.
    expect(locate(text, { quote: '30 days', before: '', after: '' })).toEqual(first)
    // They follow the words when the text around them moves.
    const moved = plainWords(`A new first paragraph.\n\n${TEXT}`)
    expect(
      squeeze(moved)
        .slice(locate(moved, { quote: '30 days', before: 'Everyone else', after: '' })!.start - 12)
        .startsWith('Everyoneelse30days'),
    ).toBe(true)
  })

  it('rewritten, aren’t found, and say so', () => {
    const p = { quote: 'Keep sessions for 30 days', before: '', after: '' }
    expect(stillThere(TEXT, p)).toBe(true)
    expect(stillThere(TEXT.replace('30 days**', '14 days**'), p)).toBe(false)
    expect(locate(plainWords(TEXT.replace('30 days**', '14 days**')), p)).toBeNull()
    // Marked up differently, they are the same words.
    expect(stillThere(TEXT.replace('**Keep sessions for 30 days**', 'Keep *sessions* for `30 days`'), p)).toBe(true)
    // Words across the bold, a list's marks and a table's bars.
    expect(stillThere(TEXT, { quote: 'into view. Keep sessions', before: '', after: '' })).toBe(true)
    expect(stillThere(TEXT, { quote: 'shared computers. session-flow.png shows', before: '', after: '' })).toBe(true)
    expect(stillThere(TEXT, { quote: 'Admins 14 days Everyone else', before: '', after: '' })).toBe(true)
    expect(stillThere('', p)).toBe(false)
  })

  it('are kept tidy, and no longer than is kept', () => {
    const p = tidyPassage({ quote: `  Keep\n\nsessions ${'x'.repeat(2000)}`, before: `${'a'.repeat(200)} end`, after: `start ${'b'.repeat(200)}` })
    expect(p.quote.startsWith('Keep sessions x')).toBe(true)
    expect([p.quote.length, p.before.length, p.after.length]).toEqual([1000, 80, 80])
    expect([p.before.endsWith(' end'), p.after.startsWith('start ')]).toEqual([true, true])
    // What a browser sends is checked: some words, and nothing odd in them.
    expect(PassageSchema.safeParse({ quote: 'Some words' }).data).toEqual({ quote: 'Some words', before: '', after: '' })
    expect(PassageSchema.safeParse({ quote: '   ' }).success).toBe(false)
    expect(PassageSchema.safeParse({ quote: 'a\u0000b' }).success).toBe(false)
    expect(PassageSchema.safeParse({ quote: 'x'.repeat(3000) }).success).toBe(false)
  })

  it('are said in a line: whole when short, else their beginning and their end', () => {
    expect(quoteLine('Keep sessions for 30 days')).toBe('Keep sessions for 30 days')
    const long = quoteLine('Renew the session when the page comes back into view. Keep sessions for 30 days, and ask for the password again', 60)
    expect(long.length).toBeLessThanOrEqual(60)
    expect([long.startsWith('Renew the session'), long.endsWith('password again'), long.includes(' … ')]).toEqual([true, true, true])
  })
})
