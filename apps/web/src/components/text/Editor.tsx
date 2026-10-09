import {
  ArrowsOut,
  CheckSquare,
  Code,
  CodeBlock,
  ColumnsPlusRight,
  File,
  Kanban,
  LinkSimple,
  ListBullets,
  ListNumbers,
  Minus,
  Quotes,
  RowsPlusBottom,
  Table,
  TextB,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextItalic,
  Trash,
} from '@phosphor-icons/react'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { EditorContent, Extension, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import type { AttachmentView } from '@kanbanto/model/api'
import type { CardPick, CardSource } from '@/app/card-refs'
import { Avatar } from '@/components/common/bits'
import { FILE_MARK } from '@/components/task/RichText'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { counted, posAt, type Place } from './caret'
import { forEditor, looksLikeMarkdown, tidyMarkdown } from './mdText'

type Member = { id: string; name: string; picture?: string | null }
type Chain = ReturnType<TiptapEditor['chain']>
/** Something the "/" menu puts in (or, inside a table, does to it). */
interface Insert {
  id: string
  label: string
  /** What typing it looks like, shown beside it. */
  hint?: string
  /** Other words that find it. */
  words?: string
  icon: ReactNode
  table?: boolean
  /** Under "Mention" in the menu: something named in the text (a card), not a way to lay text out. */
  mention?: boolean
  /** Also offered where the menu is kept short (comments): no headings, tables or dividers there. */
  light?: boolean
  /** What it does at once. Without it, `step`. */
  run?: (c: Chain) => Chain
  /** It needs choosing first: picking it opens a second list (a card: found by its title or number). */
  step?: 'card'
}
type Suggestion = { kind: '@'; member: Member } | { kind: '#'; file: AttachmentView } | { kind: '/'; insert: Insert }
/** The part of the "/" menu a line is in (the people after "@" and the files after "#" are lists of one kind). */
const groupOf = (s: Suggestion) => (s.kind !== '/' ? null : s.insert.mention ? 'Mention' : 'Put in')

const INSERTS: Insert[] = [
  // Mentions, at the top: one line, where the rest is a long list. (More can join the card here: each is one entry,
  // with `step` when it has to be chosen from a list.)
  { id: 'card', label: 'Card', words: 'mention task', mention: true, light: true, icon: <Kanban />, step: 'card' },
  // Things to put in.
  { id: 'h1', label: 'Big heading', hint: '#', words: 'title h1', icon: <TextHOne />, run: (c) => c.setHeading({ level: 1 }) },
  { id: 'h2', label: 'Heading', hint: '##', words: 'h2', icon: <TextHTwo />, run: (c) => c.setHeading({ level: 2 }) },
  { id: 'h3', label: 'Small heading', hint: '###', words: 'h3', icon: <TextHThree />, run: (c) => c.setHeading({ level: 3 }) },
  { id: 'list', label: 'List', hint: '-', words: 'bullets', light: true, icon: <ListBullets />, run: (c) => c.toggleBulletList() },
  {
    id: 'numbers',
    label: 'Numbered list',
    hint: '1.',
    words: 'ordered steps',
    light: true,
    icon: <ListNumbers />,
    run: (c) => c.toggleOrderedList(),
  },
  { id: 'checklist', label: 'Checklist', hint: '[ ]', words: 'todo tasks tick', light: true, icon: <CheckSquare />, run: (c) => c.toggleTaskList() },
  { id: 'quote', label: 'Quote', hint: '>', light: true, icon: <Quotes />, run: (c) => c.toggleBlockquote() },
  { id: 'code', label: 'Code block', hint: '```', light: true, icon: <CodeBlock />, run: (c) => c.toggleCodeBlock() },
  { id: 'table', label: 'Table', words: 'grid rows columns', icon: <Table />, run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { id: 'divider', label: 'Divider', hint: '---', words: 'line rule', icon: <Minus />, run: (c) => c.setHorizontalRule() },
  { id: 'row', label: 'Add a row below', table: true, icon: <RowsPlusBottom />, run: (c) => c.addRowAfter() },
  { id: 'column', label: 'Add a column to the right', table: true, icon: <ColumnsPlusRight />, run: (c) => c.addColumnAfter() },
  { id: 'row-', label: 'Delete this row', table: true, words: 'remove', icon: <Trash />, run: (c) => c.deleteRow() },
  { id: 'column-', label: 'Delete this column', table: true, words: 'remove', icon: <Trash />, run: (c) => c.deleteColumn() },
  { id: 'table-', label: 'Delete the table', table: true, words: 'remove', icon: <Trash />, run: (c) => c.deleteTable() },
]

const picturesKey = new PluginKey<AttachmentView[]>('pictures')
/**
 * Pictures while writing (descriptions): under a line that is only a picture's name ("📎plan.png") the picture
 * itself is drawn, as it will be when the text is read (see Markdown). Only drawn: the text stays the name.
 * The card's files, as they are now, are part of what the editor knows: it is told when they change (a change that
 * carries them and touches no text).
 */
const Pictures = Extension.create({
  name: 'pictures',
  addProseMirrorPlugins() {
    return [
      new Plugin<AttachmentView[]>({
        key: picturesKey,
        state: {
          init: () => [],
          apply: (tr, files) => (tr.getMeta(picturesKey) as AttachmentView[] | undefined) ?? files,
        },
        props: {
          decorations(state) {
            const byName = new Map((picturesKey.getState(state) ?? []).flatMap((f) => (f.image ? [[f.name, f] as const] : [])))
            if (!byName.size) return null
            const out: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'paragraph') return true
              const text = node.textContent.trim()
              const file = text.startsWith(FILE_MARK) ? byName.get(text.slice(FILE_MARK.length)) : undefined
              if (file)
                out.push(
                  Decoration.widget(
                    pos + node.nodeSize,
                    () => {
                      const img = document.createElement('img')
                      img.src = file.url
                      img.alt = ''
                      img.className = 'md-picture'
                      img.draggable = false
                      img.contentEditable = 'false'
                      return img
                    },
                    // (The same picture in the same place is the same element: it isn't loaded again at every key.)
                    { key: `${file.id}@${pos}`, side: -1 },
                  ),
                )
              return false
            })
            return DecorationSet.create(state.doc, out)
          },
        },
      }),
    ]
  },
})

