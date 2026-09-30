// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown as MarkdownExt } from '@tiptap/markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AttachmentView } from '@kanbanto/model/api'
import { Markdown } from './Markdown'
import { forEditor, headingsOf, tidyMarkdown, toggleTask } from './mdText'

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
