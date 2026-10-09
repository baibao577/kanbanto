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
import { plainWords, squeeze } from '@kanbanto/model/passages'
import { countWords, foldedParts, forEditor, headingsOf, lex, looksLikeMarkdown, picturesNamed, tidyMarkdown, toggleTask } from './mdText'
import { lettersOf } from './passages'

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
  it('shows a card’s picture where a description names it on a line of its own, and nowhere else', () => {
    const shot: AttachmentView = { ...file, id: 'p1', name: 'flow chart.png', mime: 'image/png', url: '/api/attachments/p1', image: true }
    const files = [file, shot]
    const out = html('See the steps:\n\n📎flow chart.png\n\nThen 📎flow chart.png again, and 📎plan v2.pdf\n\n📎plan v2.pdf', {
      files,
      pictures: true,
    })
    // By itself on a line: the picture, as a link to the file, with its name kept for a screen reader.
    expect(out).toContain('<figure class="md-picture"><a href="/api/attachments/p1"')
    expect(out).toContain('<img src="/api/attachments/p1" alt=""')
    expect(out).toContain('<span class="sr-only">flow chart.png</span>')
    expect(out.match(/<img /g)).toHaveLength(1)
    // In a sentence it stays the small link, and a file that isn't a picture is never drawn.
    expect(out.match(/title="Open flow chart.png"/g)).toHaveLength(2)
    expect(out).toMatch(/<p><a href="\/api\/attachments\/f1"/)
    // Two names on two lines of one paragraph: two pictures.
    expect(html('📎flow chart.png\n📎flow chart.png', { files, pictures: true }).match(/<img /g)).toHaveLength(2)
    // Where pictures aren't asked for (a comment), and a name that isn't a file of the card: as before.
    expect(html('📎flow chart.png', { files })).not.toContain('<img')
    expect(html('📎gone.png', { files, pictures: true })).toBe('<div class="md"><p>📎gone.png</p></div>')
    // The shown text holds the same characters as the written text, so a click further down lands on the same word.
    const shownText = out.replace(/<[^>]+>/g, '')
    expect(counted(shownText)).toBe(counted('See the steps:\n\n📎flow chart.png\n\nThen 📎flow chart.png again, and 📎plan v2.pdf\n\n📎plan v2.pdf'))
    expect(picturesNamed('📎flow chart.png\n  \n', new Map([[shot.name, shot]]))).toEqual([shot])
    expect(picturesNamed('📎flow chart.png and more', new Map([[shot.name, shot]]))).toBeNull()
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
  describe('a card’s name in the text', () => {
    const cards = {
      boards: new Map([
        ['WEB', 'b1'],
        ['SITE', 'b1'],
        ['SHOP', 'b2'],
      ]),
      here: 'b1',
      card: (n: number) => (n === 12 ? { id: 't12', title: 'Fix the footer' } : undefined),
      open: () => {},
    }
    it('is a link to the card: on this board straight to it, elsewhere by its number', () => {
      const out = html('See WEB-12, then SHOP-3 and WEB-99.', { cards })
      expect(out).toContain('<a href="#/b/b1?task=t12" title="Fix the footer"')
      expect(out).toMatch(/<a href="#\/b\/b2\?n=3"[^>]*>SHOP-3<\/a>/)
      // (A number this board hasn't got in memory: archived, moved away, or never a card. Found when followed.)
      expect(out).toMatch(/<a href="#\/b\/b1\?n=99"[^>]*>WEB-99<\/a>/)
    })
    it('the letters a board had before still name its cards', () => {
      expect(html('SITE-12', { cards })).toMatch(/<a href="#\/b\/b1\?task=t12"[^>]*>SITE-12<\/a>/)
    })
    it('says exactly what was typed, so a click to edit lands on the same character', () => {
      const text = 'Before WEB-12 after'
      const out = html(text, { cards })
      expect(out.replace(/<[^>]+>/g, '')).toBe(text)
    })
    it('only letters of a board the reader can open, written as a name', () => {
      for (const text of [
        'UTF-8 and COVID-19',
        'web-12',
        'WEB-012',
        'WEB-0',
        'XWEB-12',
        'WEB-12x',
        'WEB-12-3',
        'pre-WEB-12',
        'WEB12',
        'WEB-1234567890',
      ])
        expect(html(text, { cards }), text).not.toContain('<a ')
      expect(html('(WEB-12), WEB-12. "WEB-12"', { cards }).match(/<a /g)).toHaveLength(3)
    })
    it('not in code, and not inside a link', () => {
      expect(html('`WEB-12`', { cards })).not.toContain('<a ')
      expect(html('```\nWEB-12\n```', { cards })).not.toContain('<a ')
      const linked = html('[read WEB-12 first](https://example.com/x)', { cards })
      expect(linked.match(/<a /g)).toHaveLength(1)
      expect(linked).toContain('href="https://example.com/x"')
      expect(html('https://example.com/WEB-12', { cards })).not.toContain('#/b/b1')
      // (Two names with a stroke between them are two cards.)
      expect(html('WEB-11/WEB-12', { cards }).match(/<a /g)).toHaveLength(2)
    })
    it('is plain text where no boards are known', () => {
      expect(html('WEB-12')).not.toContain('<a ')
      expect(html('WEB-12', { cards: { ...cards, boards: new Map() } })).not.toContain('<a ')
    })
  })
  it('lists headings for the contents', () => {
    expect(headingsOf('# One\n\ntext\n\n## Two **b**')).toEqual([
      { id: 'h-0', depth: 1, text: 'One', slug: 'one' },
      { id: 'h-1', depth: 2, text: 'Two b', slug: 'two-b' },
    ])
    // What a heading says, as it goes in an address: said twice, the second is told apart; in any language.
    expect(headingsOf('## Who to ask?\n\n## Who to ask\n\n## การคืนเงิน & refunds\n\n## !!!').map((h) => h.slug)).toEqual([
      'who-to-ask',
      'who-to-ask-2',
      'การคืนเงิน-refunds',
      'section',
    ])
  })
})

