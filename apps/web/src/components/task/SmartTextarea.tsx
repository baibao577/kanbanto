import { File } from '@phosphor-icons/react'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type TextareaHTMLAttributes } from 'react'
import type { AttachmentView } from '@kanbanto/model/api'
import { Avatar } from '@/components/common/bits'
import { cn } from '@/lib/utils'
import { FILE_MARK } from './RichText'

type Member = { id: string; name: string }
type Suggestion = { kind: '@'; member: Member } | { kind: '#'; file: AttachmentView }

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  /** People to suggest after "@" (leave out for no mentions). */
  members?: Member[]
  /** Files to suggest after "#": picking one inserts a "📎name" reference. */
  files?: AttachmentView[]
  onMention?: (memberId: string) => void
  /** Files pasted or dropped into the box. */
  onFiles?: (files: File[]) => void
}

/**
 * A text box that suggests people after "@" and the card's files after "#". Picking inserts "@Name" or
 * "📎file name" as plain text, which is shown as a highlight or a file chip when the text is displayed.
 */
export const SmartTextarea = forwardRef<HTMLTextAreaElement, Props>(function SmartTextarea(
  { value, onChange, members = [], files = [], onMention, onFiles, onKeyDown, onBlur, className, ...rest },
  ref,
) {
  const box = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => box.current!)
  const [query, setQuery] = useState<{ start: number; kind: '@' | '#'; q: string } | null>(null)
  const [active, setActive] = useState(0)

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

  /** An "@word" or "#word" being typed right before the cursor. */
  const track = (text: string, caret: number) => {
    const m = text.slice(0, caret).match(/(^|\s)([@#])([^\s@#]{0,40})$/)
    const kind = m?.[2] as '@' | '#' | undefined
    const usable = kind === '@' ? members.length > 0 : kind === '#' ? files.length > 0 : false
    setQuery(m && usable ? { start: caret - m[3].length - 1, kind: kind!, q: m[3] } : null)
    setActive(0)
  }

  const pick = (s: Suggestion) => {
    if (!query) return
    const caret = box.current?.selectionStart ?? value.length
    const insert = s.kind === '@' ? `@${s.member.name} ` : `${FILE_MARK}${s.file.name} `
    onChange(`${value.slice(0, query.start)}${insert}${value.slice(caret)}`)
    if (s.kind === '@') onMention?.(s.member.id)
    setQuery(null)
    const pos = query.start + insert.length
    requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="relative">
      <textarea
        ref={box}
        value={value}
        {...rest}
        onChange={(e) => {
          onChange(e.target.value)
          track(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={(e) => {
          if (suggestions.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(suggestions[active])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setQuery(null)
              return
            }
          }
          onKeyDown?.(e)
        }}
        onBlur={(e) => {
          setTimeout(() => setQuery(null), 150)
          onBlur?.(e)
        }}
        onPaste={(e) => {
          const pasted = [...e.clipboardData.files]
          if (!onFiles || !pasted.length) return
          e.preventDefault()
          onFiles(pasted)
        }}
        onDragOver={(e) => {
          if (onFiles && e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (!onFiles || !e.dataTransfer.files.length) return
          e.preventDefault()
          onFiles([...e.dataTransfer.files])
        }}
        className={className}
      />
      {suggestions.length > 0 && (
        <ul role="listbox" className="absolute z-50 mt-1 w-64 overflow-hidden rounded-md border bg-popover p-1 shadow-md">
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
})
