import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { Extension } from '@tiptap/react'
import { CODE_LANGS, DIAGRAM, langOf } from './codeLangs'
import { drawDiagram, isDark, watchDark } from './diagram'

// A code block while it is written: a small list on it to say what language it is in (which colours its words:
// see elements.ts), and, when it is a diagram written as text, the diagram under it, drawn again as it is typed
// (as it will show when the text is read: see Code.tsx). Only drawn: the text stays the block's own words.

const key = new PluginKey<DecorationSet>('codeTools')

interface Block {
  pos: number
  node: PMNode
  lang: string | null
}
const blocksOf = (doc: PMNode): Block[] => {
  const out: Block[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true
    out.push({ pos, node, lang: langOf(node.attrs.language as string | null)?.id ?? null })
    return false
  })
  return out
}

/**
 * The list of languages on a block. It stands before the block, not in it (something that isn't text, put at the
 * start of a block's own text, confuses where the browser has the cursor: the first word typed went astray), and
 * the stylesheet lays it over the block's corner. (Its words are no part of the text: see passages.ts.)
 */
function picker(view: EditorView, getPos: () => number | undefined, named: string | null): HTMLElement {
  const at = document.createElement('div')
  at.className = 'md-code-lang-at'
  at.contentEditable = 'false'
  at.setAttribute('data-not-text', '')
  const select = at.appendChild(document.createElement('select'))
  select.className = 'md-code-lang'
  select.setAttribute('aria-label', 'Language')
  select.title = 'What this code is written in'
  const known = langOf(named)
  const add = (value: string, label: string) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    select.append(o)
  }
  add('', 'Plain text')
  for (const l of CODE_LANGS) add(l.id, l.label)
  // (A language we have no name for is kept as it is written.)
  if (named && !known) add(named, named)
  select.value = known?.id ?? named ?? ''
  select.addEventListener('change', () => {
    const pos = getPos()
    const node = pos === undefined ? null : view.state.doc.nodeAt(pos)
    if (pos === undefined || node?.type.name !== 'codeBlock') return
    view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, language: select.value || null }))
    view.focus()
  })
  return at
}

function drawn(doc: PMNode): DecorationSet {
  const out: Decoration[] = []
  let diagrams = 0
  for (const b of blocksOf(doc)) {
    const named = (b.node.attrs.language as string | null) || null
    out.push(
      Decoration.widget(b.pos, (view, getPos) => picker(view, getPos, named), {
        side: -1,
        key: `lang:${named ?? ''}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    )
    if (b.lang !== DIAGRAM) continue
    out.push(
      Decoration.widget(
        b.pos + b.node.nodeSize,
        () => {
          const figure = document.createElement('figure')
          figure.className = 'md-diagram'
          figure.contentEditable = 'false'
          figure.setAttribute('data-drawing', '')
          const img = document.createElement('img')
          img.alt = ''
          img.draggable = false
          figure.append(img)
          return figure
        },
        // (The nth diagram of the text keeps its picture while its text is typed: it is drawn into, not made again.)
        { side: -1, key: `diagram:${diagrams++}`, ignoreSelection: true },
      ),
    )
  }
  return DecorationSet.create(doc, out)
}

export const CodeTools = Extension.create({
  name: 'codeTools',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => drawn(state.doc),
          apply: (tr, was, _old, state) => (tr.docChanged ? drawn(state.doc) : was),
        },
        props: { decorations: (state) => key.getState(state) },
        view(view) {
          const waiting = new WeakMap<Element, ReturnType<typeof setTimeout>>()
          /** Each diagram's picture is brought up to date with its text, a moment after the typing stops. */
          const draw = (now = false) => {
            const codes = blocksOf(view.state.doc)
              .filter((b) => b.lang === DIAGRAM)
              .map((b) => b.node.textContent)
            const dark = isDark()
            view.dom.querySelectorAll<HTMLElement>('figure.md-diagram').forEach((figure, i) => {
              const code = codes[i]
              const of = `${dark}\n${code}`
              if (code === undefined || figure.dataset.of === of) return
              clearTimeout(waiting.get(figure))
              waiting.set(
                figure,
                setTimeout(
                  () =>
                    void drawDiagram(code, dark).then((d) => {
                      // (Typed on meanwhile: the next drawing is on its way.)
                      if (!figure.isConnected || codes[i] !== blocksOf(view.state.doc).filter((b) => b.lang === DIAGRAM)[i]?.node.textContent) return
                      figure.dataset.of = of
                      figure.removeAttribute('data-drawing')
                      const img = figure.querySelector('img')!
                      if ('uri' in d) {
                        img.src = d.uri
                        img.width = d.width
                        img.height = d.height
                        figure.removeAttribute('data-error')
                      } else figure.setAttribute('data-error', d.error) // (The last good drawing stays, with why this one isn't.)
                    }),
                  now || !figure.dataset.of ? 0 : 350,
                ),
              )
            })
          }
          const frame = () => requestAnimationFrame(() => !view.isDestroyed && draw())
          frame()
          const off = watchDark(() => !view.isDestroyed && draw(true))
          return { update: frame, destroy: off }
        },
      }),
    ]
  },
})
