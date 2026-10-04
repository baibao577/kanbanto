// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown as MarkdownExt } from '@tiptap/markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AttachmentView } from '@kanbanto/model/api'
import { clearDraft, pruneDrafts, readDraft, writeDraft } from '@/data/drafts'
import { counted, posAt } from './caret'
import { Markdown } from './Markdown'
import { countWords, forEditor, headingsOf, looksLikeMarkdown, tidyMarkdown, toggleTask } from './mdText'

const roundTrip = (md: string) => {
  const ed = new Editor({
    extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), TableKit, MarkdownExt],
    content: md,
    contentType: 'markdown',
  })
  const out = tidyMarkdown(ed.getMarkdown())
  ed.destroy()
  return out
}

describe('the editor keeps what people and assistants wrote', () => {
  it('leaves file names, mentions, plain lines and & alone', () => {
    expect(roundTrip('Line one\nline two\n\nSee 📎plan_v2.pdf, ask @Ann Lee & Bob')).toBe(
      'Line one\nline two\n\nSee 📎plan_v2.pdf, ask @Ann Lee & Bob',
    )
  })
  it('keeps text that looks like HTML as text', () => {
    expect(roundTrip(forEditor('Pasting <script>alert(1)</script> shows as text; a < b\n\n```\n<div>\n```'))).toBe(
      'Pasting <script>alert(1)</script> shows as text; a < b\n\n```\n<div>\n```',
    )
  })
  it('keeps headings, checklists, lists, code, quotes and tables', () => {
    const md = '## Plan\n\n- [ ] first\n- [x] second\n\n1. one\n2. two\n\n```ts\nconst x = 1\n```\n\n> quote'
    expect(roundTrip(md)).toBe(md)
    expect(roundTrip('| a | b |\n|---|---|\n| 1 | 2 |')).toMatch(/^\| a +\| b +\|\n\| -+ \| -+ \|\n\| 1 +\| 2 +\|$/)
  })
})

describe('checklists', () => {
  it('ticks the nth item, skipping code blocks', () => {
    const md = '- [ ] a\n```\n- [ ] not me\n```\n- [x] b\n1. [ ] c'
    expect(toggleTask(md, 0)).toBe(md.replace('- [ ] a', '- [x] a'))
    expect(toggleTask(md, 1)).toBe(md.replace('- [x] b', '- [ ] b'))
    expect(toggleTask(md, 2)).toBe(md.replace('1. [ ] c', '1. [x] c'))
    expect(toggleTask(md, 3)).toBe(md)
  })
})

describe('showing Markdown', () => {
  const file = { id: 'f1', name: 'plan v2.pdf', url: '/api/attachments/f1' } as AttachmentView
  const html = (text: string, props = {}) => renderToStaticMarkup(<Markdown text={text} {...props} />)

  it('formats it, with files and mentions', () => {
    const out = html('## Hi\n\n**Bold** and 📎plan v2.pdf for @Ann\n\n- [x] done', { files: [file], mentions: [{ name: 'Ann' }] })
    expect(out).toContain('<h3>Hi</h3>')
    expect(out).toContain('<strong>Bold</strong>')
    expect(out).toContain('href="/api/attachments/f1"')
    expect(out).toContain('>@Ann</span>')
    expect(out).toMatch(/<input type="checkbox" disabled="" aria-label="Done" checked=""/)
  })
  it('shows checklist items spaced apart without their [x]', () => {
    expect(html('- [x] one\n\n- [ ] two')).not.toMatch(/\[x\]|\[ \]/)
  })
  it('never runs HTML or script links', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) ![p](https://evil.example/t.png)')
    expect(out).not.toMatch(/<script|<img|javascript:/)
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('href="https://evil.example/t.png"')
  })
  it('lists headings for the contents', () => {
    expect(headingsOf('# One\n\ntext\n\n## Two **b**')).toEqual([
      { id: 'h-0', depth: 1, text: 'One' },
      { id: 'h-1', depth: 2, text: 'Two b' },
    ])
  })
})

