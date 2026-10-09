// @vitest-environment happy-dom
import { Fragment, Slice } from '@tiptap/pm/model'
import { Editor, EditorContent } from '@tiptap/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { plainWords, squeeze } from '@kanbanto/model/passages'
import { alignColumns, columnAlign, textElements, tidyPastedTables } from './elements'
import { Markdown } from './Markdown'
import { forEditor, tidyMarkdown, toggleTask } from './mdText'
import { lettersOf } from './passages'

/** The editor as the app makes it, with a text in it as the app puts one in. */
const editing = (md: string) => {
  const el = document.body.appendChild(document.createElement('div'))
  return new Editor({ element: el, extensions: textElements(), content: forEditor(md), contentType: 'markdown' })
}
/** The editor on a page, drawn as the app draws it (a callout is drawn by React). */
const onPage = async (ed: Editor) => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root.render(<EditorContent editor={ed} />))
  return () => act(async () => root.unmount())
}
/** A text as the editor writes it back, having only been opened. */
const written = (md: string) => {
  const ed = editing(md)
  const out = tidyMarkdown(ed.getMarkdown())
  ed.destroy()
  return out
}
const kinds = (md: string) => {
  const ed = editing(md)
  const out = ed.getJSON().content!.map((n) => (n.type === 'callout' ? `callout:${n.attrs?.kind}` : n.type))
  ed.destroy()
  return out
}
const html = (md: string) => renderToStaticMarkup(<Markdown text={md} />)
/** The text as it is shown, in a page. */
const shown = (md: string) => {
  const root = document.createElement('div')
  root.innerHTML = html(md)
  document.body.replaceChildren(root)
  return root
}
/** Puts the cursor in the cell that holds these words. */
const into = (ed: Editor, words: string) => {
  let at = -1
  ed.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text?.includes(words)) at = pos + 1
  })
  expect(at).toBeGreaterThan(0)
  ed.commands.setTextSelection(at)
}

const WARNING = '> [!WARNING]\n> Switch the power off at the board first,\n> and test the socket.'

