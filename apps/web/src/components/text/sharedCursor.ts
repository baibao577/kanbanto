import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Extension } from '@tiptap/react'
import { relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap'
import * as Y from 'yjs'

// In a text written by several people, one's cursor stays with one's words when someone else's change arrives: the
// shared document knows where it is (after which letter), whatever was typed before it.
//
// The library that joins the editor to the shared document (@tiptap/y-tiptap, 3.0.9) then looks at the answer
// again: where the line the cursor is in reads differently than before, it takes the cursor to have been put in the
// wrong block, and looks for the block it was in. For a block it can tell apart by what is set on it (a callout's
// kind, a heading's size, a code block's language), it finds it, and puts the cursor as far into it as it was
// before: the right place when the block was taken out and put back (its type changed, or it was moved), the wrong
// one when someone simply typed earlier in the same line, which then pushes the cursor back into the middle of
// one's own sentence.
//
// So the first answer is taken back whenever it can be trusted: when the piece of text the cursor was in is still
// part of the shared document (nobody took it out), where a cursor is in it is exactly known.
//
// And when it was taken out and put back as something else (someone made the line a heading, or put it in a
// callout: a block can't change its kind in the shared document, it is replaced), the library has no block of the
// old kind to find and leaves the cursor wherever the old place now points, often in another paragraph. The line
// still reads the same: when exactly one line of the text does, the cursor goes as far into it as it was.

type Rel = { type?: string; anchor: Y.RelativePosition | null; head: Y.RelativePosition | null }
type Sync = { doc: Y.Doc; type: Y.XmlFragment; binding: { beforeTransactionSelection: Rel | null; mapping: Map<Y.AbstractType<unknown>, unknown> } }

/** A part of the shared document, as far as this needs to know it: what holds it, and whether it was taken out. */
type Held = { _item: { deleted: boolean; parent: Held | null } | null }

/** Whether the piece of text a place is in is still in the shared document, under `root`. */
function alive(doc: Y.Doc, root: Y.XmlFragment, place: Y.RelativePosition): boolean {
  const at = Y.createAbsolutePositionFromRelativePosition(place, doc)
  if (!at || !(at.type instanceof Y.XmlText)) return false
  let type = at.type as unknown as Held | null
  while (type && type !== (root as unknown)) {
    if (!type._item || type._item.deleted) return false
    type = type._item.parent
  }
  return type === (root as unknown)
}

/**
 * The same place in the line a place was in, when that line was replaced by one that reads the same: found by its
 * text. Null when no line, or more than one, reads so (or it is empty: empty lines can't be told apart).
 */
function sameLine(before: PMNode, pos: number, now: PMNode): number | null {
  const $was = before.resolve(Math.min(pos, before.content.size))
  const text = $was.parent.isTextblock ? $was.parent.textContent : ''
  if (!text) return null
  let found = -1
  let n = 0
  now.descendants((node, at) => {
    if (!node.isTextblock) return true
    if (node.textContent === text) {
      n++
      found = at + 1
    }
    return false
  })
  return n === 1 ? found + $was.parentOffset : null
}

export const SharedCursor = Extension.create({
  name: 'sharedCursor',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('sharedCursor'),
        appendTransaction(trs, old, state) {
          // (Only after a change that came from the others, while what the cursor was is still known.)
          if (!trs.some((tr) => (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin)) return null
          const sync = ySyncPluginKey.getState(state) as Sync | undefined
          const was = sync?.binding.beforeTransactionSelection
          if (!sync || !was?.anchor || !was.head || (was.type !== undefined && was.type !== 'text')) return null
          const mapping = sync.binding.mapping as Parameters<typeof relativePositionToAbsolutePosition>[3]
          const now = (place: Y.RelativePosition, pos: number) =>
            alive(sync.doc, sync.type, place)
              ? relativePositionToAbsolutePosition(sync.doc, sync.type, place, mapping)
              : sameLine(old.doc, pos, state.doc)
          const anchor = now(was.anchor, old.selection.anchor)
          const head = now(was.head, old.selection.head)
          if (anchor === null || head === null || (anchor === state.selection.anchor && head === state.selection.head)) return null
          const size = state.doc.content.size
          if (anchor < 0 || head < 0 || anchor > size || head > size) return null
          const $anchor = state.doc.resolve(anchor)
          const $head = state.doc.resolve(head)
          if (!$anchor.parent.isTextblock || !$head.parent.isTextblock) return null
          return state.tr.setSelection(new TextSelection($anchor, $head)).setMeta('addToHistory', false)
        },
      }),
    ]
  },
})