describe('writing', () => {
  const editor = (md: string) =>
    new Editor({
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), TableKit, MarkdownExt],
      content: md,
      contentType: 'markdown',
    })

  it('tells pasted Markdown from plain words', () => {
    for (const md of [
      '## Plan',
      'Steps:\n- one\n- two',
      '1. first',
      '- [ ] todo',
      '> quoted',
      '```\ncode\n```',
      '| a | b |\n|---|---|\n| 1 | 2 |',
      'some **bold** words',
      'see [the doc](https://example.com)',
      'above\n\n---\n\nbelow',
    ])
      expect([md, looksLikeMarkdown(md)]).toEqual([md, true])
    for (const text of ['Just a sentence.', 'Two lines\nof plain words', 'a - b, 3 * 4 and #5', 'email me: ann@example.com', 'C:\\path|other'])
      expect([text, looksLikeMarkdown(text)]).toEqual([text, false])
  })

  it('pasted Markdown goes in formatted, where the cursor is', () => {
    const ed = editor('Before\n\nAfter')
    ed.commands.focus('end')
    ed.commands.insertContent(forEditor('### Pasted\n\n- [ ] item\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |'), { contentType: 'markdown' })
    const out = tidyMarkdown(ed.getMarkdown())
    ed.destroy()
    expect(out).toContain('### Pasted')
    expect(out).toContain('- [ ] item\n- [x] done')
    expect(out).toMatch(/\| a +\| b +\|/)
    expect(out.startsWith('Before')).toBe(true)
  })

  it('counts words in any language, not Markdown’s marks or a link’s address', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('## The plan\n\n- [ ] write **three** words\n- [x] done')).toBe(6)
    expect(countWords('See [the doc](https://example.com/a-long-address) now')).toBe(4)
    expect(countWords('| a | b |\n|---|---|\n| one | two |')).toBe(4)
    // Thai has no spaces between words: the browser knows where they end.
    expect(countWords('ฉันกินข้าว')).toBeGreaterThan(1)
  })

  it('a place in the shown text is the same place in the editor', () => {
    const md = '## Plan\n\nfirst words here\n\n- one\n- see 📎plan v2.pdf today\n\n> quoted'
    const ed = editor(md)
    const doc = ed.state.doc
    const all = doc.textBetween(0, doc.content.size, '', '')
    expect(counted('a b\n📎c')).toBe(3)
    // After n counted characters: the text before the cursor has exactly n of them.
    for (const n of [0, 1, 4, 5, 12, counted(all) - 1, counted(all)]) {
      const pos = posAt(doc, { after: n })
      expect(pos).not.toBeNull()
      expect(counted(doc.textBetween(0, pos!, '', ''))).toBe(n)
    }
    // Clicking the "h" of "here" (shown text: "Plan", "first", "words", then "h").
    const before = counted('Plan' + 'first' + 'words')
    expect(doc.textBetween(posAt(doc, { after: before })!, posAt(doc, { after: before })! + 5, '', '')).toMatch(/^ ?here/)
    // The start of a line is before its first word, not after the last word of the line above.
    const plan = counted('Plan')
    const end = posAt(doc, { after: plan })!
    const startOfNext = posAt(doc, { after: plan, lineStart: true })!
    expect(doc.resolve(end).parent.textContent).toBe('Plan')
    expect(doc.resolve(startOfNext).parent.textContent).toBe('first words here')
    expect(doc.resolve(startOfNext).parentOffset).toBe(0)
    expect(posAt(doc, { after: counted(all) + 1 })).toBeNull()
    expect(posAt(doc, { after: counted(all), lineStart: true })).toBeNull()
    ed.destroy()
  })
})

describe('drafts', () => {
  it('are kept per card, cleared when saved, and dropped when nobody comes back', () => {
    const now = Date.now()
    writeDraft('b1:t1', 'half a thought', now)
    writeDraft('b1:t2', 'another', now - 40 * 86_400_000)
    expect(readDraft('b1:t1')).toEqual({ text: 'half a thought', at: now })
    expect(readDraft('b1:nope')).toBeNull()
    pruneDrafts(now)
    expect(readDraft('b1:t2')).toBeNull()
    expect(readDraft('b1:t1')).not.toBeNull()
    clearDraft('b1:t1')
    expect(readDraft('b1:t1')).toBeNull()
    // Something else under the same name isn't a draft.
    localStorage.setItem('kankan:draft:b1:t3', '{"oops":1}')
    expect(readDraft('b1:t3')).toBeNull()
  })
})