describe('callouts', () => {
  it('a quote that starts with a callout’s mark is a callout, and is written back as it was', () => {
    expect(kinds(`${WARNING}\n\nAfter.`)).toEqual(['callout:warning', 'paragraph'])
    expect(written(`${WARNING}\n\nAfter.`)).toBe(`${WARNING}\n\nAfter.`)
    // Any text can be in one: paragraphs, bold, a list, a checklist.
    const tip = '> [!TIP]\n> One.\n>\n> Two with **bold**.\n>\n> - a\n> - b\n>\n> - [ ] to do'
    expect(kinds(tip)).toEqual(['callout:tip'])
    expect(written(tip)).toBe(tip)
    // The five kinds, however their mark is cased; a blank line after the mark is no part of it.
    for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) {
      expect(kinds(`> [!${kind}]\n> Text.`)).toEqual([`callout:${kind}`])
      expect(written(`> [!${kind}]\n>\n> Text.`)).toBe(`> [!${kind.toUpperCase()}]\n> Text.`)
    }
    // Inside a list, as part of an item.
    expect(written('- item\n\n  > [!NOTE]\n  > in a list')).toBe('- item\n  > [!NOTE]\n  > in a list')
  })

  it('an ordinary quote stays one, and so does a quote that only looks like a callout', () => {
    expect(kinds('> Just a quote.\n> Second line.')).toEqual(['blockquote'])
    expect(written('> Just a quote.\n> Second line.\n>\n> And a second paragraph.')).toBe(
      '> Just a quote.\n> Second line.\n>\n> And a second paragraph.',
    )
    // Words after the mark on its line, or a kind there isn't: GitHub shows a quote too.
    expect(kinds('> [!NOTE] on the same line')).toEqual(['blockquote'])
    expect(kinds('> [!HELLO]\n> text')).toEqual(['blockquote'])
    expect(kinds('> Text first.\n> [!NOTE]')).toEqual(['blockquote'])
  })

  it('one whose mark an older editor wrote with backslashes is still a callout, and is written back clean', () => {
    const broken = '> \\[!NOTE\\]\n> Saved by a page that didn’t know callouts.'
    expect(kinds(broken)).toEqual(['callout:note'])
    expect(written(broken)).toBe('> [!NOTE]\n> Saved by a page that didn’t know callouts.')
    expect(html(broken)).toContain('data-callout="note"')
  })

  it('made, changed and undone while writing', () => {
    const ed = editing('Photograph the wiring first.')
    ed.chain().focus('end').wrapIn('callout', { kind: 'tip' }).run()
    expect(tidyMarkdown(ed.getMarkdown())).toBe('> [!TIP]\n> Photograph the wiring first.')
    ed.commands.updateAttributes('callout', { kind: 'caution' })
    expect(tidyMarkdown(ed.getMarkdown())).toBe('> [!CAUTION]\n> Photograph the wiring first.')
    ed.commands.lift('callout')
    expect(tidyMarkdown(ed.getMarkdown())).toBe('Photograph the wiring first.')
    // An empty one is its mark alone.
    ed.chain().clearContent().wrapIn('callout', { kind: 'note' }).run()
    expect(tidyMarkdown(ed.getMarkdown())).toBe('> [!NOTE]')
    ed.destroy()
  })

  it('shown as a box of its kind, with the text’s own letters and no others', async () => {
    const page = html(`${WARNING}\n\n> A quote.`)
    expect(page).toContain('<div class="md-callout" data-callout="warning">')
    expect(page).toContain('data-label="Warning"')
    expect(page).toContain('<blockquote><p>A quote.</p></blockquote>')
    expect(page).not.toContain('[!WARNING]')
    // What is shown, what is written and what is saved hold the same letters: the mark and the kind's name are in
    // none of them. (A comment's words are found, and a click puts the cursor on its word, by the letters.)
    const text = `Before.\n\n${WARNING}\n\n> [!TIP]\n> Photograph it. See 📎wiring.png\n\nAfter.`
    const letters = lettersOf(shown(text)).text
    expect(letters).toBe('Before.Switchthepoweroffattheboardfirst,andtestthesocket.Photographit.Seewiring.pngAfter.')
    expect(squeeze(plainWords(text))).toBe(letters)
    expect(squeeze(plainWords(text.replaceAll('[!', '\\[!').replaceAll(']\n', '\\]\n')))).toBe(letters)
    const ed = editing(text)
    const off = await onPage(ed)
    expect(ed.view.dom.querySelector('.md-callout[data-callout="warning"] .md-callout-body')?.getAttribute('data-label')).toBe('Warning')
    expect(lettersOf(ed.view.dom).text).toBe(letters)
    await off()
    ed.destroy()
  })

  it('a checklist in one is ticked like any other', () => {
    const text = '- [ ] outside\n\n> [!NOTE]\n> - [ ] first inside\n> - [x] second inside'
    expect(html(text).match(/type="checkbox"/g)).toHaveLength(3)
    expect(toggleTask(text, 1)).toBe('- [ ] outside\n\n> [!NOTE]\n> - [x] first inside\n> - [x] second inside')
    expect(toggleTask(text, 2)).toBe('- [ ] outside\n\n> [!NOTE]\n> - [ ] first inside\n> - [ ] second inside')
  })
})

const RATES = '| Work | Rate | Notes |\n| --- | --- | --- |\n| Kitchen fit | $420 | Worktops not included. |\n| Rewire | $650 | |'

