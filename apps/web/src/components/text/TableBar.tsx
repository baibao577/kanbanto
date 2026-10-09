import {
  ColumnsPlusLeft,
  ColumnsPlusRight,
  RowsPlusBottom,
  RowsPlusTop,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  Trash,
} from '@phosphor-icons/react'
import { useEditorState, type Editor as TiptapEditor } from '@tiptap/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { alignColumns, columnAlign, type ColumnAlign } from './elements'

type Chain = ReturnType<TiptapEditor['chain']>

/**
 * The bar on a table, while the cursor is in it: rows and columns added beside where the cursor is, the column
 * lined up left, centre or right, and the row, the column or the table deleted. It sits over the table's top edge,
 * at its right end (the line of text above a table seldom reaches that far: it is covered while the bar is up),
 * under the table when there is no room over it, and stays in view under the editor's toolbar while a long table
 * scrolls. `within`: the editor's box, which it is placed in.
 */
export function TableBar({ editor, within }: { editor: TiptapEditor; within: RefObject<HTMLDivElement | null> }) {
  const [menu, setMenu] = useState(false)
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      table: e.isEditable && e.isActive('table'),
      focused: e.isFocused,
      align: e.isEditable ? columnAlign(e.state) : null,
    }),
  })
  const shown = on.table && (on.focused || menu)
  const bar = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)

  const place = () => {
    const box = within.current
    if (!box || !shown) return setAt(null)
    const under = editor.view.domAtPos(editor.state.selection.from).node
    const table = (under.nodeType === 1 ? (under as Element) : under.parentElement)?.closest('table')
    if (!table || !box.contains(table)) return setAt(null)
    const t = table.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    const height = bar.current?.offsetHeight ?? 34
    const width = bar.current?.offsetWidth ?? 300
    // The highest it may sit: just under the toolbar, which stays in view.
    const floor = (box.querySelector('[data-toolbar]')?.getBoundingClientRect().bottom ?? b.top) + 4
    let top = t.top - height - 4
    if (top < floor) {
      // No room over the table. Its top is in view (it comes first in the text): under the table, when its end is
      // in view too. Else it is a long table scrolled under the toolbar: the bar stays there, over its rows.
      const end = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight
      if (t.top >= floor - 2 && t.bottom + height + 8 < end) top = t.bottom + 4
      else if (t.bottom > floor + height) top = floor
      else return setAt(null)
    }
    setAt({ top: top - b.top, left: Math.max(0, Math.min(t.right - b.left - width, b.width - width)) })
  }
  const latest = useRef(place)
  useLayoutEffect(() => {
    latest.current = place
  })
  // Placed again whenever the text or the cursor changes (the table grows as it is typed in), and as the page scrolls.
  useLayoutEffect(() => {
    latest.current()
    if (!shown) return
    let frame = 0
    const soon = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => latest.current())
    }
    editor.on('transaction', soon)
    window.addEventListener('scroll', soon, true)
    window.addEventListener('resize', soon)
    return () => {
      cancelAnimationFrame(frame)
      editor.off('transaction', soon)
      window.removeEventListener('scroll', soon, true)
      window.removeEventListener('resize', soon)
    }
  }, [editor, shown])
  // (The first time it shows, it is measured as it is drawn: placed again once its size is known.)
  useEffect(() => {
    if (at) latest.current()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, when it first has a place
  }, [!!at])

  if (!shown) return null
  const run = (f: (c: Chain) => Chain) => () => void f(editor.chain().focus()).run()
  const align = (to: ColumnAlign) => () => {
    const tr = alignColumns(editor.state, to)
    if (tr) editor.view.dispatch(tr)
    editor.commands.focus()
  }
  /** A Markdown table always has a heading row: when the heading is the row deleted, the next row becomes it. */
  const deleteRow = () => {
    editor.chain().focus().deleteRow().run()
    const { $from } = editor.state.selection
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d)
      if (node.type.name !== 'table') continue
      let headed = false
      node.firstChild?.forEach((c) => {
        if (c.type.name === 'tableHeader') headed = true
      })
      if (!headed) editor.commands.toggleHeaderRow()
      break
    }
  }
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Table"
      className={cn('absolute z-[9] flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md', !at && 'invisible')}
      style={at ?? { top: 0, left: 0 }}
      // (Its buttons don't take the cursor out of the table.)
      onMouseDown={(e) => e.preventDefault()}
    >
      <Do label="Add a row above" onClick={run((c) => c.addRowBefore())}>
        <RowsPlusTop />
      </Do>
      <Do label="Add a row below" onClick={run((c) => c.addRowAfter())}>
        <RowsPlusBottom />
      </Do>
      <Do label="Add a column to the left" onClick={run((c) => c.addColumnBefore())}>
        <ColumnsPlusLeft />
      </Do>
      <Do label="Add a column to the right" onClick={run((c) => c.addColumnAfter())}>
        <ColumnsPlusRight />
      </Do>
      <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <Do label="Line the column up left" on={on.align === 'left'} onClick={align('left')}>
        <TextAlignLeft />
      </Do>
      <Do label="Centre the column" on={on.align === 'center'} onClick={align('center')}>
        <TextAlignCenter />
      </Do>
      <Do label="Line the column up right" on={on.align === 'right'} onClick={align('right')}>
        <TextAlignRight />
      </Do>
      <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          <span>
            <Do label="Delete…" on={menu}>
              <Trash />
            </Do>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onSelect={deleteRow}>Delete this row</DropdownMenuItem>
          <DropdownMenuItem onSelect={run((c) => c.deleteColumn())}>Delete this column</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={run((c) => c.deleteTable())}>
            Delete the table
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function Do({ label, on, onClick, children }: { label: string; on?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-4',
        on && 'bg-accent text-foreground',
      )}
    >
      {children}
    </button>
  )
}