/** What a page holding the editor can ask of it. */
export interface EditorHandle {
  /** Goes to the nth heading (top-level ones, in order): the cursor is put there and it's scrolled into view. */
  toHeading: (n: number) => void
}

export interface EditorProps {
  /** Markdown. Read once when the editor opens (it then keeps its own copy). */
  value: string
  onChange: (markdown: string) => void
  onBlur?: () => void
  /** ⌘/Ctrl+Enter. */
  onSubmit?: () => void
  /** Esc (when no suggestion list is open). */
  onEscape?: () => void
  /** People to suggest after "@" (leave out for no mentions). */
  members?: Member[]
  /** Files to suggest after "#": picking one inserts a "📎name" reference. */
  files?: AttachmentView[]
  onMention?: (memberId: string) => void
  /**
   * Files pasted or dropped in. Return the attachments made to put a "📎name" reference to each where the cursor is
   * (descriptions), or nothing to leave the text alone (comments list them under the box).
   */
  onFiles?: (files: File[]) => Promise<AttachmentView[] | void> | void
  placeholder?: string
  autoFocus?: boolean
  /** Where the cursor starts (with autoFocus): a place in the text (see caret.ts). Left out: at the end. */
  caret?: Place
  /** ⌘/Ctrl+S: save, and keep writing. */
  onSave?: () => void
  /**
   * "/" opens a menu of things to put in: headings, lists, a table, a divider, and under "Mention" a card.
   * `light`: the short menu, for a comment (lists, a quote, code, and mentions).
   */
  inserts?: boolean | 'light'
  /** The cards "/" → Card offers (see app/card-refs). Left out: no Card in the menu. */
  cards?: CardSource
  /**
   * Pictures show in the text (a description): under a line that is only a picture's name, and a picture pasted or
   * dropped in gets such a line of its own.
   */
  pictures?: boolean
  /** Shown at the right of the toolbar (whether it's saved, say). */
  status?: ReactNode
  /** Adds "Write full page" to the toolbar: called with where the cursor is (see `caret`). */
  onExpand?: (caret: Place) => void
  /** box: a bordered field (the default). page: no box, the text as it will read, the toolbar stuck to the top. */
  look?: 'box' | 'page'
  /** Classes for the part the text is in (a height to scroll within, say). */
  scrollClassName?: string
  handle?: Ref<EditorHandle>
  'aria-label'?: string
  className?: string
}

