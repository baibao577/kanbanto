// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { plainWords, squeeze } from '@kanbanto/model/passages'
import { langOf } from './codeLangs'
import { textElements } from './elements'
import { colour } from './highlight'
import { Markdown } from './Markdown'
import { forEditor, tidyMarkdown } from './mdText'
import { lettersOf } from './passages'

const TS = '```ts\n// keep sessions for 30 days\nconst days = 30\n```'
const html = (md: string) => renderToStaticMarkup(<Markdown text={md} />)
const editing = (md: string) => {
  const element = document.body.appendChild(document.createElement('div'))
  return new Editor({ element, extensions: textElements(), content: forEditor(md), contentType: 'markdown' })
}

describe('code blocks', () => {
  it('a language is known by its name, however it is written', () => {
    expect([langOf('ts')?.id, langOf('TypeScript')?.label, langOf('sh')?.label, langOf('html')?.id, langOf('yml')?.id]).toEqual([
      'typescript',
      'TypeScript',
      'Shell',
      'xml',
      'yaml',
    ])
    // (What follows the name on the fence's line is no part of it; a language we don't know has no name here.)
    expect([langOf('js {1,3}')?.id, langOf('mermaid')?.id, langOf('klingon'), langOf(''), langOf(undefined)]).toEqual([
      'javascript',
      'mermaid',
      null,
      null,
      null,
    ])
  })

  it('read: the language is named, there is a button to copy it, and the page holds the code’s own letters only', () => {
    const page = html(`Before.\n\n${TS}\n\nAfter.`)
    expect(page).toContain('<div class="md-code" data-lang="TypeScript">')
    expect(page).toContain('aria-label="Copy the code"')
    expect(page).toContain('<pre><code>// keep sessions for 30 days\nconst days = 30</code></pre>')
    // No language said: no name, and still a button.
    expect(html('```\nplain\n```')).toContain('<div class="md-code"><button')
    const root = document.createElement('div')
    root.innerHTML = page
    expect(lettersOf(root).text).toBe('Before.//keepsessionsfor30daysconstdays=30After.')
    expect(lettersOf(root).text).toBe(squeeze(plainWords(`Before.\n\n${TS}\n\nAfter.`)))
  })

  it('its words are coloured by kind, and are the same words', () => {
    const pieces = colour('// keep sessions for 30 days\nconst days = 30', 'typescript')
    const words = (list: typeof pieces): string => list.map((p) => (p.type === 'text' ? p.value : words(p.children))).join('')
    const kinds = (list: typeof pieces): string[] =>
      list.flatMap((p) => (p.type === 'text' ? [] : [...(p.properties?.className ?? []), ...kinds(p.children)]))
    expect(words(pieces)).toBe('// keep sessions for 30 days\nconst days = 30')
    expect(kinds(pieces)).toEqual(expect.arrayContaining(['hljs-comment', 'hljs-keyword', 'hljs-number']))
    // The other ways a language is written colour the same.
    expect(colour('ls -la', 'sh')).toEqual(colour('ls -la', 'bash'))
  })

  it('written: the block keeps its language and its words, coloured as it is typed', () => {
    const ed = editing(`Before.\n\n${TS}\n\n\`\`\`\nplain\n\`\`\`\n\n\`\`\`klingon\nnuqneH\n\`\`\``)
    expect(tidyMarkdown(ed.getMarkdown())).toBe(`Before.\n\n${TS}\n\n\`\`\`\nplain\n\`\`\`\n\n\`\`\`klingon\nnuqneH\n\`\`\``)
    expect(ed.view.dom.querySelectorAll('pre .hljs-keyword').length).toBeGreaterThan(0)
    // A block that doesn't say its language, or says one we don't know, is plain: nothing is guessed.
    expect([...ed.view.dom.querySelectorAll('pre')].map((pre) => pre.querySelectorAll('[class^="hljs"]').length > 0)).toEqual([true, false, false])
    // Each block has its list of languages, saying its own (one we have no name for, as it is written).
    const lists = [...ed.view.dom.querySelectorAll<HTMLSelectElement>('.md-code-lang-at + pre')].map((pre) =>
      pre.previousElementSibling!.querySelector('select')!,
    )
    expect(lists.map((s) => s.value)).toEqual(['typescript', '', 'klingon'])
    // The list's words are no part of the text.
    expect(lettersOf(ed.view.dom).text).toBe('Before.//keepsessionsfor30daysconstdays=30plainnuqneH')
    // Choosing from it says so in the text.
    lists[1].value = 'python'
    lists[1].dispatchEvent(new Event('change'))
    expect(tidyMarkdown(ed.getMarkdown())).toContain('```python\nplain\n```')
    ed.destroy()
  })

  it('a diagram written as text keeps its text on the page (out of sight once drawn), and is a code block when written', () => {
    const text = 'Before.\n\n```mermaid\nflowchart LR\n  A[Enquiry] --> B[Quote]\n```\n\nAfter.'
    const page = html(text)
    expect(page).toContain('<figure class="md-diagram"')
    expect(page).toContain('<code>flowchart LR\n  A[Enquiry] --&gt; B[Quote]</code>')
    const root = document.createElement('div')
    root.innerHTML = page
    expect(lettersOf(root).text).toBe(squeeze(plainWords(text)))
    const ed = editing(text)
    expect(tidyMarkdown(ed.getMarkdown())).toBe(text)
    expect(ed.view.dom.querySelectorAll('figure.md-diagram')).toHaveLength(1)
    expect(lettersOf(ed.view.dom).text).toBe(lettersOf(root).text)
    ed.destroy()
  })
})
