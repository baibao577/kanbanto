import { useState } from 'react'
import type { CardFiles } from '@/data/cardFiles'
import { FILE_MARK, RichText } from './RichText'
import { SmartTextarea } from './SmartTextarea'

/**
 * The card's description: shown as text (with links to files referenced as 📎name) until clicked, then edited
 * in place. Type # to point to one of the card's files; files dropped or pasted in are attached to the card and
 * referenced where the cursor is. Saved when you click away.
 */
export function Description({
  value,
  readOnly,
  cardFiles,
  onSave,
}: {
  value: string
  readOnly: boolean
  cardFiles: CardFiles
  onSave: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)

  if (!editing) {
    if (!value && readOnly) return <p className="text-sm text-muted-foreground">No description.</p>
    return (
      <div
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? undefined : 0}
        onClick={() => {
          if (readOnly) return
          setText(value)
          setEditing(true)
        }}
        onKeyDown={(e) => {
          if (!readOnly && e.key === 'Enter' && e.target === e.currentTarget) {
            e.preventDefault()
            setText(value)
            setEditing(true)
          }
        }}
        className={
          value
            ? 'min-h-10 rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap hover:bg-muted/60'
            : 'min-h-16 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground hover:bg-muted'
        }
      >
        {value ? <RichText text={value} files={cardFiles.files} /> : 'Add more detail… Type # to point to a file.'}
      </div>
    )
  }

  const insertRefs = async (files: File[], at: HTMLTextAreaElement | null) => {
    const added = await cardFiles.add(files)
    if (!added.length) return
    const caret = at?.selectionStart ?? text.length
    const refs = added.map((a) => `${FILE_MARK}${a.name}`).join(' ')
    setText((t) => `${t.slice(0, caret)}${refs} ${t.slice(caret)}`)
  }

  return (
    <SmartTextarea
      value={text}
      onChange={setText}
      files={cardFiles.files}
      onFiles={(fs) => void insertRefs(fs, document.activeElement as HTMLTextAreaElement | null)}
      autoFocus
      aria-label="Description"
      placeholder="Add more detail… Type # to point to a file."
      onBlur={() => {
        setEditing(false)
        if (text !== value) onSave(text)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      className="min-h-24 w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none [field-sizing:content] focus-visible:ring-2 focus-visible:ring-ring/30"
    />
  )
}
