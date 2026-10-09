// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { textElements } from './elements'
import { FoldWhileWriting, sectionsOf } from './foldEditing'
import { foldsOf, toggleFold } from './folds'
import { forEditor } from './mdText'
import { lettersOf } from './passages'

const TEXT =
  'Before any heading.\n\n## Problem\n\nTwo launches went wrong.\n\n### Detail\n\nThe old prices.\n\n## What we do\n\n1. Check\n2. Launch\n\n## References\n\nThe checklist.'
const CARD = 'card-1'
const writing = () => {
  const element = document.body.appendChild(document.createElement('div'))
  return new Editor({
    element,
    extensions: [...textElements(), FoldWhileWriting.configure({ card: CARD })],
    content: forEditor(TEXT),
    contentType: 'markdown',
  })
}
/** (What is folded is drawn a moment after it changes.) */
const settled = () => new Promise((done) => setTimeout(done, 0))
const away = (ed: Editor) => [...ed.view.dom.querySelectorAll('.md-folded')].map((e) => `${e.getAttribute('data-folds')}: ${e.textContent}`)
const place = (ed: Editor, words: string, after = false) => {
  let at = -1
  ed.state.doc.descendants((n, pos) => {
    const i = n.isText ? (n.text ?? '').indexOf(words) : -1
    if (at < 0 && i >= 0) at = pos + i + (after ? words.length : 0)
  })
  expect(at).toBeGreaterThan(0)
  return at
}

describe('headings fold what is under them while writing too', () => {
  beforeEach(() => {
    for (const slug of [...foldsOf(CARD)]) toggleFold(CARD, slug)
  })

  it('the same sections as when the text is read, with the text whole underneath', async () => {
    const ed = writing()
    const whole = lettersOf(ed.view.dom).text
    expect(ed.view.dom.querySelectorAll('.md-fold')).toHaveLength(4)
    expect(away(ed)).toEqual([])
    toggleFold(CARD, 'problem')
    await settled()
    expect(away(ed)).toEqual(['0: Two launches went wrong.', '0: Detail', '0: The old prices.'])
    const heading = ed.view.dom.querySelector('h2.md-section')!
    expect([heading.getAttribute('data-folded'), heading.querySelector('.md-fold')!.getAttribute('aria-expanded')]).toEqual(['8 words', 'false'])
    // Nothing of the text is touched: its letters, and what it is saved as.
    expect(lettersOf(ed.view.dom).text).toBe(whole)
    expect(ed.getMarkdown()).toContain('Two launches went wrong.')
    // The arrow itself folds and unfolds.
    ;(ed.view.dom.querySelector('h2.md-section .md-fold') as HTMLElement).click()
    await settled()
    expect([away(ed), [...foldsOf(CARD)]]).toEqual([[], []])
    // What `sectionsOf` says for a smaller heading folded inside a folded one.
    const { parts } = sectionsOf(ed.state.doc, new Set(['problem', 'detail']))
    expect(parts.map((p) => p.slugs.join('+'))).toEqual(['problem', 'problem', 'problem+detail'])
    ed.destroy()
  })

  it('the cursor is never in what is put away: the section it gets into opens', async () => {
    const ed = writing()
    toggleFold(CARD, 'what-we-do')
    await settled()
    expect(away(ed)).toEqual(['2: CheckLaunch'])
    // Enter at the end of a folded heading: the new line is under it, and is where the cursor is.
    ed.chain()
      .focus()
      .setTextSelection(place(ed, 'What we do', true))
      .splitBlock()
      .run()
    // (At once: the line the cursor is on is never put away, not for a moment.)
    expect(away(ed)).toEqual([])
    ed.commands.insertContent('A new first line.')
    await settled()
    expect([away(ed), [...foldsOf(CARD)]]).toEqual([[], []])
    // A jump into a folded section, the same.
    toggleFold(CARD, 'problem')
    await settled()
    expect(away(ed)).toHaveLength(3)
    ed.commands.setTextSelection(place(ed, 'old prices'))
    await settled()
    expect(away(ed)).toEqual([])
    // Its own arrow folds the section the cursor is in: the cursor goes to the end of the heading.
    ;(ed.view.dom.querySelector('h2.md-section .md-fold') as HTMLElement).click()
    await settled()
    expect(away(ed)).toHaveLength(3)
    const { $anchor } = ed.state.selection
    expect([$anchor.parent.textContent, $anchor.parentOffset]).toEqual(['Problem', 7])
    // A stretch selected across a folded section leaves it folded.
    ed.commands.setTextSelection({ from: place(ed, 'Before any'), to: place(ed, 'A new first') })
    await settled()
    expect(away(ed)).toHaveLength(3)
    ed.destroy()
  })

  it('a folded heading that is retyped stays folded', async () => {
    const ed = writing()
    toggleFold(CARD, 'references')
    await settled()
    expect(away(ed)).toEqual(['3: The checklist.'])
    ed.chain()
      .focus()
      .setTextSelection(place(ed, 'References', true))
      .insertContent(' and links')
      .run()
    await settled()
    expect([...foldsOf(CARD)]).toEqual(['references-and-links'])
    expect(away(ed)).toEqual(['3: The checklist.'])
    ed.destroy()
  })
})
