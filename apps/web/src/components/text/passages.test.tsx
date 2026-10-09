// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { locate, squeeze } from '@kanbanto/model/passages'
import { Markdown } from './Markdown'
import { lettersBefore, lettersOf, passageOf, placesOf, rangeOf } from './passages'

const TEXT = `## What we recommend

Renew the session when the page comes back into view. **Keep sessions for 30 days**, and ask for the password again
only before an email or a password is changed.

- Keep sessions short on shared computers.
- See 📎session-flow.png for the steps.

| Who | How long |
|---|---|
| Admins | 14 days |
| Everyone else | 30 days |`

/** The text as it is shown, in a page. */
const shown = (markdown = TEXT) => {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<Markdown text={markdown} />)
  document.body.replaceChildren(root)
  return root
}
/** The stretch of the page some words are on (the first place they are, inside one piece of text). */
const stretch = (root: HTMLElement, words: string) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const i = n.data.indexOf(words)
    if (i < 0) continue
    const range = document.createRange()
    range.setStart(n, i)
    range.setEnd(n, i + words.length)
    return range
  }
  throw new Error(`“${words}” isn’t shown`)
}

describe('the words comments are about, on the page', () => {
  it('the letters of what is shown are the letters of the text, each with its place', () => {
    const root = shown()
    const letters = lettersOf(root)
    expect(letters.text.startsWith('WhatwerecommendRenewthesession')).toBe(true)
    expect(letters.text).toContain('Keepsessionsfor30days,andask')
    // (A file's name is there; the mark it is written with isn't a letter.)
    expect(letters.text).toContain('Seesession-flow.pngforthesteps.')
    expect(letters.text.endsWith('Everyoneelse30days')).toBe(true)
    expect([letters.node.length, letters.offset.length]).toEqual([letters.text.length, letters.text.length])
    // Each letter is where it says: the page's own character at that place.
    for (const i of [0, 17, 60, letters.text.length - 1]) expect(letters.nodes[letters.node[i]].data[letters.offset[i]]).toBe(letters.text[i])
    // What isn't the text (someone else's cursor in an editor) isn't counted.
    const caret = document.createElement('span')
    caret.className = 'collaboration-carets__caret'
    caret.textContent = 'Ben Ortiz'
    root.querySelector('p')!.prepend(caret)
    expect(lettersOf(root).text).toBe(letters.text)
  })

  it('a passage is found on the page, across bold, lines and table cells, and marked from its first letter to its last', () => {
    const root = shown()
    const letters = lettersOf(root)
    const said = (quote: string, before = '', after = '') => {
      const at = locate(letters.text, { quote, before, after })
      return at ? rangeOf(root, letters, at.start, at.end)!.toString() : null
    }
    expect(said('Keep sessions for 30 days')).toBe('Keep sessions for 30 days')
    // Across the end of the bold, and from one line of a list to the next.
    expect(said('for 30 days, and ask')).toBe('for 30 days, and ask')
    expect(squeeze(said('shared computers. See')!)).toBe('sharedcomputers.See')
    // The same words twice: the ones whose surroundings fit.
    const table = locate(letters.text, { quote: '30 days', before: 'Everyone else', after: '' })!
    expect(rangeOf(root, letters, table.start, table.end)!.startContainer.parentElement!.tagName).toBe('TD')
    expect(said('Keep sessions for 90 days')).toBeNull()
    expect(
      placesOf(letters, [
        { key: 'a', passage: { quote: 'Admins', before: '', after: '' } },
        { key: 'b', passage: { quote: 'Nobody', before: '', after: '' } },
      ]).has('b'),
    ).toBe(false)
    expect(rangeOf(root, letters, 5, 5)).toBeNull()
  })

  it('words selected on the page become a passage, with what stands around them', () => {
    const root = shown()
    const letters = lettersOf(root)
    const range = stretch(root, 'ask for the password')
    const picked = passageOf(root, letters, range, '  ask for the\npassword ')!
    expect(picked.passage.quote).toBe('ask for the password')
    expect(picked.passage.before.endsWith('Keepsessionsfor30days,and')).toBe(true)
    expect(picked.passage.after.startsWith('againonlybefore')).toBe(true)
    expect(letters.text.slice(picked.start, picked.end)).toBe('askforthepassword')
    // The same passage is found again where it was picked.
    expect(locate(letters.text, picked.passage)).toEqual({ start: picked.start, end: picked.end })
    // A selection from an element's edge (a whole paragraph, as a triple click gives) counts the same.
    const whole = document.createRange()
    whole.selectNodeContents(root.querySelector('p')!)
    const para = passageOf(root, letters, whole, root.querySelector('p')!.textContent!)!
    expect(letters.text.slice(para.start, para.start + 8)).toBe('Renewthe')
    expect(letters.text.slice(para.end - 10, para.end)).toBe('ischanged.')
    expect(lettersBefore(root, letters, root, 0)).toBe(0)
    expect(lettersBefore(root, letters, root, root.childNodes.length)).toBe(letters.text.length)
    // Nothing of the text selected: no passage.
    const nothing = document.createRange()
    nothing.setStart(range.startContainer, range.startOffset)
    nothing.collapse(true)
    expect(passageOf(root, letters, nothing, '')).toBeNull()
    const outside = document.createRange()
    outside.selectNodeContents(document.body.appendChild(document.createElement('p')))
    expect(passageOf(root, letters, outside, 'x')).toBeNull()
  })

  it('a passage moves with its words when the text around them changes, and is gone when they are rewritten', () => {
    const before = shown()
    const picked = passageOf(before, lettersOf(before), stretch(before, 'Keep sessions for 30 days'), 'Keep sessions for 30 days')!
    const moved = shown(`A new opening paragraph, with 30 days in it.\n\n${TEXT}`)
    const letters = lettersOf(moved)
    const at = locate(letters.text, picked.passage)!
    expect(at.start).toBeGreaterThan(picked.start)
    expect(rangeOf(moved, letters, at.start, at.end)!.toString()).toBe('Keep sessions for 30 days')
    const rewritten = shown(TEXT.replace('for 30 days', 'for two weeks'))
    expect(locate(lettersOf(rewritten).text, picked.passage)).toBeNull()
  })
})
