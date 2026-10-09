import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { isInTable, selectedRect } from '@tiptap/pm/tables'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { Node, ReactNodeViewRenderer, mergeAttributes } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { CALLOUTS, calloutOf, isCalloutKind, type CalloutKind } from './callouts'
import { CalloutView } from './CalloutView'
import { CodeTools } from './codeEditing'
import { colouring } from './highlight'

// What the editor knows beyond the basics, each written to Markdown in a way other readers of Markdown know:
// callouts (see callouts.tsx), and, for tables, which way a column lines up and what a pasted table needs.
//
// Adding an element here changes what a text being written by several people can hold: every browser in a session
// must know the same ones (an editor drops what it doesn't know from the text they share). That is what
// EDITOR_VERSION in the model's api.ts is for: raise it with every such change.

/**
 * A callout: a box of a kind, with any text in it. It is read from a quote that starts with a callout's mark, and
 * written as one. (Being the first to be asked about a quote in the Markdown, it is also the one asked to write a
 * quote: an ordinary quote is written as it always was.)
 */
export const Callout = Node.create({
  name: 'callout',
  // (Asked about a quote before the quote itself is.)
  priority: 110,
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note' satisfies CalloutKind,
        parseHTML: (el: HTMLElement) => (isCalloutKind(el.getAttribute('data-callout')) ? el.getAttribute('data-callout') : 'note'),
        renderHTML: (attrs: { kind?: unknown }) => ({ 'data-callout': isCalloutKind(attrs.kind) ? attrs.kind : 'note' }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]', contentElement: (el: HTMLElement) => el.querySelector<HTMLElement>(':scope > .md-callout-body') ?? el }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = isCalloutKind(node.attrs.kind) ? node.attrs.kind : 'note'
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'md-callout' }),
      ['div', { class: 'md-callout-body', 'data-label': CALLOUTS[kind].label }, 0],
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView)
  },

  markdownTokenName: 'blockquote',

  parseMarkdown: (token, helpers) => {
    const found = calloutOf(token as Parameters<typeof calloutOf>[0])
    if (!found) return null as never
    const parse = helpers.parseBlockChildren ?? helpers.parseChildren
    const content = parse(found.tokens as Parameters<typeof parse>[0])
    return helpers.createNode('callout', { kind: found.kind }, content.length ? content : [{ type: 'paragraph' }])
  },

  renderMarkdown: (node, h) => {
    const box = node.type === 'callout'
    if (!box && !node.content) return ''
    const kind = isCalloutKind(node.attrs?.kind) ? node.attrs.kind : 'note'
    const lines = box ? [`> [!${kind.toUpperCase()}]`] : []
    node.content?.forEach((child, i) => {
      if (i > 0) lines.push('>')
      const text = h.renderChild?.(child, i) ?? h.renderChildren([child])
      for (const line of text.split('\n')) lines.push(line.trim() ? `> ${line}` : '>')
    })
    // (An empty box is written with nothing under its mark.)
    while (box && lines.length > 1 && lines.at(-1) === '>') lines.pop()
    return lines.join('\n')
  },
})

export type ColumnAlign = 'left' | 'center' | 'right'

/**
 * Which way the column with the cursor lines up (a Markdown table says it per column: the first cell that says so
 * speaks for the column). Null: not in a table.
 */
export function columnAlign(state: EditorState): ColumnAlign | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  for (let row = 0; row < rect.map.height; row++) {
    const align = rect.table.nodeAt(rect.map.map[row * rect.map.width + rect.left])?.attrs.align as ColumnAlign | null | undefined
    if (align) return align
  }
  return 'left'
}

