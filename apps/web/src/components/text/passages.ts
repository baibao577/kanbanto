import { AROUND_MAX, locate, tidyPassage, type Passage } from '@kanbanto/model/passages'
import { countedAt, nodeAtPoint } from './caret'

// The words comments are about, on the page: where each passage is in what is shown, so it can be marked, clicked
// and scrolled to; and the passage for words someone has just selected. (How a passage is kept and found again is
// the model's passages.ts: by its letters, whatever the layout.)
//
// A passage is marked without touching what is shown (the browser's own highlights, CSS.highlights): the text is
// React's, or an editor's, and stays theirs. Where a browser has no such highlights the words aren't marked, and
// everything else still works: the comments are listed with their words, and one click scrolls to them.

/** Parts of what is shown that aren't the text: where other people's cursors are, in an editor shared with them. */
const NOT_TEXT = '.collaboration-carets__caret, [data-not-text]'

/** The letters of the text shown in an element, in order (see the model's `squeeze`), with where each one is. */
export interface Letters {
  text: string
  nodes: Text[]
  /** For each letter: which of `nodes` it is in, and how far into it. */
  node: number[]
  offset: number[]
}

export function lettersOf(root: HTMLElement): Letters {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const chars: string[] = []
  const nodes: Text[] = []
  const node: number[] = []
  const offset: number[] = []
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (n.parentElement?.closest(NOT_TEXT)) continue
    const data = n.data
    let k = -1
    for (let i = 0; i < data.length;) {
      const c = countedAt(data, i)
      if (c.counts) {
        if (k < 0) k = nodes.push(n) - 1
        chars.push(data[i])
        node.push(k)
        offset.push(i)
      }
      i += c.size
    }
  }
  return { text: chars.join(''), nodes, node, offset }
}

/** The stretch of the page from one letter to another (`end`: the first letter after it). */
export function rangeOf(root: HTMLElement, letters: Letters, start: number, end: number): Range | null {
  if (start < 0 || end > letters.text.length || end <= start) return null
  const range = root.ownerDocument.createRange()
  range.setStart(letters.nodes[letters.node[start]], letters.offset[start])
  range.setEnd(letters.nodes[letters.node[end - 1]], letters.offset[end - 1] + 1)
  return range
}

/** How many letters of the text come before a place in it (a node, and how far into it). */
export function lettersBefore(root: HTMLElement, letters: Letters, node: Node, offset: number): number {
  const place = root.ownerDocument.createRange()
  place.setStart(node, offset)
  place.collapse(true)
  // The first letter that is at the place or after it (they are in the order of the page).
  let lo = 0
  let hi = letters.text.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (place.comparePoint(letters.nodes[letters.node[mid]], letters.offset[mid]) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The part of a selection that is in the text shown in `root`. A selection often reaches past the text: three
 * clicks select a paragraph up to the start of whatever comes after it (after the last paragraph, that is outside
 * the text), a drag can end above the text, and "select all" takes the whole page. Null: none of it is in the text.
 */
export function partIn(root: HTMLElement, selected: Range): Range | null {
  if (selected.collapsed || !selected.intersectsNode(root)) return null
  const part = selected.cloneRange()
  if (!root.contains(part.startContainer)) part.setStart(root, 0)
  if (!root.contains(part.endContainer)) part.setEnd(root, root.childNodes.length)
  return part.collapsed ? null : part
}

/**
 * The passage for words someone selected in `root`: the words as they read, and where they are among its letters.
 * Null when nothing of the text is selected.
 */
export function passageOf(
  root: HTMLElement,
  letters: Letters,
  selected: Range,
  words: string,
): { passage: Passage; start: number; end: number } | null {
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return null
  const start = lettersBefore(root, letters, selected.startContainer, selected.startOffset)
  const end = lettersBefore(root, letters, selected.endContainer, selected.endOffset)
  if (end <= start) return null
  return {
    passage: tidyPassage({
      quote: words,
      before: letters.text.slice(Math.max(0, start - AROUND_MAX), start),
      after: letters.text.slice(end, end + AROUND_MAX),
    }),
    start,
    end,
  }
}

/**
 * Which letter of the text a point of the screen is at: how many letters come before where a cursor would go there
 * (so between two letters it is the second). Null: the point isn't in the text.
 */
export function letterAtPoint(root: HTMLElement, letters: Letters, x: number, y: number): number | null {
  const under = nodeAtPoint(root, x, y)
  return under ? lettersBefore(root, letters, under.node, under.offset) : null
}

/** Where each of these passages is in the text shown, by its key: from which letter to which. Not found: left out. */
export function placesOf<K>(letters: Letters, passages: { key: K; passage: Passage }[]): Map<K, { start: number; end: number }> {
  const out = new Map<K, { start: number; end: number }>()
  for (const { key, passage } of passages) {
    const at = locate(letters.text, passage)
    if (at) out.set(key, at)
  }
  return out
}

type Highlights = { set: (name: string, h: unknown) => void; delete: (name: string) => void }
const highlights = (): { registry: Highlights; make: (ranges: Range[]) => unknown } | null => {
  const g = globalThis as { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { highlights?: Highlights } }
  return g.Highlight && g.CSS?.highlights ? { registry: g.CSS.highlights, make: (ranges) => new g.Highlight!(...ranges) } : null
}
/** Whether this browser can mark words without changing what is shown. */
export const canMark = () => !!highlights()
/** Marks these stretches of the page under a name that the stylesheet colours (`::highlight(name)`); none: unmarks. */
export function mark(name: string, ranges: Range[]) {
  const h = highlights()
  if (!h) return
  if (ranges.length) h.registry.set(name, h.make(ranges))
  else h.registry.delete(name)
}
