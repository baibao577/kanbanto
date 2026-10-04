import type { Node as TextNode } from '@tiptap/pm/model'
import { FILE_MARK } from '@/components/task/RichText'

/**
 * Lining up a place in shown text with the same place in the editor (so clicking a word to edit puts the cursor on
 * that word, and going full page keeps it where it was). The two aren't laid out alike, but they hold the same
 * words: a place is "after this many characters", counting neither spaces nor the file mark (shown as an icon, typed
 * as 📎).
 */

export interface Place {
  /** How many counted characters come before it. */
  after: number
  /** It's at the start of its line (a paragraph, a list item, a heading): before the next character, not after the last. */
  lineStart?: boolean
}

/** Whether the character at `i` counts, and how long it is (the file mark is two code units). */
export function countedAt(text: string, i: number): { counts: boolean; size: number } {
  if (text.startsWith(FILE_MARK, i)) return { counts: false, size: FILE_MARK.length }
  return { counts: !/\s/.test(text[i]), size: 1 }
}

/** How many characters of `text` count. */
export function counted(text: string): number {
  let n = 0
  for (let i = 0; i < text.length;) {
    const c = countedAt(text, i)
    if (c.counts) n++
    i += c.size
  }
  return n
}

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote'

/** The place under a point of the screen, in `root`'s text; null when there's no text there. */
export function placeAtPoint(root: HTMLElement, x: number, y: number): Place | null {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  let node: Node | null = null
  let offset = 0
  const at = doc.caretPositionFromPoint?.(x, y)
  if (at) {
    node = at.offsetNode
    offset = at.offset
  } else {
    const range = doc.caretRangeFromPoint?.(x, y)
    if (range) {
      node = range.startContainer
      offset = range.startOffset
    }
  }
  if (!node || !root.contains(node)) return null
  const before = doc.createRange()
  before.setStart(root, 0)
  before.setEnd(node, offset)
  // At the start of its line? (Nothing counted between where the line begins and here.)
  const block = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest(BLOCKS)
  const line = doc.createRange()
  if (block && root.contains(block)) line.setStart(block, 0)
  else line.setStart(root, 0)
  line.setEnd(node, offset)
  return { after: counted(before.toString()), lineStart: !!block && counted(line.toString()) === 0 }
}

/**
 * Where the cursor goes in the editor's text for a place: right after that many counted characters, or, at the start
 * of a line (and at the very beginning), right before the next one. Null: past the end.
 */
export function posAt(doc: TextNode, place: Place): number | null {
  let left = place.after
  let found: number | null = null
  doc.descendants((node, pos) => {
    if (found !== null) return false
    if (!node.isText) return true
    const text = node.text ?? ''
    for (let i = 0; i < text.length;) {
      const c = countedAt(text, i)
      if (c.counts) {
        if (left === 0) {
          found = pos + i
          return false
        }
        if (--left === 0 && !place.lineStart) {
          found = pos + i + c.size
          return false
        }
      }
      i += c.size
    }
    return true
  })
  return found
}