describe('tables', () => {
  it('a column is lined up left, centre or right, and the Markdown says so', () => {
    const ed = editing(RATES)
    into(ed, '$420')
    expect(columnAlign(ed.state)).toBe('left')
    ed.view.dispatch(alignColumns(ed.state, 'right')!)
    expect(columnAlign(ed.state)).toBe('right')
    const lines = () => tidyMarkdown(ed.getMarkdown()).split('\n')
    expect(lines()[1]).toMatch(/^\| -+ \| -+: \| -+ \|$/)
    // Every cell of the column, its heading too: written and read, the column lines up the same way.
    const aligned: unknown[] = []
    ed.state.doc.descendants((n) => {
      if (n.type.name === 'tableCell' || n.type.name === 'tableHeader') aligned.push(n.attrs.align)
    })
    expect(aligned).toEqual([null, 'right', null, null, 'right', null, null, 'right', null])
    expect(html(tidyMarkdown(ed.getMarkdown()))).toContain('<th style="text-align:right">Rate</th>')
    ed.view.dispatch(alignColumns(ed.state, 'center')!)
    expect(lines()[1]).toMatch(/^\| -+ \| :-+: \| -+ \|$/)
    // Left is how a column lines up by itself: nothing is written for it.
    ed.view.dispatch(alignColumns(ed.state, 'left')!)
    expect(lines()[1]).toMatch(/^\| -+ \| -+ \| -+ \|$/)
    // Outside a table there is nothing to line up.
    ed.commands.setContent('Words.')
    expect([columnAlign(ed.state), alignColumns(ed.state, 'right')]).toEqual([null, null])
    ed.destroy()
    // A table that came lined up stays so.
    const came = '| Item | Cost |\n| :--- | ---: |\n| Tiles | 90 |'
    expect(written(came).split('\n')[1]).toMatch(/^\| :-+ \| -+: \|$/)
  })

  it('a second line in a cell is written as a line break, read as one and shown as one', () => {
    const ed = editing(RATES)
    into(ed, 'Worktops not included.')
    ed.chain().focus().setTextSelection(ed.state.selection.$from.end()).setHardBreak().insertContent('Ask for the list.').run()
    const saved = tidyMarkdown(ed.getMarkdown())
    ed.destroy()
    expect(saved).toContain('| Worktops not included.<br>Ask for the list. |')
    // Opened again, it is a line break again (not the letters "<br>"), and nothing changes.
    expect(written(saved)).toBe(saved)
    const again = editing(saved)
    expect(again.view.dom.textContent).not.toContain('<br>')
    again.destroy()
    expect(html(saved)).toContain('<td>Worktops not included.<br/>Ask for the list.</td>')
    // The letters are the text's own.
    expect(lettersOf(shown(saved)).text).toBe(squeeze(plainWords(saved)))
    expect(squeeze(plainWords(saved))).toContain('Worktopsnotincluded.Askforthelist.')
  })

  it('"<br>" typed as words stays words', () => {
    const ed = editing('')
    ed.chain().focus().insertContent({ type: 'text', text: 'Use <br> for a line break, and <b> for bold.' }).run()
    const saved = tidyMarkdown(ed.getMarkdown())
    ed.destroy()
    expect(saved).toBe('Use &lt;br&gt; for a line break, and <b> for bold.')
    expect(written(saved)).toBe(saved)
    expect(html(saved)).toBe('<div class="md"><p>Use &lt;br&gt; for a line break, and &lt;b&gt; for bold.</p></div>')
    expect(lettersOf(shown(saved)).text).toBe(squeeze(plainWords(saved)))
    // In a line of text, the tag is the line break it means.
    expect(html('One<br>two')).toBe('<div class="md"><p>One<br/>two</p></div>')
    expect(written('One<br>two')).toBe('One  \ntwo')
    // Any other HTML is still shown as the text it is.
    expect(html('A <b>bold</b> <script>alert(1)</script> claim')).not.toContain('<script>')
  })

  it('a table pasted whole gets its first row as its heading, and its columns lined up one way', () => {
    const ed = editing('')
    const cell = (text: string, attrs = {}, marks?: { type: string }[]) => ({
      type: 'tableCell',
      attrs,
      content: [{ type: 'paragraph', content: text ? [{ type: 'text', text, ...(marks && { marks }) }] : [] }],
    })
    const row = (...cells: object[]) => ({ type: 'tableRow', content: cells })
    // What a spreadsheet gives: no heading cells, a heading row in bold, numbers lined up right.
    const sheet = ed.schema.nodeFromJSON({
      type: 'table',
      content: [
        row(cell('Work', {}, [{ type: 'bold' }]), cell('Rate', {}, [{ type: 'bold' }])),
        row(cell('Kitchen fit'), cell('420', { align: 'right' })),
        row(cell('Rewire'), cell('650', { align: 'right' })),
      ],
    })
    const pasted = tidyPastedTables(new Slice(Fragment.from(sheet), 0, 0))
    ed.view.dispatch(ed.state.tr.replaceSelection(pasted))
    expect(
      tidyMarkdown(ed.getMarkdown())
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').replace(/-+/g, '-')),
    ).toEqual(['| Work | Rate |', '| - | -: |', '| Kitchen fit | 420 |', '| Rewire | 650 |'])
    // A table that has its heading is left as it is, and so is a part of a table (some cells, to go into another).
    const headed = new Slice(Fragment.from(ed.state.doc.firstChild!), 0, 0)
    expect(tidyPastedTables(headed).content.firstChild!.eq(headed.content.firstChild!)).toBe(true)
    const part = new Slice(Fragment.from(sheet), 3, 3)
    expect(tidyPastedTables(part)).toBe(part)
    ed.destroy()
  })
})

describe('what the editor doesn’t know stays as it was', () => {
  it('footnotes keep their marks', () => {
    const text = 'A claim.[^1] Another.[^note]\n\n[^1]: The source.\n[^note]: A longer note.'
    expect(written(text)).toBe(text)
  })
})
