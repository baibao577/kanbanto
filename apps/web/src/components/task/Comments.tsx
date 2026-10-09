import { ArrowBendUpLeft, ArrowCounterClockwise, ChatCircle, Check, CheckCircle, File, Paperclip, X } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AttachmentView, CommentView } from '@kanbanto/model/api'
import { quoteLine, stillThere } from '@kanbanto/model/passages'
import { errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { useCardRefs, useCardSource } from '@/app/card-refs'
import { useAuth } from '@/app/use-auth'
import { Avatar } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import type { CardComments, Thread } from '@/data/cardComments'
import { uploadFile, type CardFiles } from '@/data/cardFiles'
import { formatSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/text/Markdown'
import { Folded } from './Description'
import { AddReaction, ReactionRow } from './Reactions'
import { Section } from './Section'

const Editor = lazy(() => import('@/components/text/Editor'))

type Member = { id: string; name: string }

/**
 * A card's conversation. Everyone on the board can comment (viewers too), @mention people, attach files to their
 * comment (📎, paste or drop), and refer to any of the card's files with #. A comment made on some words of the
 * description (on its full page) is here too, with those words quoted and the answers to it under it.
 */
export function CommentsSection({
  taskId,
  cardFiles,
  comments,
  onOpenPassage,
  column,
  bare,
}: {
  taskId: string
  cardFiles: CardFiles
  /** The card's comments (see data/cardComments.ts): the card keeps them, since the description's full page shows some too. */
  comments: CardComments
  /** Opens the description full page at the words a comment is about. */
  onOpenPassage?: (commentId: string) => void
  /**
   * As the card's third column (wide screens): read like a chat, oldest first, scrolling on its own, with the box to
   * write in pinned under it. Otherwise a section of the card: the box first, newest comment next.
   */
  column?: boolean
  /** Without its own heading: under the card's Comments tab, which already says what it is and how many (see CardActivity). */
  bare?: boolean
}) {
  const { data, canComment } = useBoard()
  const { user } = useAuth()
  const boardId = data.board.id
  const { items } = comments
  const description = (data.tasks[taskId] ?? data.archived?.[taskId])?.description ?? ''
  /** What is listed: each comment, and each comment about a passage with its answers under it. */
  const tops = items.filter((c) => !c.parentId || !items.some((x) => x.id === c.parentId))
  // The column keeps the latest comment in view, like a chat.
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (column && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [column, tops.length])

  const row = (c: CommentView) => {
    const thread = c.passage ? comments.threads.find((t) => t.root.id === c.id) : undefined
    return thread ? (
      <li key={c.id}>
        <PassageThread
          thread={thread}
          comments={comments}
          taskId={taskId}
          cardFiles={cardFiles}
          gone={!stillThere(description, thread.root.passage)}
          onOpen={onOpenPassage && (() => onOpenPassage(c.id))}
        />
      </li>
    ) : (
      <li key={c.id}>
        <CommentItem c={c} comments={comments} taskId={taskId} cardFiles={cardFiles} />
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
        onSubmit={async (body, mentions, attachments) => void (await comments.post(body, mentions, attachments))}
        placeholder="Write a comment… @ to mention someone, # to point to a file, / for a card or a list."
        submitLabel="Comment"
      />
    </div>
  )

  if (column)
    return (
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Comments">
        <header className={cn('mb-3 flex min-h-7 shrink-0 items-center gap-2.5', bare && 'hidden')}>
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
          {tops.map(row)}
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

  const body = (
    <>
      {composer}
      {!canComment && !items.length && <p className="text-xs text-muted-foreground">No comments yet.</p>}
      <ul className="space-y-4">{[...tops].reverse().map(row)}</ul>
    </>
  )
  if (bare) return body
  return (
    <Section icon={<ChatCircle />} title="Comments" count={items.length}>
      {body}
    </Section>
  )
}

/**
 * One comment: who, when, what it says, its files and the emoji it was answered with; its author edits it, and its
 * author or a board owner deletes it. `small`: an answer in a thread.
 */
export function CommentItem({
  c,
  comments,
  taskId,
  cardFiles,
  small,
}: {
  c: CommentView
  comments: CardComments
  taskId: string
  cardFiles: CardFiles
  small?: boolean
}) {
  const { data, canComment, access } = useBoard()
  const cardRefs = useCardRefs()
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const mine = c.author?.id === user?.id
  const reactions = c.reactions ?? []
  const react = (emoji: string, on: boolean) => {
    if (user) comments.react(c, emoji, on, { id: user.id, name: user.name }).catch((e) => toast.error(errorMessage(e)))
  }
  const remove = () => {
    const answers = comments.items.filter((x) => x.parentId === c.id).length
    const what = answers ? `Delete this comment and the ${answers === 1 ? 'answer' : `${answers} answers`} to it?` : 'Delete this comment?'
    if (!confirm(`${c.attachments.length ? what.replace('?', ' and its files?') : what} This can’t be undone.`)) return
    comments.remove(c).catch((e) => toast.error(errorMessage(e)))
  }
  /** What can be done with it: answer it with an emoji, and (its author, a board owner) change or delete it. */
  const actions = canComment && !editing && (
    <div
      className={cn(
        'items-center gap-3 text-xs text-muted-foreground',
        // Shown when the comment is pointed at. (Where nothing can be pointed at, the way to react is always there.)
        // Beside the name they take no room until then: the line is short there.
        small
          ? 'hidden shrink-0 group-hover/comment:flex focus-within:flex has-[[data-state=open]]:flex'
          : 'mt-1 flex opacity-0 group-hover/comment:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100',
        !reactions.length && (small ? 'touch-only:flex' : 'touch-only:opacity-100'),
        reactions.length > 0 && !(mine || access.role === 'owner') && 'hidden!',
      )}
    >
      {/* (Once a comment has reactions, the button to add one sits at the end of their row.) */}
      {!reactions.length && <AddReaction mine={[]} onPick={react} />}
      {mine && (
        <button className="hover:text-foreground hover:underline" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
      {(mine || access.role === 'owner') && (
        <button className="hover:text-destructive hover:underline" onClick={remove}>
          Delete
        </button>
      )}
    </div>
  )
  return (
    <div className="group/comment flex gap-3">
      <Avatar name={c.author?.name ?? '?'} picture={c.author?.picture} className={cn('mt-0.5 text-[10px]', small ? 'size-6' : 'size-7')} />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-5 items-center gap-2">
          <p className="min-w-0 flex-1 text-xs">
            <span className="font-semibold">{c.author?.name ?? 'Someone'}</span>{' '}
            <span className="text-muted-foreground" title={new Date(c.createdAt).toLocaleString()}>
              {formatDistanceToNow(parseISO(c.createdAt), { addSuffix: true })}
              {c.editedAt && ' (edited)'}
            </span>
          </p>
          {/* (In a thread they sit beside the name: under each answer they would pull the answers apart.) */}
          {small && actions}
        </div>
        {editing ? (
          <Composer
            boardId={data.board.id}
            taskId={taskId}
            members={data.members}
            files={cardFiles.files}
            initial={c}
            onSubmit={async (body, mentions, attachments) => {
              await comments.save(c, body, mentions, attachments)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
            submitLabel="Save"
          />
        ) : (
          <>
            <div className="mt-1 rounded-lg bg-muted/60">
              <Folded height={220}>
                <Markdown text={c.body} mentions={data.members.filter((m) => c.mentions.includes(m.id))} files={cardFiles.files} cards={cardRefs} />
              </Folded>
            </div>
            <FileList files={c.attachments} />
            {/* The emoji it was answered with. Everyone who can comment can add theirs; a visitor only sees them. */}
            <ReactionRow reactions={reactions} me={user?.id} onPick={canComment ? react : undefined} />
            {!small && actions}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A comment about some words of the card's description, with the answers to it: the words quoted, the comment, the
 * answers under it, a box to answer in, and Resolve, which settles it (it folds away, and its words are no longer
 * marked in the text; Reopen brings it back). Shown in the card's Comments and, on the description's full page,
 * beside the text.
 */
export function PassageThread({
  thread,
  comments,
  taskId,
  cardFiles,
  gone,
  active,
  onOpen,
}: {
  thread: Thread
  comments: CardComments
  taskId: string
  cardFiles: CardFiles
  /** Its words aren't in the description any more (they were rewritten). */
  gone?: boolean
  /** It is the one being looked at (on the full page: its words are the ones lit up). */
  active?: boolean
  /** Its words are clicked: go to them in the text. */
  onOpen?: () => void
}) {
  const { data, canComment } = useBoard()
  const { root, answers } = thread
  const settled = root.resolved
  const [shown, setShown] = useState(false)
  const [answering, setAnswering] = useState(false)
  const resolve = (resolved: boolean) => comments.resolve(root, resolved).catch((e) => toast.error(errorMessage(e)))
  const quote = (
    <span className="line-clamp-3 border-l-2 border-amber-400/80 pl-2 text-xs text-muted-foreground italic">
      {quoteLine(root.passage.quote, 220)}
    </span>
  )
  return (
    <div
      data-thread={root.id}
      className={cn('rounded-lg border bg-background p-2.5 transition-shadow', active && 'border-amber-400/70 ring-2 ring-amber-400/25')}
    >
      {onOpen ? (
        <button type="button" onClick={onOpen} title="Show these words in the text" className="block w-full text-left hover:[&>span]:text-foreground">
          {quote}
        </button>
      ) : (
        quote
      )}
      {gone && !settled && <p className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">The text this was about has changed.</p>}
      {settled && !shown ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <CheckCircle weight="fill" className="size-3.5 text-status-done" />
          <span>
            Resolved{settled.by ? ` by ${settled.by.name}` : ''} · {root.author?.name ?? 'Someone'}: {root.body.replace(/\s+/g, ' ').slice(0, 60)}
            {root.body.length > 60 ? '…' : ''}
          </span>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setShown(true)}>
            Show
          </button>
        </p>
      ) : (
        <>
          <div className="mt-2 space-y-3">
            <CommentItem c={root} comments={comments} taskId={taskId} cardFiles={cardFiles} small />
            {answers.map((a) => (
              <CommentItem key={a.id} c={a} comments={comments} taskId={taskId} cardFiles={cardFiles} small />
            ))}
          </div>
          {settled && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle weight="fill" className="size-3.5 text-status-done" /> Resolved{settled.by ? ` by ${settled.by.name}` : ''}{' '}
              {formatDistanceToNow(parseISO(settled.at), { addSuffix: true })}
            </p>
          )}
          {canComment && (
            <div className="mt-2">
              {answering ? (
                <Composer
                  boardId={data.board.id}
                  taskId={taskId}
                  members={data.members}
                  files={cardFiles.files}
                  start
                  onSubmit={async (body, mentions, attachments) => {
                    await comments.post(body, mentions, attachments, { parentId: root.id })
                    setAnswering(false)
                  }}
                  onCancel={() => setAnswering(false)}
                  placeholder="Reply…"
                  submitLabel="Reply"
                />
              ) : (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => setAnswering(true)}>
                    <ArrowBendUpLeft /> Reply
                  </Button>
                  {settled ? (
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => void resolve(false)}>
                      <ArrowCounterClockwise /> Reopen
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => void resolve(true)}>
                      <Check /> Resolve
                    </Button>
                  )}
                  {settled && (
                    <button type="button" className="ml-auto text-xs text-muted-foreground hover:underline" onClick={() => setShown(false)}>
                      Hide
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
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
export function Composer({
  boardId,
  taskId,
  members,
  files,
  initial,
  start,
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
  /** Ready to type in at once (an answer, a comment on words just selected), not a box to click first. */
  start?: boolean
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
  const [opened, setOpened] = useState(!!initial || !!start)
  const [round, setRound] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const cardSource = useCardSource()

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
            // "/": the short menu (lists, a quote, code), and a card to mention.
            inserts="light"
            cards={cardSource}
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
