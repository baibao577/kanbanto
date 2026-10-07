import { ChatCircle, File, Paperclip, X } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AttachmentView, CommentView } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { useAuth } from '@/app/use-auth'
import { Avatar } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { uploadFile, type CardFiles } from '@/data/cardFiles'
import { formatSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/text/Markdown'
import { Folded } from './Description'
import { Section } from './Section'

const Editor = lazy(() => import('@/components/text/Editor'))

type Member = { id: string; name: string }

/**
 * A card's conversation. Everyone on the board can comment (viewers too), @mention people, attach files to their
 * comment (📎, paste or drop), and refer to any of the card's files with #.
 */
export function CommentsSection({
  taskId,
  cardFiles,
  column,
}: {
  taskId: string
  cardFiles: CardFiles
  /**
   * As the card's third column (wide screens): read like a chat, oldest first, scrolling on its own, with the box to
   * write in pinned under it. Otherwise a section of the card: the box first, newest comment next.
   */
  column?: boolean
}) {
  const { data, canComment, access, onActivity } = useBoard()
  const { user } = useAuth()
  const boardId = data.board.id
  const [items, setItems] = useState<CommentView[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  // The column keeps the latest comment in view, like a chat.
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (column && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [column, items.length])

  useEffect(() => {
    api<{ comments: CommentView[] }>('GET', `/boards/${boardId}/tasks/${taskId}/comments`).then(
      (r) => setItems(r.comments),
      () => {},
    )
    // Others' comments arrive live.
    return onActivity((m) => {
      if (m.type !== 'comment' || m.taskId !== taskId) return
      if (m.action === 'deleted') setItems((xs) => xs.filter((x) => x.id !== m.commentId))
      else if (m.comment)
        setItems((xs) => (xs.some((x) => x.id === m.commentId) ? xs.map((x) => (x.id === m.commentId ? m.comment! : x)) : [...xs, m.comment!]))
    })
  }, [boardId, taskId, onActivity])

  const post = async (body: string, mentions: string[], attachments: string[]) => {
    const r = await api<{ comment: CommentView }>('POST', `/boards/${boardId}/tasks/${taskId}/comments`, { body, mentions, attachments })
    setItems((xs) => (xs.some((x) => x.id === r.comment.id) ? xs : [...xs, r.comment]))
    r.comment.attachments.forEach(cardFiles.upsert)
  }
  const save = async (c: CommentView, body: string, mentions: string[], attachments: string[]) => {
    const r = await api<{ comment: CommentView }>('PATCH', `/boards/${boardId}/comments/${c.id}`, { body, mentions, attachments })
    setItems((xs) => xs.map((x) => (x.id === c.id ? r.comment : x)))
    r.comment.attachments.forEach(cardFiles.upsert)
    setEditing(null)
  }
  const remove = async (c: CommentView) => {
    if (!confirm(c.attachments.length ? 'Delete this comment and its files? This can’t be undone.' : 'Delete this comment? This can’t be undone.'))
      return
    try {
      await api('DELETE', `/boards/${boardId}/comments/${c.id}`)
      setItems((xs) => xs.filter((x) => x.id !== c.id))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const item = (c: CommentView) => {
    const mine = c.author?.id === user?.id
    return (
      <li key={c.id} className="group flex gap-3">
        <Avatar name={c.author?.name ?? '?'} picture={c.author?.picture} className="mt-0.5 size-7 text-[10px]" />
        <div className="min-w-0 flex-1">
          <p className="text-xs">
            <span className="font-semibold">{c.author?.name ?? 'Someone'}</span>{' '}
            <span className="text-muted-foreground" title={new Date(c.createdAt).toLocaleString()}>
              {formatDistanceToNow(parseISO(c.createdAt), { addSuffix: true })}
              {c.editedAt && ' (edited)'}
            </span>
          </p>
          {editing === c.id ? (
            <Composer
              boardId={boardId}
              taskId={taskId}
              members={data.members}
              files={cardFiles.files}
              initial={c}
              onSubmit={(body, mentions, attachments) => save(c, body, mentions, attachments)}
              onCancel={() => setEditing(null)}
              submitLabel="Save"
            />
          ) : (
            <>
              <div className="mt-1 rounded-lg bg-muted/60">
                <Folded height={220}>
                  <Markdown text={c.body} mentions={data.members.filter((m) => c.mentions.includes(m.id))} files={cardFiles.files} />
                </Folded>
              </div>
              <FileList files={c.attachments} />
              {canComment && (mine || access.role === 'owner') && (
                <div className="mt-1 flex gap-3 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  {mine && (
                    <button className="hover:text-foreground hover:underline" onClick={() => setEditing(c.id)}>
                      Edit
                    </button>
                  )}
                  <button className="hover:text-destructive hover:underline" onClick={() => void remove(c)}>
                    Delete
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </li>
    )
  }
  const composer = canComment && (
    <div className={cn('flex gap-3', !column && 'mb-4')}>
      <Avatar name={user?.name ?? '?'} picture={user?.picture} className="mt-1 size-7 text-[10px]" />
      <Composer
        boardId={boardId}
        taskId={taskId}
        members={data.members}
        files={cardFiles.files}
        onSubmit={post}
        placeholder="Write a comment… @ to mention someone, # to point to a file."
        submitLabel="Comment"
      />
    </div>
  )

  if (column)
    return (
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Comments">
        <header className="mb-3 flex min-h-7 shrink-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
            <ChatCircle />
          </span>
          <h3 className="text-sm font-semibold">Comments</h3>
          {items.length > 0 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">{items.length}</span>
          )}
        </header>
        <ul ref={list} className="-mr-3 min-h-0 flex-1 space-y-4 overflow-y-auto pr-3 pb-2">
          {!items.length && <li className="text-xs text-muted-foreground">{canComment ? 'No comments yet. Start below.' : 'No comments yet.'}</li>}
          {items.map(item)}
        </ul>
        {composer && (
          <div
            className="shrink-0 border-t pt-3"
            // The box grows when you write: keep the latest comment in view above it.
            onFocusCapture={() => requestAnimationFrame(() => list.current && (list.current.scrollTop = list.current.scrollHeight))}
          >
            {composer}
          </div>
        )}
      </section>
    )

  return (
    <Section icon={<ChatCircle />} title="Comments" count={items.length}>
      {composer}
      {!canComment && !items.length && <p className="text-xs text-muted-foreground">No comments yet.</p>}
      <ul className="space-y-4">{[...items].reverse().map(item)}</ul>
    </Section>
  )
}

/** A comment's files: pictures as thumbnails, other files as chips. */
function FileList({ files, onRemove }: { files: AttachmentView[]; onRemove?: (f: AttachmentView) => void }) {
  if (!files.length) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {files.map((f) => (
        <li key={f.id} className="relative">
          <a
            href={f.url}
            target="_blank"
            rel="noreferrer"
            title={`${f.name} · ${formatSize(f.size)}`}
            className="flex items-center gap-2 overflow-hidden rounded-md border bg-background text-xs hover:bg-accent"
          >
            {f.image ? (
              <img src={f.url} alt={f.name} className="h-20 max-w-48 object-cover" loading="lazy" />
            ) : (
              <span className="flex items-center gap-1.5 px-2 py-1.5">
                <File className="size-4 text-muted-foreground" />
                <span className="max-w-40 truncate">{f.name}</span>
                <span className="text-muted-foreground">{formatSize(f.size)}</span>
              </span>
            )}
          </a>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${f.name}`}
              onClick={() => onRemove(f)}
              className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground shadow-xs hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * Writing or editing a comment: @ suggests people, # the card's files; 📎, paste or drop attaches files (uploaded
 * right away as drafts, attached when the comment is posted). A mention counts while its "@Name" is still in the text.
 * ⌘/Ctrl+Enter posts.
 */
function Composer({
  boardId,
  taskId,
  members,
  files,
  initial,
  onSubmit,
  onCancel,
  placeholder,
  submitLabel,
}: {
  boardId: string
  taskId: string
  members: Member[]
  files: AttachmentView[]
  initial?: CommentView
  onSubmit: (body: string, mentions: string[], attachments: string[]) => Promise<void>
  onCancel?: () => void
  placeholder?: string
  submitLabel: string
}) {
  const [text, setText] = useState(initial?.body ?? '')
  const [picked, setPicked] = useState<string[]>(initial?.mentions ?? [])
  const [drafts, setDrafts] = useState<AttachmentView[]>([])
  const [uploading, setUploading] = useState(0)
  const [busy, setBusy] = useState(false)
  // The editor loads when you start writing; a new one (empty) after each comment is posted.
  const [opened, setOpened] = useState(!!initial)
  const [round, setRound] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const attach = async (list: File[]) => {
    for (const f of list) {
      setUploading((n) => n + 1)
      try {
        const a = await uploadFile(boardId, taskId, f, true)
        setDrafts((d) => [...d, a])
      } catch (e) {
        toast.error(`Couldn’t attach “${f.name || 'the image'}”`, { description: errorMessage(e), duration: 8000 })
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const submit = async () => {
    const body = text.trim() || (drafts.length ? drafts.map((d) => `📎${d.name}`).join(' ') : '')
    if (!body || busy || uploading) return
    // Only people whose @Name is still in the text are mentioned.
    const mentions = picked.filter((id) => {
      const m = members.find((x) => x.id === id)
      return m && body.includes(`@${m.name}`)
    })
    setBusy(true)
    try {
      await onSubmit(
        body,
        mentions,
        drafts.map((d) => d.id),
      )
      if (!initial) {
        setText('')
        setPicked([])
        setDrafts([])
        setRound((r) => r + 1)
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const active = !!(text.trim() || initial || drafts.length || uploading)
  return (
    <div className="relative min-w-0 flex-1">
      {opened ? (
        <Suspense fallback={<div className="min-h-[5.5rem] rounded-lg border bg-background" />}>
          <Editor
            key={round}
            value={initial?.body ?? ''}
            onChange={setText}
            members={members}
            files={[...files, ...drafts]}
            onMention={(id) => setPicked((p) => (p.includes(id) ? p : [...p, id]))}
            onFiles={(fs) => void attach(fs)}
            onSubmit={() => void submit()}
            onEscape={onCancel}
            autoFocus
            placeholder={placeholder}
            aria-label={initial ? 'Edit comment' : 'Write a comment'}
            className="min-h-12"
            // A long comment scrolls inside its box: left to grow, it pushes the card's window past what can be
            // scrolled back (beside the card, the column has nowhere to go), and the buttons under it out of reach.
            scrollClassName="max-h-[min(45dvh,26rem)] overflow-y-auto overscroll-contain"
          />
        </Suspense>
      ) : (
        <button
          type="button"
          onClick={() => setOpened(true)}
          className="block w-full rounded-lg border bg-background px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/40"
        >
          {placeholder}
        </button>
      )}
      <FileList files={drafts} onRemove={(f) => setDrafts((d) => d.filter((x) => x.id !== f.id))} />
      {uploading > 0 && <p className="mt-1 animate-pulse text-xs text-muted-foreground">Uploading…</p>}
      <div className="mt-2 flex items-center gap-2">
        {active && (
          <Button size="sm" onClick={() => void submit()} disabled={busy || uploading > 0 || !(text.trim() || drafts.length)}>
            {submitLabel}
          </Button>
        )}
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1.5 text-muted-foreground"
          onClick={() => input.current?.click()}
          title="Attach files (or paste or drop them in the box)"
        >
          <Paperclip /> Attach
        </Button>
        {active && <span className="ml-auto text-[11px] text-muted-foreground">⌘/Ctrl + Enter</span>}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void attach([...e.target.files])
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
