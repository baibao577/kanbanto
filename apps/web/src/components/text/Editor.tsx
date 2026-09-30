import { CheckSquare, Code, File, LinkSimple, ListBullets, TextB, TextHTwo, TextItalic } from '@phosphor-icons/react'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentView } from '@kanbanto/model/api'
import { Avatar } from '@/components/common/bits'
import { FILE_MARK } from '@/components/task/RichText'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { forEditor, tidyMarkdown } from './mdText'

type Member = { id: string; name: string }
type Suggestion = { kind: '@'; member: Member } | { kind: '#'; file: AttachmentView }

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
  'aria-label'?: string
  className?: string
}

/**
 * A light editor for descriptions and comments: headings, bold, italics, lists, checklists, links and code, typed with
 * Markdown shortcuts ("## ", "- ", "[ ] ", ⌘B) or the small toolbar. It reads and writes Markdown, and keeps what the
 * plain text box did: "@" suggests people, "#" the card's files, and files pasted or dropped in are attached.
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
  className,
  ...rest
}: EditorProps) {
  const [query, setQuery] = useState<{ from: number; kind: '@' | '#'; q: string; top: number; left: number } | null>(null)
  const [active, setActive] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!query) return []
    const q = query.q.toLowerCase()
    return query.kind === '@'
      ? members
          .filter((m) => m.name.toLowerCase().includes(q))
          .slice(0, 6)
          .map((member) => ({ kind: '@', member }))
      : files
          .filter((f) => f.name.toLowerCase().includes(q))
          .slice(0, 8)
          .map((file) => ({ kind: '#', file }))
  }, [query, members, files])

  // The latest props and state, for ProseMirror's handlers (set up once).
  const live = useRef({ suggestions, active, query, onSubmit, onEscape, onFiles, onMention, onChange, onBlur, members, files })
  useLayoutEffect(() => {
    live.current = { suggestions, active, query, onSubmit, onEscape, onFiles, onMention, onChange, onBlur, members, files }
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
    ],
    content: forEditor(value),
    contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: cn('md', className), 'aria-label': rest['aria-label'] ?? '', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (_view, e) => {
        const { suggestions, active, onSubmit, onEscape } = live.current
        if (suggestions.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
            return true
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            pick(suggestions[active])
            return true
          }
          if (e.key === 'Escape') {
            e.stopPropagation()
            setQuery(null)
            return true
          }
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
          onSubmit()
          return true
        }
        if (e.key === 'Escape' && onEscape) {
          e.preventDefault()
          onEscape()
          return true
        }
        return false
      },
      handlePaste: (_view, e) => {
        const pasted = [...(e.clipboardData?.files ?? [])]
        if (!live.current.onFiles || !pasted.length) return false
        void addFiles(pasted)
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
      // Typing a link's address (in its little box) isn't leaving the editor.
      if ((event.relatedTarget as HTMLElement | null)?.closest('[data-radix-popper-content-wrapper]')) return
      live.current.onBlur?.()
    },
  })
  const editorRef = useRef<TiptapEditor | null>(null)
  useLayoutEffect(() => {
    editorRef.current = editor
  }, [editor])

  /** An "@word" or "#word" being typed right before the cursor. */
  function track(ed: TiptapEditor) {
    const { $from, empty } = ed.state.selection
    const before = empty ? $from.parent.textBetween(Math.max(0, $from.parentOffset - 60), $from.parentOffset, undefined, '￼') : ''
    const m = before.match(/(^|\s)([@#])([^\s@#]{0,40})$/)
    const kind = m?.[2] as '@' | '#' | undefined
    const { members, files } = live.current
    const usable = kind === '@' ? members.length > 0 : kind === '#' ? files.length > 0 : false
    if (!m || !usable || !wrap.current) return setQuery(null)
    const from = $from.pos - m[3].length - 1
    const at = ed.view.coordsAtPos(from)
    const box = wrap.current.getBoundingClientRect()
    setQuery({ from, kind: kind!, q: m[3], top: at.bottom - box.top + 4, left: Math.min(at.left - box.left, box.width - 256) })
    setActive(0)
  }

  function pick(s: Suggestion) {
    const ed = editorRef.current
    const q = live.current.query
    if (!ed || !q) return
    const text = s.kind === '@' ? `@${s.member.name} ` : `${FILE_MARK}${s.file.name} `
    ed.chain().focus().insertContentAt({ from: q.from, to: ed.state.selection.from }, text).run()
    if (s.kind === '@') live.current.onMention?.(s.member.id)
    setQuery(null)
  }

  async function addFiles(list: File[]) {
    const added = await live.current.onFiles?.(list)
    const ed = editorRef.current
    if (!added?.length || !ed) return
    ed.chain()
      .focus()
      .insertContent(added.map((a) => `${FILE_MARK}${a.name} `).join(''))
      .run()
  }

  return (
    <div ref={wrap} className="relative rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring/30">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="px-3 py-2" />
      {query && suggestions.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-50 w-64 overflow-hidden rounded-md border bg-popover p-1 shadow-md"
          style={{ top: query.top, left: Math.max(0, query.left) }}
        >
          {suggestions.map((s, i) => (
            <li key={s.kind === '@' ? s.member.id : s.file.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm', i === active && 'bg-accent')}
              >
                {s.kind === '@' ? (
                  <>
                    <Avatar name={s.member.name} className="size-5 text-[9px]" /> {s.member.name}
                  </>
                ) : (
                  <>
                    <File className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{s.file.name}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Bold, italics, a heading, lists, a link and code: the basics, one click each (the Markdown shortcuts work too). */
function Toolbar({ editor }: { editor: TiptapEditor }) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      heading: e.isActive('heading', { level: 2 }),
      bullets: e.isActive('bulletList'),
      tasks: e.isActive('taskList'),
      link: e.isActive('link'),
      code: e.isActive('code') || e.isActive('codeBlock'),
    }),
  })
  const run = (f: (c: ReturnType<TiptapEditor['chain']>) => ReturnType<TiptapEditor['chain']>) => () => f(editor.chain().focus()).run()
  return (
    <div className="flex items-center gap-0.5 border-b px-1.5 py-1" onMouseDown={(e) => e.target !== e.currentTarget && e.preventDefault()}>
      <Tool label="Bold (⌘B)" on={on.bold} onClick={run((c) => c.toggleBold())}>
        <TextB weight="bold" />
      </Tool>
      <Tool label="Italic (⌘I)" on={on.italic} onClick={run((c) => c.toggleItalic())}>
        <TextItalic />
      </Tool>
      <Tool label="Heading (## )" on={on.heading} onClick={run((c) => c.toggleHeading({ level: 2 }))}>
        <TextHTwo />
      </Tool>
      <span className="mx-1 h-4 w-px bg-border" />
      <Tool label="List (- )" on={on.bullets} onClick={run((c) => c.toggleBulletList())}>
        <ListBullets />
      </Tool>
      <Tool label="Checklist ([ ] )" on={on.tasks} onClick={run((c) => c.toggleTaskList())}>
        <CheckSquare />
      </Tool>
      <span className="mx-1 h-4 w-px bg-border" />
      <LinkTool editor={editor} on={on.link} />
      <Tool label="Code (`)" on={on.code} onClick={run((c) => (editor.state.selection.empty ? c.toggleCodeBlock() : c.toggleCode()))}>
        <Code />
      </Tool>
    </div>
  )
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
        'grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-4',
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
