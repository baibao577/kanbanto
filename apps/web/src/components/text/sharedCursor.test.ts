// @vitest-environment happy-dom
import { Collaboration } from '@tiptap/extension-collaboration'
import { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { textElements } from './elements'
import { forEditor } from './mdText'
import { SharedCursor } from './sharedCursor'

/** Two people's copies of one shared text: what one writes reaches the other at once. */
const together = (md: string, { mended = true } = {}) => {
  const docs = [new Y.Doc(), new Y.Doc()]
  docs[0].on('update', (u: Uint8Array, from: unknown) => from !== 'theirs' && Y.applyUpdate(docs[1], u, 'theirs'))
  docs[1].on('update', (u: Uint8Array, from: unknown) => from !== 'theirs' && Y.applyUpdate(docs[0], u, 'theirs'))
  const open = (doc: Y.Doc) =>
    new Editor({
      element: document.body.appendChild(document.createElement('div')),
      extensions: [...textElements({ shared: true }), Collaboration.configure({ document: doc }), ...(mended ? [SharedCursor] : [])],
    })
  const ann = open(docs[0])
  ann.commands.setContent(forEditor(md), { contentType: 'markdown' })
  const ben = open(docs[1])
  return { ann, ben, close: () => [ann, ben].forEach((e) => e.destroy()) }
}
/** The place just before, or just after, some words in an editor's text. */
const place = (ed: Editor, words: string, after = false) => {
  let at = -1
  ed.state.doc.descendants((n, pos) => {
    const i = n.isText ? (n.text ?? '').indexOf(words) : -1
    if (at < 0 && i >= 0) at = pos + i + (after ? words.length : 0)
  })
  expect(at).toBeGreaterThan(0)
  return at
}
/** Where an editor's cursor is: the text of its line, cut where the cursor is. */
const cursor = (ed: Editor) => {
  const { $anchor } = ed.state.selection
  const text = $anchor.parent.textContent
  return `${text.slice(0, $anchor.parentOffset)}|${text.slice($anchor.parentOffset)}`
}

const TEXTS = {
  'a plain line': 'First.\n\nCheck the diary first.\n\nLast.',
  'a heading': 'First.\n\n## Check the diary first.\n\nLast.',
  'a quote': 'First.\n\n> Check the diary first.\n\nLast.',
  'a callout': 'First.\n\n> [!TIP]\n> Check the diary first.\n\nLast.',
  'a callout of the usual kind': 'First.\n\n> [!NOTE]\n> Check the diary first.\n\nLast.',
  'a code block': 'First.\n\n```ts\nCheck the diary first.\n```\n\nLast.',
  'a numbered list': 'First.\n\n3. Check the diary first.\n4. second\n\nLast.',
  'a cell': 'First.\n\n| A | B |\n| --- | --- |\n| Check the diary first. | x |\n\nLast.',
}

describe('one’s cursor, in a text written with others', () => {
  it('stays with one’s words when someone else types earlier in the same line, wherever the line is', () => {
    for (const [where, md] of Object.entries(TEXTS)) {
      const { ann, ben, close } = together(md)
      ann.commands.setTextSelection(place(ann, 'first.', true))
      ben.chain().setTextSelection(place(ben, 'Check')).insertContent('Marco says: ').run()
      expect(ann.getText()).toContain('Marco says: Check the diary first.')
      expect([where, cursor(ann)]).toEqual([where, 'Marco says: Check the diary first.|'])
      // What is typed next is where it was meant.
      ann.commands.insertContent(' Again.')
      expect([where, ben.getText().includes('Marco says: Check the diary first. Again.')]).toEqual([where, true])
      // In the middle of the line, with a change after the cursor: it stays where it is.
      ann.commands.setTextSelection(place(ann, 'diary'))
      ben
        .chain()
        .setTextSelection(place(ben, 'Again.', true))
        .insertContent(' And more.')
        .run()
      expect([where, cursor(ann)]).toEqual([where, 'Marco says: Check the |diary first. Again. And more.'])
      // A stretch of selected words keeps both its ends.
      ann.commands.setTextSelection({ from: place(ann, 'diary'), to: place(ann, 'first.', true) })
      ben.chain().setTextSelection(place(ben, 'Marco')).insertContent('>> ').run()
      const { from, to } = ann.state.selection
      expect([where, ann.state.doc.textBetween(from, to)]).toEqual([where, 'diary first.'])
      close()
    }
  })

  it('without the mending, it is left behind in a block that has something set on it (why the mending is there)', () => {
    const left = (md: string) => {
      const { ann, ben, close } = together(md, { mended: false })
      ann.commands.setTextSelection(place(ann, 'first.', true))
      ben.chain().setTextSelection(place(ben, 'Check')).insertContent('Marco says: ').run()
      const at = cursor(ann)
      close()
      return at
    }
    expect(left(TEXTS['a plain line'])).toBe('Marco says: Check the diary first.|')
    expect(left(TEXTS['a callout'])).toBe('Marco says: Check the |diary first.')
    expect(left(TEXTS['a heading'])).toBe('Marco says: Check the |diary first.')
  })

  it('a block that someone else turns into another kind keeps one’s cursor at its place in it', () => {
    const { ann, ben, close } = together(TEXTS['a plain line'])
    ann.commands.setTextSelection(place(ann, 'diary'))
    ben.chain().setTextSelection(place(ben, 'Check')).setHeading({ level: 2 }).run()
    expect(ann.state.selection.$anchor.parent.type.name).toBe('heading')
    expect(cursor(ann)).toBe('Check the |diary first.')
    // Put in a callout by someone else, the same.
    ben.chain().setTextSelection(place(ben, 'Check')).setParagraph().wrapIn('callout', { kind: 'warning' }).run()
    expect(ann.getJSON().content?.[1].type).toBe('callout')
    expect(cursor(ann)).toBe('Check the |diary first.')
    close()
  })
})
