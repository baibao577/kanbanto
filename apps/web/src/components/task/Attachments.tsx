import { DownloadSimple, File, Paperclip, Trash, UploadSimple } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useRef, useState } from 'react'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import type { CardFiles } from '@/data/cardFiles'
import { formatSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Section } from './Section'

/** A card's files: pictures show as thumbnails; drop files anywhere on the section (or pick them) to attach. */
export function AttachmentsSection({ cardFiles }: { cardFiles: CardFiles }) {
  const { readOnly } = useBoard()
  // The card's own files (files in comments show with their comment).
  const items = cardFiles.files.filter((f) => !f.commentId)
  const { uploading, add, remove } = cardFiles
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  if (readOnly && !items.length) return null
  return (
    <div
      onDragOver={(e) => {
        if (readOnly || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        if (readOnly || !e.dataTransfer.files.length) return
        e.preventDefault()
        setOver(false)
        void add(e.dataTransfer.files)
      }}
      // The drop highlight is an outline, so it takes no room and the section lines stay aligned.
      className={cn('outline-offset-8', over && 'rounded-lg outline-2 outline-primary/60 outline-dashed')}
    >
      <Section
        icon={<Paperclip />}
        title="Files"
        count={items.length}
        aside={
          !readOnly && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => input.current?.click()}>
              <UploadSimple /> Attach
            </Button>
          )
        }
      >
        {items.length > 0 && (
          <ul className="space-y-1.5">
            {items.map((a) => (
              <li key={a.id} className="group flex items-center gap-3 rounded-md p-1 hover:bg-accent/60">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="grid h-12 w-16 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted text-muted-foreground"
                >
                  {a.image ? <img src={a.url} alt="" className="size-full object-cover" loading="lazy" /> : <File className="size-5" />}
                </a>
                <div className="min-w-0 flex-1">
                  <a href={a.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
                    {a.name}
                  </a>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatSize(a.size)} · {a.uploader ?? 'Someone'} · {formatDistanceToNow(parseISO(a.createdAt), { addSuffix: true })}
                  </p>
                </div>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${a.name}`}
                  className="grid size-7 place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                >
                  <DownloadSimple className="size-4" />
                </a>
                {!readOnly && (
                  <button
                    aria-label={`Remove ${a.name}`}
                    onClick={() => void remove(a)}
                    className="grid size-7 place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                  >
                    <Trash className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {uploading.map((n, i) => (
          <p key={`${n}-${i}`} className="mt-1 animate-pulse text-xs text-muted-foreground">
            Uploading {n}…
          </p>
        ))}
        {!readOnly && !items.length && !uploading.length && (
          <button
            onClick={() => input.current?.click()}
            className="w-full rounded-md border border-dashed px-3 py-3 text-left text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            Drop files here, or click to choose
          </button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void add(e.target.files)
            e.target.value = ''
          }}
        />
      </Section>
    </div>
  )
}
