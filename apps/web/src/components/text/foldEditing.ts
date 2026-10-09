import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { Extension } from '@tiptap/react'
import { foldsOf, openFolds, renameFold, toggleFold, watchFolds } from './folds'
import { countWords, slugger } from './mdText'

// Sections folded away while a text is written (see folds.ts): the same arrows as when it is read, folding the same
// sections, since the folds are kept by what a heading says. Only drawn: the text is whole underneath, and nothing
// about a fold is part of it (nor of what several people writing it share: each has their own folds).
//
// Two things keep writing in a folded text honest. The cursor is never in what is put away: a section opens when
// the cursor gets into it (Enter at the end of its heading, a jump from the contents, a join with Backspace). And a
// folded heading that is retyped stays folded: its fold follows what it now says.

const key = new PluginKey<DecorationSet>('folds')

// (Phosphor's bold carets, as the reader draws them.)
const svg = (d: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256"><path d="${d}"></path></svg>`
const DOWN = svg('M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z')
const RIGHT = svg('M184.49,136.49l-80,80a12,12,0,0,1-17-17L159,128,87.51,56.49a12,12,0,1,1,17-17l80,80A12,12,0,0,1,184.49,136.49Z')

interface Section {
  pos: number
  node: PMNode
  slug: string
  shut: boolean
  /** How many words it puts away, when folded. */
  words: number
}
interface Part {
  from: number
  to: number
  /** The folded headings it is under, by their number among the text's headings, and by what they say. */
  under: number[]
  slugs: string[]
}

/** The text's headings, and what is put away under the folded ones (as `foldedParts` says for a text that is read). */
export function sectionsOf(doc: PMNode, folded: ReadonlySet<string>): { sections: Section[]; parts: Part[] } {
  const sections: Section[] = []
  const parts: Part[] = []
  const slug = slugger()
  let open: { i: number; level: number }[] = []
  doc.forEach((node, pos) => {
    const level = node.type.name === 'heading' ? Number(node.attrs.level) : 0
    if (level) open = open.filter((o) => o.level < level)
    if (open.length) {
      parts.push({ from: pos, to: pos + node.nodeSize, under: open.map((o) => o.i), slugs: open.map((o) => sections[o.i].slug) })
      const n = countWords(node.textBetween(0, node.content.size, ' ', ' '))
      for (const o of open) sections[o.i].words += n
    }
    if (level) {
      const s = slug(node.textContent)
      const shut = folded.has(s)
      sections.push({ pos, node, slug: s, shut, words: 0 })
      if (shut) open = [...open, { i: sections.length - 1, level }]
    }
  })
  return { sections, parts }
}

function arrow(card: string, s: Section, view: EditorView): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'md-fold'
  b.contentEditable = 'false'
  b.setAttribute('aria-expanded', String(!s.shut))
  b.setAttribute('aria-label', s.shut ? 'Show this section' : 'Fold this section away')
  b.title = s.shut ? 'Show this section' : 'Fold this section away'
  b.innerHTML = s.shut ? RIGHT : DOWN
  // (It doesn't take the cursor out of the text.)
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!s.shut) {
      // Folding the section the cursor is in: the cursor goes to the end of its heading (it is never in what is
      // put away, and would open the section again).
      const { doc, selection } = view.state
      const under = sectionsOf(doc, new Set([s.slug])).parts
      if (under.some((p) => selection.to > p.from && selection.from < p.to))
        view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, s.pos + s.node.nodeSize - 1)))
    }
    toggleFold(card, s.slug)
  })
  return b
}

/** The folded sections the cursor is in (it is in what they put away). */
const cursorIn = (state: EditorState, folded: ReadonlySet<string>): string[] => {
  const { selection, doc } = state
  if (!selection.empty || !folded.size) return []
  return [
    ...new Set(
      sectionsOf(doc, folded)
        .parts.filter((p) => selection.from > p.from && selection.from < p.to)
        .flatMap((p) => p.slugs),
    ),
  ]
}

function drawn(state: EditorState, card: string): DecorationSet {
  // (A section the cursor has just got into is drawn open at once, in the same breath as the cursor moves: put away
  // even for a moment, the browser would have nowhere to show the cursor and would move it.)
  const opening = cursorIn(state, foldsOf(card))
  const folded = opening.length ? new Set([...foldsOf(card)].filter((s) => !opening.includes(s))) : foldsOf(card)
  const { sections, parts } = sectionsOf(state.doc, folded)
  const out: Decoration[] = []
  for (const s of sections) {
    out.push(
      Decoration.node(s.pos, s.pos + s.node.nodeSize, {
        class: 'md-section',
        ...(s.shut && { 'data-folded': `${s.words.toLocaleString()} ${s.words === 1 ? 'word' : 'words'}` }),
      }),
      // (Before the heading's first letter; the stylesheet puts it in the margin.)
      Decoration.widget(s.pos + 1, (view) => arrow(card, s, view), { side: -1, key: `fold:${s.slug}:${s.shut}`, ignoreSelection: true }),
    )
  }
  for (const p of parts) out.push(Decoration.node(p.from, p.to, { class: 'md-folded', 'data-folds': p.under.join(' ') }))
  return DecorationSet.create(state.doc, out)
}

/** `card`: whose folds these are (see `useFolds`). */
export const FoldWhileWriting = Extension.create<{ card: string }>({
  name: 'foldWhileWriting',
  addOptions() {
    return { card: '' }
  },
  addProseMirrorPlugins() {
    const { card } = this.options
    if (!card) return []
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => drawn(state, card),
          apply: (tr, was, _old, state) => (tr.docChanged || tr.selectionSet || tr.getMeta(key) ? drawn(state, card) : was),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
        view(view) {
          // What is folded changed (an arrow was clicked, here or where the text is read): drawn again.
          const off = watchFolds(() =>
            queueMicrotask(() => !view.isDestroyed && view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false))),
          )
          return {
            update(view, before) {
              const { doc } = view.state
              if (before.doc !== doc) {
                // A folded heading retyped: its fold follows it (the headings are the same ones, one of them reads otherwise).
                const was = sectionsOf(before.doc, foldsOf(card)).sections
                const now = sectionsOf(doc, new Set()).sections
                const changed = was.length === now.length ? was.flatMap((s, i) => (s.slug !== now[i].slug ? [i] : [])) : []
                if (changed.length === 1 && was[changed[0]].shut) renameFold(card, was[changed[0]].slug, now[changed[0]].slug)
              }
              // The cursor is in what is put away: that section opens (it is drawn open already: see `drawn`).
              const opening = cursorIn(view.state, foldsOf(card))
              if (opening.length) openFolds(card, opening)
            },
            destroy: off,
          }
        },
      }),
    ]
  },
})