describe('headings that fold what is under them', () => {
  const TEXT =
    'Before any heading.\n\n## Problem\n\nTwo launches went wrong.\n\n### Detail\n\nThe old prices.\n\n## What we do\n\n1. Check\n2. Launch\n\n## References\n\nThe checklist.'
  const page = (folded: number[], link?: (i: number) => void) =>
    renderToStaticMarkup(<Markdown text={TEXT} headingIds fold={{ folded: new Set(folded), toggle: () => {}, open: () => {}, link }} />)
  const awayIn = (html: string) =>
    [...html.matchAll(/<div class="md-folded" data-folds="([^"]*)">(.*?)<\/div>/g)].map(
      (m) =>
        `${m[1]}: ${m[2]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()}`,
    )

  it('a folded heading puts away everything down to the next heading of its size, smaller headings with it', () => {
    const parts = foldedParts(lex(TEXT), new Set([0]))
    expect(parts.words.get(0)).toBe(8)
    const problem = ['0: Two launches went wrong.', '0: Detail', '0: The old prices.']
    expect(awayIn(page([0]))).toEqual(problem)
    // A smaller heading folds what is under it only; folded inside a folded one, its part is put away by both.
    expect(awayIn(page([1]))).toEqual(['1: The old prices.'])
    expect(awayIn(page([0, 1]))).toEqual(['0: Two launches went wrong.', '0: Detail', '0 1: The old prices.'])
    // The last heading folds to the end; what comes before the first heading is never put away.
    expect(awayIn(page([0, 2, 3]))).toEqual([...problem, '2: Check Launch', '3: The checklist.'])
    expect(awayIn(page([]))).toEqual([])
  })

  it('every heading has an arrow, a folded one says how much it puts away, and a link is there when asked for', () => {
    const html = page([3])
    expect(html.match(/class="md-fold"/g)).toHaveLength(4)
    expect(html).toContain('<h3 id="h-3" class="md-section" data-folded="2 words">')
    expect(html).toContain('aria-expanded="false" aria-label="Show this section"')
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(3)
    expect(html).not.toContain('md-section-link')
    expect(page([], () => {}).match(/class="md-section-link"/g)).toHaveLength(4)
    // Without folding asked for, a text is shown as it always was.
    expect(renderToStaticMarkup(<Markdown text={TEXT} headingIds />)).not.toMatch(/md-fold|md-section/)
  })

  it('what is put away is still on the page: the text holds the same letters, folded or not', () => {
    const letters = (folded: number[]) => {
      const root = document.createElement('div')
      root.innerHTML = page(folded, () => {})
      return lettersOf(root).text
    }
    expect(letters([0, 2])).toBe(letters([]))
    expect(letters([])).toBe(squeeze(plainWords(TEXT)))
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
    writeDraft('b1:t1', 'half a thought', undefined, now)
    writeDraft('b1:t2', 'another', undefined, now - 40 * 86_400_000)
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