/** Lines up the columns the selection is in: every cell of them, so the table reads the same written and read. */
export function alignColumns(state: EditorState, align: ColumnAlign): Transaction | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  const tr = state.tr
  const done = new Set<number>()
  for (let col = rect.left; col < rect.right; col++)
    for (let row = 0; row < rect.map.height; row++) {
      const pos = rect.map.map[row * rect.map.width + col]
      const cell = rect.table.nodeAt(pos)
      if (!cell || done.has(pos)) continue
      done.add(pos)
      // (Left is how a column lines up when nothing is said: nothing is written for it.)
      tr.setNodeMarkup(rect.tableStart + pos, null, { ...cell.attrs, align: align === 'left' ? null : align })
    }
  return tr
}

/** A cell's text without its bold, when all of it is bold (a spreadsheet's heading row, pasted). */
function unbold(cell: PMNode): Fragment {
  let all = true
  let any = false
  cell.descendants((n) => {
    if (!n.isText) return true
    any = true
    if (!n.marks.some((m) => m.type.name === 'bold')) all = false
    return false
  })
  if (!any || !all) return cell.content
  const strip = (f: Fragment): Fragment => {
    const out: PMNode[] = []
    f.forEach((n) => out.push(n.isText ? n.mark(n.marks.filter((m) => m.type.name !== 'bold')) : n.copy(strip(n.content))))
    return Fragment.fromArray(out)
  }
  return strip(cell.content)
}

/**
 * A table as Markdown can hold it: its first row is its heading (a spreadsheet's cells come without one, and a
 * Markdown table always has one: without this an empty heading row is put above the pasted rows), and a column lines
 * up one way, whichever of its cells said so.
 */
function tidyTable(table: PMNode): PMNode {
  const { tableHeader } = table.type.schema.nodes
  const rows: PMNode[] = []
  table.forEach((r) => rows.push(r))
  if (!rows.length || !tableHeader) return table
  let merged = false
  let headed = false
  const aligns: (string | null)[] = []
  for (const r of rows)
    r.forEach((c, _at, i) => {
      if ((c.attrs.colspan ?? 1) > 1 || (c.attrs.rowspan ?? 1) > 1) merged = true
      if (c.type === tableHeader) headed = true
      aligns[i] ??= (c.attrs.align as string | null) ?? null
    })
  // (Cells that span several: left as they came.)
  if (merged) return table
  return table.type.create(
    table.attrs,
    rows.map((r, at) => {
      const cells: PMNode[] = []
      r.forEach((c, _at, i) => {
        const head = !headed && at === 0
        cells.push((head ? tableHeader : c.type).create({ ...c.attrs, align: aligns[i] ?? null }, head ? unbold(c) : c.content))
      })
      return r.type.create(r.attrs, cells)
    }),
  )
}

/** What is pasted, with its whole tables tidied (see `tidyTable`). Parts of a table (some cells) are left alone. */
export function tidyPastedTables(slice: Slice): Slice {
  if (slice.openStart || slice.openEnd) return slice
  let changed = false
  const fix = (f: Fragment): Fragment => {
    const out: PMNode[] = []
    f.forEach((n) => {
      if (n.type.name === 'table') {
        const tidy = tidyTable(n)
        if (tidy !== n) changed = true
        out.push(tidy)
      } else out.push(n.isLeaf || n.isTextblock ? n : n.copy(fix(n.content)))
    })
    return Fragment.fromArray(out)
  }
  const content = fix(slice.content)
  return changed ? new Slice(content, 0, 0) : slice
}

/**
 * Everything the editor's text can hold, and how it is read from and written to Markdown. `shared`: the text is
 * written by several people (it then has its own undo, which takes back what this person typed, not what the others
 * did).
 */
export const textElements = ({ shared = false }: { shared?: boolean } = {}) => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    underline: false,
    link: { openOnClick: false, autolink: true, protocols: ['mailto'], defaultProtocol: 'https' },
    // (A code block's words are coloured while it is written, as when it is read: the same block, drawn with
    // colours, so nothing about the text or what several writers share is different.)
    codeBlock: false,
    ...(shared && { undoRedo: false }),
  }),
  CodeBlockLowlight.configure({ lowlight: colouring, defaultLanguage: null }),
  CodeTools,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit,
  Markdown,
  Callout,
]