/**
 * A light editor for descriptions and comments: headings, bold, italics, lists, checklists, quotes, links and code,
 * typed with Markdown shortcuts ("## ", "- ", "[ ] ", ⌘B) or the small toolbar, which stays in view. It reads and
 * writes Markdown, and keeps what the plain text box did: "@" suggests people, "#" the card's files, and files pasted
 * or dropped in are attached. Markdown pasted as plain text goes in formatted. Where asked for (`inserts`), "/" opens
 * a menu of things to put in (and, inside a table, its rows and columns).
 */
export default function Editor({
  value,
  onChange,
  onBlur,
  onSubmit,
  onEscape,
  members = [],
  files = [],
  onMention,
  onFiles,
  placeholder,
  autoFocus,
  caret,
  onSave,
  inserts,
  cards,
  pictures,
  status,
  onExpand,
  look = 'box',
  scrollClassName,
  handle,
  className,
  ...rest
}: EditorProps) {
  const [query, setQuery] = useState<({ from: number; kind: '@' | '#' | '/'; q: string; table?: boolean } & Spot) | null>(null)
  const [active, setActive] = useState(0)
  /** "/" → Card, being chosen: where in the text the card's name goes, and where the list shows. */
  const [picking, setPicking] = useState<({ at: number } & Spot) | null>(null)
  /** The same, for what happens between two draws (choosing a card moves the cursor, which the list sees as being left). */
  const pickingAt = useRef<number | null>(null)
  const wrap = useRef<HTMLDivElement>(null)

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!query) return []
    const q = query.q.toLowerCase()
    if (query.kind === '/') {
      const found = INSERTS.filter(
        (c) =>
          (c.mention || !!c.table === !!query.table) &&
          (inserts !== 'light' || c.light) &&
          (c.step !== 'card' || !!cards) &&
          `${c.label} ${c.words ?? ''}`.toLowerCase().includes(q),
      )
      // Once something is typed, what starts with it comes first ("/li" is List, whatever else has those letters),
      // and the list is one list, not two parts.
      const named = (c: Insert) => c.label.toLowerCase().startsWith(q)
      return (q ? [...found.filter(named), ...found.filter((c) => !named(c))] : found).map((insert) => ({ kind: '/', insert }))
    }
    return query.kind === '@'
      ? members
          .filter((m) => m.name.toLowerCase().includes(q))
          .slice(0, 6)
          .map((member) => ({ kind: '@', member }))
      : files
          .filter((f) => f.name.toLowerCase().includes(q))
          .slice(0, 8)
          .map((file) => ({ kind: '#', file }))
  }, [query, members, files, inserts, cards])

  // The "/" menu is in two parts when it has both: things to mention, then things to put in.
  const grouped = useMemo(() => !query?.q && new Set(suggestions.map(groupOf)).size > 1, [suggestions, query?.q])

  // The latest props and state, for ProseMirror's handlers (set up once).
  const live = useRef({ suggestions, active, query, onSubmit, onEscape, onSave, onFiles, onMention, onChange, onBlur, members, files, inserts })
  useLayoutEffect(() => {
    live.current = { suggestions, active, query, onSubmit, onEscape, onSave, onFiles, onMention, onChange, onBlur, members, files, inserts }
  })

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        underline: false,
        link: { openOnClick: false, autolink: true, protocols: ['mailto'], defaultProtocol: 'https' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // Tables aren't made here, but ones already in the text (often from assistants) survive editing.
      TableKit,
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      Markdown,
      ...(pictures ? [Pictures] : []),
    ],
    content: forEditor(value),
    contentType: 'markdown',
    autofocus: autoFocus && caret === undefined ? 'end' : false,
    onCreate: ({ editor }) => {
      if (!autoFocus || caret === undefined) return
      // (Once it's on the page: the place is found in the text, then scrolled to.)
      requestAnimationFrame(() => !editor.isDestroyed && editor.commands.focus(posAt(editor.state.doc, caret) ?? 'end'))
    },
    editorProps: {
      attributes: { class: cn('md', className), 'aria-label': rest['aria-label'] ?? '', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (_view, e) => {
        const { suggestions, active, onSubmit, onSave } = live.current
        if (suggestions.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
            return true
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            pick(suggestions[active])
            return true
          }
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
          onSubmit()
          return true
        }
        if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && onSave) {
          e.preventDefault()
          onSave()
          return true
        }
        return false
      },
      handlePaste: (_view, e) => {
        const pasted = [...(e.clipboardData?.files ?? [])]
        if (live.current.onFiles && pasted.length) {
          void addFiles(pasted)
          return true
        }
        // Markdown pasted as plain text (from an assistant, a file, a code editor) goes in formatted. Text copied
        // from a page comes with its own formatting, and what's pasted into code stays as typed.
        const data = e.clipboardData
        const text = data?.getData('text/plain') ?? ''
        const plain = !data?.getData('text/html') || data.types.includes('vscode-editor-data')
        const ed = editorRef.current
        if (!ed || !text || !plain || ed.isActive('codeBlock') || ed.isActive('code') || !looksLikeMarkdown(text)) return false
        ed.chain().focus().insertContent(forEditor(text), { contentType: 'markdown' }).run()
        return true
      },
      handleDrop: (view, e) => {
        const dropped = [...(e.dataTransfer?.files ?? [])]
        if (!live.current.onFiles || !dropped.length) return false
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
        if (at) editorRef.current?.commands.setTextSelection(at.pos)
        void addFiles(dropped)
        return true
      },
    },
    onUpdate: ({ editor }) => {
      live.current.onChange(tidyMarkdown(editor.getMarkdown()))
      track(editor)
    },
    onSelectionUpdate: ({ editor }) => track(editor),
    onBlur: ({ event }) => {
      setTimeout(() => setQuery(null), 150)
      // Typing a link's address (in its little box), or finding a card to mention, isn't leaving the editor.
      const to = event.relatedTarget as HTMLElement | null
      if (to?.closest('[data-radix-popper-content-wrapper]') || (to && wrap.current?.contains(to))) return
      live.current.onBlur?.()
    },
  })
  const editorRef = useRef<TiptapEditor | null>(null)
  useLayoutEffect(() => {
    editorRef.current = editor
  }, [editor])
  // The card's files changed (one was attached just now, or removed): the pictures drawn in the text are looked at
  // again. (A change of nothing: the text isn't touched.)
  useEffect(() => {
    if (pictures && editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(picturesKey, files))
  }, [pictures, editor, files])

  // Esc while the cursor is in here is the editor's: it closes an open list of suggestions, else leaves the editor
  // (`onEscape`). It's caught before anything around it (a dialog would close on it), so one Esc never does two things.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ed = editorRef.current
      // (In the list of cards to mention, Esc closes the list and the cursor is back in the text.)
      if (e.key === 'Escape' && ed && pickingAt.current !== null) {
        e.stopPropagation()
        e.preventDefault()
        pickingAt.current = null
        setPicking(null)
        return ed.view.focus()
      }
      if (e.key !== 'Escape' || !ed?.isFocused) return
      e.stopPropagation()
      // (While composing a character, Esc only cancels that.)
      if (e.isComposing) return
      e.preventDefault()
      if (live.current.suggestions.length) setQuery(null)
      else if (live.current.onEscape) live.current.onEscape()
      else ed.commands.blur()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useImperativeHandle(
    handle,
    () => ({
      toHeading: (n) => {
        const ed = editorRef.current
        const el = ed && [...ed.view.dom.children].filter((x) => /^H[1-6]$/.test(x.tagName))[n]
        if (!ed || !el) return
        ed.commands.focus(ed.view.posAtDOM(el, 0), { scrollIntoView: false })
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
    }),
    [],
  )

  /** An "@word" or "#word" being typed right before the cursor, or a "/" asking for the menu of things to put in. */
  function track(ed: TiptapEditor) {
    const { $from, empty } = ed.state.selection
    const before = empty ? $from.parent.textBetween(Math.max(0, $from.parentOffset - 60), $from.parentOffset, undefined, '￼') : ''
    const place = (from: number): Spot => {
      const at = ed.view.coordsAtPos(from)
      const box = wrap.current!.getBoundingClientRect()
      // What a list has to fit in: the screen (less a phone's keyboard), and the window the editor is in, which cuts
      // off what sticks out of it.
      const frame = wrap.current!.closest('[role="dialog"]')?.getBoundingClientRect()
      const seen = window.visualViewport
      const below = Math.min(seen ? seen.offsetTop + seen.height : window.innerHeight, frame?.bottom ?? Infinity) - at.bottom
      const above = at.top - Math.max(seen?.offsetTop ?? 0, frame?.top ?? 0)
      // Under the cursor; over it when there's little room under and more over (a comment box at the foot of a card).
      const up = below < 280 && above > below
      return {
        ...(up ? { bottom: box.bottom - at.top + 4 } : { top: at.bottom - box.top + 4 }),
        left: Math.min(at.left - box.left, box.width - 256),
        room: Math.max(120, (up ? above : below) - 12),
      }
    }
    const slash = live.current.inserts && wrap.current && !ed.isActive('codeBlock') ? before.match(/(^|\s)\/([a-z0-9]{0,20})$/i) : null
    if (slash) {
      const from = $from.pos - slash[2].length - 1
      setQuery({ from, kind: '/', q: slash[2], table: ed.isActive('table'), ...place(from) })
      return setActive(0)
    }
    const m = before.match(/(^|\s)([@#])([^\s@#]{0,40})$/)
    const kind = m?.[2] as '@' | '#' | undefined
    const { members, files } = live.current
    const usable = kind === '@' ? members.length > 0 : kind === '#' ? files.length > 0 : false
    if (!m || !usable || !wrap.current) return setQuery(null)
    const from = $from.pos - m[3].length - 1
    setQuery({ from, kind: kind!, q: m[3], ...place(from) })
    setActive(0)
  }

  function pick(s: Suggestion) {
    const ed = editorRef.current
    const q = live.current.query
    if (!ed || !q) return
    if (s.kind === '/') {
      // The "/" and what was typed after it go; the thing asked for comes in their place.
      const cleared = ed.chain().focus().deleteRange({ from: q.from, to: ed.state.selection.from })
      if (s.insert.run) s.insert.run(cleared).run()
      else {
        // (A card: it's chosen first, in a list of its own, shown where the menu was.)
        cleared.run()
        pickingAt.current = q.from
        // (The list is wider than the menu: kept inside the box.)
        setPicking({
          at: q.from,
          top: q.top,
          bottom: q.bottom,
          room: q.room,
          left: Math.max(0, Math.min(q.left, (wrap.current?.clientWidth ?? 320) - 320)),
        })
      }
      return setQuery(null)
    }
    const text = s.kind === '@' ? `@${s.member.name} ` : `${FILE_MARK}${s.file.name} `
    ed.chain().focus().insertContentAt({ from: q.from, to: ed.state.selection.from }, text).run()
    if (s.kind === '@') live.current.onMention?.(s.member.id)
    setQuery(null)
  }

  /** A card was chosen to mention: its name goes in as text (shown as a link once saved: see RichText). */
  function mention(card: CardPick | null) {
    const ed = editorRef.current
    const at = pickingAt.current
    pickingAt.current = null
    setPicking(null)
    if (!ed || at === null) return
    // (The cursor goes back at once, not a frame later as `focus()` alone would: what's typed next belongs to the text.)
    ed.view.focus()
    if (card) ed.chain().focus().insertContentAt(Math.min(at, ed.state.doc.content.size), `${card.ref} `).run()
  }
  /** The list of cards lost the cursor: to the text (carry on writing), or to somewhere else (that's leaving the editor). */
  function leftPicker(to: Element | null) {
    if (pickingAt.current === null) return
    pickingAt.current = null
    setPicking(null)
    if (!to || !wrap.current?.contains(to)) live.current.onBlur?.()
  }

  async function addFiles(list: File[]) {
    const added = await live.current.onFiles?.(list)
    const ed = editorRef.current
    if (!added?.length || !ed) return
    // Where pictures show in the text, a picture gets a line of its own (so it is drawn there); any other file is
    // named where the cursor is.
    const shown = pictures ? added.filter((a) => a.image) : []
    const named = added.filter((a) => !shown.includes(a))
    const chain = ed.chain().focus()
    if (named.length) chain.insertContent(named.map((a) => `${FILE_MARK}${a.name} `).join(''))
    if (shown.length) chain.insertContent(shown.map((a) => ({ type: 'paragraph', content: [{ type: 'text', text: `${FILE_MARK}${a.name}` }] })))
    chain.run()
  }

  const page = look === 'page'
  return (
    <div ref={wrap} className={cn('relative', !page && 'rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring/30')}>
      {editor && <Toolbar editor={editor} page={page} status={status} onExpand={onExpand && (() => onExpand(placeOf(editor)))} />}
      <EditorContent editor={editor} className={cn(!page && 'px-3 py-2', scrollClassName)} />
      {query && suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label={query.kind === '/' ? 'Put in' : undefined}
          className="absolute z-50 w-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
          style={{ top: query.top, bottom: query.bottom, left: Math.max(0, query.left), maxHeight: Math.min(344, query.room) }}
        >
          {suggestions.map((s, i) => (
            <li
              key={s.kind === '@' ? s.member.id : s.kind === '#' ? s.file.id : s.insert.id}
              role="option"
              aria-selected={i === active}
              ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={cn(grouped && i > 0 && groupOf(s) !== groupOf(suggestions[i - 1]) && 'mt-1 border-t pt-1')}
            >
              {grouped && (i === 0 || groupOf(s) !== groupOf(suggestions[i - 1])) && (
                <span className="block px-2 pt-1 pb-0.5 text-[11px] text-muted-foreground">{groupOf(s)}</span>
              )}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm', i === active && 'bg-accent')}
              >
                {s.kind === '@' ? (
                  <>
                    <Avatar name={s.member.name} picture={s.member.picture} className="size-5 text-[9px]" /> {s.member.name}
                  </>
                ) : s.kind === '#' ? (
                  <>
                    <File className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{s.file.name}</span>
                  </>
                ) : (
                  <>
                    <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&>svg]:size-4">{s.insert.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{s.insert.label}</span>
                    {s.insert.hint && <span className="font-mono text-xs text-muted-foreground">{s.insert.hint}</span>}
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {picking && cards && <CardPicker source={cards} spot={picking} onDone={mention} onLeft={leftPicker} />}
    </div>
  )
}

/** Where a list of suggestions shows, from the editor's corner: under the cursor or over it, and how tall it may be. */
interface Spot {
  top?: number
  bottom?: number
  left: number
  room: number
}

/**
 * "/" → Card: a card to mention, found by its title or its number. This board's cards show at once (they're in
 * memory); other boards' follow a moment after typing stops. Enter or a click puts the card's name in the text; Esc,
 * or going elsewhere, closes it.
 */
function CardPicker({
  source,
  spot,
  onDone,
  onLeft,
}: {
  source: CardSource
  spot: Spot
  /** The card chosen. */
  onDone: (card: CardPick) => void
  /** The cursor went out of the list, to this (nothing: out of the page). */
  onLeft: (to: Element | null) => void
}) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [more, setMore] = useState<{ q: string; cards: CardPick[] } | null>(null)
  const typed = q.trim()
  const here = useMemo(() => source.here(typed), [source, typed])
  useEffect(() => {
    if (!source.elsewhere || typed.length < 2) return
    let alive = true
    const t = setTimeout(() => {
      void source.elsewhere!(typed).then(
        (cards) => alive && setMore({ q: typed, cards }),
        () => {},
      )
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [source, typed])
  // (What was found for other words isn't shown under these ones.)
  const others = more?.q === typed && typed.length >= 2 ? more.cards : []
  const all = [...here, ...others]
  const row = (c: CardPick, i: number) => (
    <li key={c.ref} role="option" aria-selected={i === active} ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onDone(c)}
        className={cn('flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm', i === active && 'bg-accent')}
      >
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{c.ref}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{c.title}</span>
          {c.where && <span className="block truncate text-xs text-muted-foreground">{c.where}</span>}
        </span>
      </button>
    </li>
  )
  return (
    <div
      role="dialog"
      aria-label="Mention a card"
      className="absolute z-50 w-80 max-w-[calc(100%-0.5rem)] rounded-md border bg-popover p-1 shadow-md"
      style={{ top: spot.top, bottom: spot.bottom, left: spot.left }}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && onLeft(e.relatedTarget)}
    >
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (all.length) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length)
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            e.stopPropagation()
            if (all[active]) onDone(all[active])
          }
          // (Esc is the editor's: it closes this and puts the cursor back in the text.)
        }}
        aria-label="Find a card"
        placeholder="Find a card by its title or number"
        className="mb-1 w-full rounded border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/30"
      />
      <ul role="listbox" aria-label="Cards" className="overflow-y-auto" style={{ maxHeight: Math.min(256, spot.room - 48) }}>
        {here.map((c, i) => row(c, i))}
        {others.length > 0 && <li className="mt-1 border-t px-2 pt-2 pb-0.5 text-[11px] text-muted-foreground">On other boards</li>}
        {others.map((c, i) => row(c, here.length + i))}
        {!all.length && <li className="px-2 py-1.5 text-sm text-muted-foreground">No cards found.</li>}
      </ul>
    </div>
  )
}

/** Where the cursor is, as a place in the text (see caret.ts). */
function placeOf(editor: TiptapEditor): Place {
  const { doc, selection } = editor.state
  return { after: counted(doc.textBetween(0, selection.head, '', '')), lineStart: selection.$head.parentOffset === 0 }
}

/**
 * Bold, italics, a heading, lists, a quote, a link and code: the basics, one click each (the Markdown shortcuts work
 * too). It stays in view while the text scrolls under it. On the right: what the page holding it has to say (saved or
 * not), and the way to full page.
 */
function Toolbar({ editor, page, status, onExpand }: { editor: TiptapEditor; page: boolean; status?: ReactNode; onExpand?: () => void }) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      heading: e.isActive('heading', { level: 2 }),
      bullets: e.isActive('bulletList'),
      numbers: e.isActive('orderedList'),
      tasks: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      code: e.isActive('code') || e.isActive('codeBlock'),
    }),
  })
  const run = (f: (c: ReturnType<TiptapEditor['chain']>) => ReturnType<TiptapEditor['chain']>) => () => f(editor.chain().focus()).run()
  const tools = (
    <>
      <Tool label="Bold (⌘B)" on={on.bold} onClick={run((c) => c.toggleBold())}>
        <TextB weight="bold" />
      </Tool>
      <Tool label="Italic (⌘I)" on={on.italic} onClick={run((c) => c.toggleItalic())}>
        <TextItalic />
      </Tool>
      <Tool label="Heading (## )" on={on.heading} onClick={run((c) => c.toggleHeading({ level: 2 }))}>
        <TextHTwo />
      </Tool>
      <span className="mx-1 h-4 w-px shrink-0 bg-border" />
      <Tool label="List (- )" on={on.bullets} onClick={run((c) => c.toggleBulletList())}>
        <ListBullets />
      </Tool>
      <Tool label="Numbered list (1. )" on={on.numbers} onClick={run((c) => c.toggleOrderedList())}>
        <ListNumbers />
      </Tool>
      <Tool label="Checklist ([ ] )" on={on.tasks} onClick={run((c) => c.toggleTaskList())}>
        <CheckSquare />
      </Tool>
      <Tool label="Quote (> )" on={on.quote} onClick={run((c) => c.toggleBlockquote())}>
        <Quotes />
      </Tool>
      <span className="mx-1 h-4 w-px shrink-0 bg-border" />
      <LinkTool editor={editor} on={on.link} />
      <Tool label="Code (`)" on={on.code} onClick={run((c) => (editor.state.selection.empty ? c.toggleCodeBlock() : c.toggleCode()))}>
        <Code />
      </Tool>
    </>
  )
  const bar = (
    <div
      className={cn('flex items-center bg-background px-1.5 py-1', page ? 'rounded-lg border shadow-xs' : 'sticky top-0 z-10 rounded-t-lg border-b')}
      onMouseDown={(e) => e.target !== e.currentTarget && e.preventDefault()}
    >
      {/* (On a very narrow screen the tools slide sideways; what's on the right stays put.) */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">{tools}</div>
      {(status || onExpand) && (
        <div className="flex shrink-0 items-center gap-1 pl-2">
          {status}
          {onExpand && (
            <Tool label="Write full page" onClick={onExpand}>
              <ArrowsOut />
            </Tool>
          )}
        </div>
      )}
    </div>
  )
  // Full page: it sticks to the top on a strip of the page's own background, so the text slides under it cleanly.
  return page ? <div className="sticky top-0 z-10 mb-3 bg-popover pt-2 pb-2">{bar}</div> : bar
}

function Tool({ label, on, onClick, children }: { label: string; on?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
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

/** A link on the selected words: type or paste the address; empty removes it. */
function LinkTool({ editor, on }: { editor: TiptapEditor; on: boolean }) {
  const [open, setOpen] = useState(false)
  const [href, setHref] = useState('')
  const apply = () => {
    const url = href.trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (!url) chain.unsetLink().run()
    else {
      const full = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`
      if (editor.state.selection.empty && !on)
        chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: full } }] }).run()
      else chain.setLink({ href: full }).run()
    }
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setHref((editor.getAttributes('link').href as string | undefined) ?? '')
      }}
    >
      <PopoverTrigger asChild>
        <span>
          <Tool label="Link" on={on}>
            <LinkSimple />
          </Tool>
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
          className="flex gap-1.5"
        >
          <input
            autoFocus
            value={href}
            onChange={(e) => setHref(e.target.value)}
            placeholder="Paste a link"
            aria-label="Link address"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <button type="submit" className="h-8 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground">
            {href.trim() ? 'Add' : 'Remove'}
          </button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
