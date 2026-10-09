import { ArrowsOut, PencilSimple, TextAlignLeft } from '@phosphor-icons/react'
import { formatDistanceToNow } from 'date-fns'
import { lazy, Suspense, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Ref } from 'react'
import { useCardRefs, useCardSource } from '@/app/card-refs'
import type { CardComments } from '@/data/cardComments'
import type { CardFiles } from '@/data/cardFiles'
import { clearDraft, pruneDrafts, readDraft, writeDraft, type Draft } from '@/data/drafts'
import type { DocLink, LiveDoc } from '@/data/liveDoc'
import { colorFor, namesOf, type Writer } from '@/data/writers'
import { placeAtPoint, type Place } from '@/components/text/caret'
import type { Shared } from '@/components/text/Editor'
import { Markdown } from '@/components/text/Markdown'
import { useFolds } from '@/components/text/folds'
import { headingsOf, toggleTask } from '@/components/text/mdText'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/copy'
import { cn } from '@/lib/utils'
import { FILE_MARK } from './RichText'
import { SaveSign } from './SaveSign'
import { Section } from './Section'

const Editor = lazy(() => import('@/components/text/Editor'))
const Page = lazy(() => import('./DescriptionReader').then((m) => ({ default: m.DescriptionReader })))

/** Taller than this and it's shown folded, with "Show more". */
const FOLDED = 320
/** How long after the last key the draft is put away (and the Contents and word count catch up). */
const SETTLE_MS = 300
/** A description holds this many characters at the most. */
const MAX_LENGTH = 50_000

// Written with other people (see `LiveText`), the text is saved as the writing goes:
/** this long after the last key typed here, */
const SAVE_IDLE_MS = 4000
/** at the latest this long after the first, while the typing goes on, */
const SAVE_MOST_MS = 20_000
/**
 * and from here when it has stood unsaved this long with nobody typing: whoever typed it left before their browser
 * saved it, or their save was lost. (A little longer in each browser, so that they don't all save it at once.)
 */
const SAVE_FOR_OTHERS_MS = 12_000
const WATCH_MS = 5000
/** Joining the others isn't answered within this long (it should be at once): written here by itself, as before. */
const JOIN_MS = 4000
/** The same text is saved from one browser this many times at the most (see `saveLive`). */
const SAME_TEXT_SAVES = 3

const NEVER = () => () => {}

pruneDrafts()

/**
 * Writing a description with other people at once (see data/liveDoc.ts): the board's live connection, the card, who
 * this person is to the others, and how the text is saved while the writing goes on (`session`: the session it is
 * written in; false when it isn't allowed).
 */
export interface LiveText {
  link: DocLink
  taskId: string
  me: Writer
  save: (text: string, session: string) => boolean
}

/** What the card can ask of its description. */
export interface DescriptionHandle {
  /** Opens it full page at a comment about some of its words (see DescriptionReader's `notes`). */
  openAt: (commentId: string) => void
}

/**
 * The card's description: Markdown, shown formatted (long ones folded, with "Show more"). Clicked, it's written in
 * place, the cursor where you clicked; Expand reads or writes it full page, carrying on from where you were.
 *
 * Written by one person (`live` left out, or no connection when it is opened): what's typed is saved when you finish
 * (clicking away, Esc, ⌘Enter) or with ⌘S, and kept as a draft in this browser until then: a reload or a closed tab
 * doesn't lose it, and it's offered back.
 *
 * Written with others (`live`): everyone who opens it to write is in the same text, sees the others' cursors and
 * what they type as they type it, and the text is saved as the writing goes, by the browser of whoever typed. What
 * was typed while the connection was gone joins the others' text when it is back; if that can't be (the session was
 * over by then), it is kept as a draft to copy from.
 *
 * Checklist items can be ticked without editing. Type @ to mention someone on the board (they're told, once), # to
 * point to one of the card's files, / for things to put in; files dropped or pasted in are attached and referenced
 * where the cursor is.
 */
export function Description({
  title,
  value,
  readOnly,
  cardFiles,
  people,
  draftId,
  onSave,
  full,
  versions,
  live,
  writers,
  notes,
  handle,
}: {
  title: string
  value: string
  readOnly: boolean
  cardFiles: CardFiles
  /** The board's people, suggested after "@". */
  people: { id: string; name: string; picture?: string | null }[]
  /** What its draft is kept under: the board and the card. */
  draftId: string
  onSave: (text: string) => void
  /**
   * The full page and the address (see the router's `full`): whether to start there, how the address is told when
   * the page opens and closes, and the link to copy from the page (`note`: the comment about some of its words it
   * starts at). Left out: the page has no address (a card opened from Search cards).
   */
  full?: { start: boolean; set: (open: boolean) => void; link: string; note?: string | null; section?: string | null }
  /** The text's earlier versions, read on the full page (see DescriptionReader). Left out: none shown. */
  versions?: { boardId: string; taskId: string; onRestore?: (text: string, said: string) => void }
  /** Written with other people at once, for someone who can edit. Left out: by one person at a time. */
  live?: LiveText
  /** Who is writing it at this moment (this person too, if they are). */
  writers?: Writer[]
  /** The card's comments: the ones about words of this text are shown with it, full page (see DescriptionReader). */
  notes?: { comments: CardComments; taskId: string; canComment: boolean }
  handle?: Ref<DescriptionHandle>
}) {
  // The cards its text names (WEB-12), shown as links, and the ones "/" → Card offers.
  const cardRefs = useCardRefs()
  const cardSource = useCardSource()
  /** Where it's being written: in the card, full page, or not at all. */
  const [writing, setWriting] = useState<'card' | 'page' | null>(null)
  // (A link to the full page opens it at once, to read: there has to be something to read.)
  const [page, setPage] = useState(() => !!full?.start && (!!value || !!full.note))
  const showPage = (open: boolean) => {
    setPage(open)
    full?.set(open)
    if (!open) setAtNote(null)
  }
  /** The comment the full page opens at. */
  const [atNote, setAtNote] = useState<string | null>(full?.note ?? null)
  /** The section the full page opens at (kept from the address as it was when the card opened: it then drops it). */
  const [atSection] = useState<string | null>(full?.section ?? null)
  // Sections folded away while reading (this person's own, for this card: see folds.ts), here and on the full page.
  const sections = useMemo(() => headingsOf(value), [value])
  const folds = useFolds(draftId, sections)
  useImperativeHandle(handle, () => ({
    openAt: (commentId) => {
      setAtNote(commentId)
      setPage(true)
      full?.set(true)
    },
  }))
  /** What the editor opens with: the text, and where the cursor goes. */
  const [start, setStart] = useState<{ text: string; caret?: Place }>({ text: value })
  const [dirty, setDirty] = useState(false)
  /** What's being typed, a moment behind the keys (the page's Contents and word count). */
  const [settled, setSettled] = useState(value)
  /** This page was opened before the app was updated: it has to be loaded again to write (see EDITOR_VERSION). */
  const [stale, setStale] = useState(false)
  /** Writing left unsaved earlier (a reload, a closed tab, a connection that went), to offer back. */
  const [left, setLeft] = useState<Draft | null>(() => {
    const d = readOnly ? null : readDraft(draftId)
    return d && d.text !== value ? d : null
  })

  // Written with others: whether it is, this browser's part in the session (once it has joined), and the text it
  // loads into the shared document when it is the one to.
  const [together, setTogether] = useState(false)
  const [room, setRoom] = useState<LiveDoc | null>(null)
  const session = useSyncExternalStore(room?.subscribe ?? NEVER, () => room?.getState() ?? null)
  const [seed, setSeed] = useState<Shared['seed']>(null)
  const [tooLong, setTooLong] = useState(false)
  const [patience] = useState(() => SAVE_FOR_OTHERS_MS + Math.random() * 6000)

  // The latest of each, for handlers that outlive a render (blur while leaving, the timers, closing the card).
  const text = useRef(value)
  const where = useRef<'card' | 'page' | null>(null)
  const saved = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const now = useRef(live)
  const inRoom = useRef<LiveDoc | null>(null)
  /** Something typed here isn't saved yet. */
  const typedHere = useRef(false)
  /** The saved text as it was when this browser was last in step with the others. */
  const known = useRef(value)
  /** When the text being written, and the saved text, last changed. */
  const changed = useRef({ text: 0, saved: 0 })
  const tries = useRef({ text: '', n: 0 })
  /** What this browser brings to a document it joins: a draft, or what was typed while the connection was gone. */
  const brought = useRef<{ text: string; base?: string } | null>(null)
  const seen = useRef({ epoch: 0, seed: false })
  /** Where the cursor was to go when writing began. */
  const caretAt = useRef<Place | undefined>(undefined)
  /** A draft kept on joining, because the text had changed since it was written (see `heard`). */
  const keptDraft = useRef<string | null>(null)
  /** Nobody else is writing it just now. */
  const lonely = useRef(true)
  const timers = useRef<{ idle?: ReturnType<typeof setTimeout>; most?: ReturnType<typeof setTimeout>; join?: ReturnType<typeof setTimeout> }>({})
  const watching = useRef<ReturnType<typeof setInterval>>(undefined)
  useLayoutEffect(() => {
    if (saved.current !== value) changed.current.saved = Date.now()
    saved.current = value
    now.current = live
    const s = inRoom.current?.getState()
    if (!s || s.status === 'live') known.current = value
    if (value === text.current) typedHere.current = false
    lonely.current = !(writers ?? []).some((w) => w.id !== live?.me.id)
  })

  /** A draft is carried on with while the saved text is still the one it was written over. */
  const fits = (d: { base?: string }) => d.base === undefined || d.base === saved.current
  /** What was typed and couldn't be saved is kept as a draft, and offered. */
  const keep = () => {
    writeDraft(draftId, text.current, known.current)
    setLeft(readDraft(draftId))
  }

  const begin = (at: 'card' | 'page', from: { caret?: Place } = {}) => {
    if (readOnly || stale) return
    where.current = at
    caretAt.current = from.caret
    // With whoever else is writing it (or by oneself, where the others can join).
    if (live?.link.isUp()) {
      text.current = value
      brought.current = left && left.text !== value ? { text: left.text, base: left.base } : null
      setStart({ text: value, caret: from.caret })
      setSettled(value)
      setTooLong(false)
      setSeed(null)
      setTogether(true)
      void join()
    } else alone(from.caret)
    setWriting(at)
    if (at === 'page') showPage(true)
  }
  /** Written here by itself. Writing left unsaved earlier carries on from there, whichever way it's opened. */
  const alone = (caret?: Place, draft: { text: string; base?: string } | null = left) => {
    const carry = draft && fits(draft) ? draft.text : null
    text.current = carry ?? saved.current
    setStart({ text: text.current, caret })
    setDirty(text.current !== saved.current)
    setSettled(text.current)
    if (carry !== null) setLeft(null)
    setTogether(false)
  }

  // ── Written with others ──────────────────────────────────────────────────

  const join = async () => {
    const { LiveDoc } = await import('@/data/liveDoc')
    // (Closed again meanwhile.)
    if (!where.current || inRoom.current || !now.current) return
    const r = new LiveDoc(now.current.link, now.current.taskId)
    inRoom.current = r
    seen.current = { epoch: 0, seed: false }
    typedHere.current = false
    tries.current = { text: '', n: 0 }
    // What was typed here and never saved is about to go with the document it is in: it is brought to the next one.
    r.onReplace = () => {
      if (typedHere.current && text.current !== saved.current) brought.current = { text: text.current, base: known.current }
      typedHere.current = false
    }
    r.onUnsaved = () => (typedHere.current = true)
    r.subscribe(() => heard(r))
    setRoom(r)
    watching.current = setInterval(watch, WATCH_MS)
    timers.current.join = setTimeout(() => inRoom.current === r && !r.getState().doc && giveUp(), JOIN_MS)
    heard(r)
  }
  /** Something about the session changed. */
  const heard = (r: LiveDoc) => {
    if (inRoom.current !== r) return
    const s = r.getState()
    // The card is gone, or this person may no longer write: what wasn't saved is kept as a draft.
    if (s.status === 'ended' || s.status === 'refused') {
      if (typedHere.current && text.current !== saved.current) keep()
      // (Or this page was opened before the app was updated: it says so, and how to go on.)
      if (s.reload) setStale(true)
      where.current = null
      leave()
      return setWriting(null)
    }
    if (!s.doc) return
    if (seen.current.epoch !== s.epoch) {
      // A document this browser hasn't had: the session's, as it joins (or joins again, when its own couldn't go on).
      seen.current = { epoch: s.epoch, seed: s.seed }
      clearTimeout(timers.current.join)
      const mine = brought.current && brought.current.text !== saved.current ? brought.current : null
      brought.current = null
      // What it brings goes in when it is the one to load the text and the saved text is still the one that was
      // written over. Otherwise others have written since: it is kept as a draft, to copy from.
      if (mine && s.seed && fits(mine)) {
        setSeed({ text: mine.text, touched: true })
        text.current = mine.text
        clearDraft(draftId)
        setLeft(null)
      } else {
        setSeed({ text: saved.current })
        text.current = saved.current
        if (mine) {
          writeDraft(draftId, mine.text, mine.base)
          setLeft(readDraft(draftId))
          keptDraft.current = mine.text
        } else {
          clearDraft(draftId)
          setLeft(null)
        }
      }
      typedHere.current = false
    } else if (s.seed && !seen.current.seed) {
      // Asked to load the text after all (whoever was, left first): the saved text, as it is now.
      seen.current.seed = true
      setSeed({ text: saved.current })
    }
  }
  /** Saves the text as it is now. True when nothing typed here is left unsaved by it. */
  const saveLive = (last = false): boolean => {
    clearTimeout(timers.current.idle)
    clearTimeout(timers.current.most)
    timers.current.most = undefined
    const r = inRoom.current
    const s = r?.getState()
    if (!r || !s || !now.current) return false
    const md = text.current
    if (md === saved.current) {
      typedHere.current = false
      clearDraft(draftId)
      return true
    }
    // Not while the connection is gone: what is here may be behind what the others wrote, and is put together with
    // theirs first.
    if (s.status !== 'live' || !s.session) return false
    // A text nobody has written in reads as it was saved, give or take how Markdown is written down: left alone.
    if (!s.touched) return true
    if (md.length > MAX_LENGTH) {
      setTooLong(true)
      return false
    }
    setTooLong(false)
    // The same text is saved from here a few times at the most: two browsers that write a text down differently
    // (one of them an older version of the app) would otherwise save over each other for as long as both are open.
    if (tries.current.text !== md) tries.current = { text: md, n: 0 }
    if (!last && tries.current.n >= SAME_TEXT_SAVES) return false
    tries.current.n++
    if (!now.current.save(md, s.session)) return false
    clearDraft(draftId)
    return true
  }
  /**
   * Every few seconds: the text has stood unsaved a while with nobody typing (see SAVE_FOR_OTHERS_MS). With nobody
   * else in it there is no one to wait for: it is saved as soon as it has stood a moment.
   */
  const watch = () => {
    const s = inRoom.current?.getState()
    if (!s || s.status !== 'live' || !s.touched || text.current === saved.current) return
    const at = Date.now()
    const wait = lonely.current ? SAVE_IDLE_MS : patience
    if (at - changed.current.text > wait && at - changed.current.saved > wait) saveLive()
  }
  const leave = () => {
    clearTimeout(timers.current.idle)
    clearTimeout(timers.current.most)
    clearTimeout(timers.current.join)
    clearInterval(watching.current)
    timers.current = {}
    const r = inRoom.current
    inRoom.current = null
    r?.leave()
    setRoom(null)
    setTogether(false)
  }
  /** Joining wasn't answered: written here by itself after all. */
  const giveUp = () => {
    const draft = brought.current
    brought.current = null
    leave()
    alone(caretAt.current, draft)
  }

  const typed = (md: string, from?: 'local' | 'theirs') => {
    text.current = md
    clearTimeout(timer.current)
    if (!inRoom.current) {
      setDirty(md !== saved.current)
      timer.current = setTimeout(() => {
        if (md !== saved.current) writeDraft(draftId, md, saved.current)
        setSettled(md)
      }, SETTLE_MS)
      return
    }
    changed.current.text = Date.now()
    // (A draft kept on joining turns out to be in the text already: this browser's own, from before a reload, which
    // the session still had.)
    if (keptDraft.current === md) {
      keptDraft.current = null
      clearDraft(draftId)
      setLeft(null)
    }
    if (from === 'local') {
      typedHere.current = true
      clearTimeout(timers.current.idle)
      timers.current.idle = setTimeout(saveLive, SAVE_IDLE_MS)
      timers.current.most ??= setTimeout(saveLive, SAVE_MOST_MS)
    }
    timer.current = setTimeout(() => {
      // (Kept in this browser until it is saved, in case the page goes first. Only what was typed here: what the
      // others type is theirs to keep.)
      if (typedHere.current && md !== saved.current) writeDraft(draftId, md, known.current)
      setSettled(md)
    }, SETTLE_MS)
  }
  /** Saves what's typed (and stays, when called from the keyboard). */
  const save = () => {
    clearTimeout(timer.current)
    if (inRoom.current) return void saveLive(true)
    if (text.current !== saved.current) onSave(text.current)
    clearDraft(draftId)
    setDirty(false)
    setSettled(text.current)
  }
  const finish = () => {
    if (!where.current) return
    where.current = null
    clearTimeout(timer.current)
    if (inRoom.current) {
      // (What can't be saved now, with the connection gone, is kept as a draft and offered back.)
      if (!saveLive(true) && typedHere.current && text.current !== saved.current) keep()
      leave()
    } else if (together) leave()
    else save()
    setWriting(null)
  }
  /** From the card's editor to the full page, with the same text and cursor. */
  const toPage = (caret: Place) => {
    clearTimeout(timer.current)
    where.current = 'page'
    setStart({ text: text.current, caret })
    setSettled(text.current)
    setWriting('page')
    showPage(true)
  }
  const closePage = () => {
    if (where.current === 'page') finish()
    showPage(false)
  }
  const discard = () => {
    clearDraft(draftId)
    setLeft(null)
  }

  // Closing the card some other way while writing (Back, another card). By oneself: the draft stays, to offer back.
  // With others: it is saved, as it has been all along, and this browser leaves the session.
  const closing = useRef(() => {})
  useLayoutEffect(() => {
    closing.current = () => {
      clearTimeout(timer.current)
      const r = inRoom.current
      if (r) {
        if (where.current && !saveLive(true) && typedHere.current && text.current !== saved.current) writeDraft(draftId, text.current, known.current)
        clearInterval(watching.current)
        clearTimeout(timers.current.join)
        inRoom.current = null
        r.leave()
      } else if (where.current && text.current !== saved.current) writeDraft(draftId, text.current, saved.current)
      where.current = null
    }
  })
  useEffect(() => () => closing.current(), [])

  // A save of this description was refused while it wasn't open for writing (it had just been closed): the text
  // was kept as a draft (see BoardSync), which is offered now.
  const link = live?.link
  const taskId = live?.taskId
  useEffect(
    () =>
      link?.onDoc((e) => {
        // (Shown only while it differs from the saved text, which at this moment is still on its way back to what
        // the server has: see `offered`.)
        if (e.type === 'unsaved' && e.taskId === taskId && !inRoom.current) setLeft(readDraft(draftId))
      }),
    [link, taskId, draftId],
  )

  /** Writing left unsaved that is worth offering: it isn't what the description says anyway. */
  const offered = left && left.text !== value ? left : null
  /** The others writing it at this moment. */
  const others = (writers ?? []).filter((w) => w.id !== live?.me.id)
  const are = others.length === 1 ? 'is' : 'are'
  const shared: Shared | undefined =
    together && live && session?.doc && session.awareness
      ? {
          doc: session.doc,
          awareness: session.awareness,
          me: { name: live.me.name, color: colorFor(live.me.id, people) },
          seed: session.seed ? seed : null,
        }
      : undefined
  /** Asked to join the others, not answered yet (a moment). */
  const opening = together && !shared
  const status = (
    <span className="flex items-center gap-2.5">
      {together && <Together people={others} among={people} />}
      {together ? (
        <SaveSign dirty={!!session?.touched && settled !== value} auto offline={session?.status === 'away'} long={tooLong} />
      ) : (
        <SaveSign dirty={dirty} />
      )}
    </span>
  )

  // (While others are writing it, a tick from here would be written over by their next save: they tick it.)
  const tick = readOnly || others.length ? undefined : (n: number) => onSave(toggleTask(value, n))
  const canExpand = !!value || !readOnly

  const aside = writing !== 'card' && (
    <div className="flex items-center gap-1">
      {!readOnly && value && (
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => begin('card')}>
          <PencilSimple /> Edit
        </Button>
      )}
      {canExpand && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          // With nothing to read yet, the full page opens ready to write.
          onClick={() => (value ? showPage(true) : begin('page'))}
        >
          <ArrowsOut /> Expand
        </Button>
      )}
    </div>
  )

  return (
    <Section icon={<TextAlignLeft />} title="Description" aside={aside}>
      {stale && (
        <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <Stale />
        </div>
      )}
      {offered && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          {/* Carried on with while the text is as it was; once others have written in it, it is there to copy from. */}
          {!writing && !others.length && fitsNow(offered, value) ? (
            <>
              <span className="min-w-0 flex-1">
                You were writing here {formatDistanceToNow(offered.at, { addSuffix: true })}, and it wasn’t saved.
              </span>
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => begin('card')}>
                Continue writing
              </button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1">
                What you wrote here {formatDistanceToNow(offered.at, { addSuffix: true })} wasn’t saved, and the text has changed since.
              </span>
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => void copyText(offered.text, 'What you wrote')}
              >
                Copy what you wrote
              </button>
            </>
          )}
          <button type="button" className="font-medium text-muted-foreground hover:text-foreground hover:underline" onClick={discard}>
            Discard
          </button>
        </div>
      )}
      {!writing && others.length > 0 && (
        <p className="mb-1 flex items-center gap-2 px-3 text-xs text-muted-foreground">
          <Together people={others} among={people} bare />
          <span>
            {namesOf(others)} {are} writing this now{readOnly ? '.' : ': Edit to write with them.'}
          </span>
        </p>
      )}
      {writing === 'card' ? (
        <Suspense fallback={<div className="min-h-24 rounded-lg border bg-background" />}>
          {opening ? (
            <div className="min-h-24 rounded-lg border bg-background" />
          ) : (
            <Editor
              key={shared ? session?.epoch : 'alone'}
              value={start.text}
              shared={shared}
              caret={start.caret}
              onChange={typed}
              // (Going full page takes the cursor out of here too: that isn't finishing.)
              onBlur={() => where.current === 'card' && finish()}
              onEscape={finish}
              onSubmit={finish}
              onSave={save}
              members={people}
              files={cardFiles.files}
              onFiles={(fs) => cardFiles.add(fs)}
              inserts
              cards={cardSource}
              pictures
              folds={draftId}
              status={status}
              onExpand={toPage}
              autoFocus
              aria-label="Description"
              placeholder={`Add more detail… Type / for headings, lists, tables and cards, @ to mention someone, # to point to a file (${FILE_MARK}).`}
              className="min-h-24"
              // It grows with the text up to half the window, then scrolls: the rest of the card stays in reach.
              scrollClassName="max-h-[50vh] overflow-y-auto"
            />
          )}
        </Suspense>
      ) : value ? (
        <Folded onOpen={readOnly ? undefined : (caret) => begin('card', { caret })}>
          <Markdown text={value} files={cardFiles.files} mentions={people} cards={cardRefs} onToggleTask={tick} pictures fold={folds} />
        </Folded>
      ) : readOnly ? (
        <p className="text-sm text-muted-foreground">No description.</p>
      ) : (
        <button
          type="button"
          onClick={() => begin('card')}
          className="block min-h-16 w-full rounded-lg bg-muted/60 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
        >
          Add more detail… Type / for headings, lists and tables.
        </button>
      )}
      {page && (
        <Suspense fallback={null}>
          <Page
            people={people}
            title={title}
            value={value}
            readOnly={readOnly}
            cardFiles={cardFiles}
            cardRefs={cardRefs}
            cardSource={cardSource}
            writing={writing === 'page'}
            start={start}
            shared={shared}
            opening={opening}
            editorKey={shared ? session?.epoch : 'alone'}
            typing={settled}
            status={status}
            onTyped={typed}
            onSave={save}
            onFinish={finish}
            onEdit={(caret) => begin('page', { caret })}
            onTick={tick}
            onClose={closePage}
            link={full?.link}
            note={
              stale ? (
                <Stale />
              ) : others.length && writing !== 'page' ? (
                `${namesOf(others)} ${are} writing this now${readOnly ? '.' : ': Edit to write with them.'}`
              ) : undefined
            }
            notes={notes && { ...notes, focus: atNote }}
            foldKey={draftId}
            section={atSection}
            versions={
              versions && {
                ...versions,
                // (Their next save would write over a version brought back while they write.)
                onRestore: others.length ? undefined : versions.onRestore,
                busy: others.length
                  ? `${namesOf(others)} ${are} writing this now: a version can be brought back when they have finished.`
                  : undefined,
              }
            }
          />
        </Suspense>
      )}
    </Section>
  )
}

/** Whether a draft can be carried on with: the saved text is still the one it was written over. */
const fitsNow = (d: Draft, value: string) => d.base === undefined || d.base === value

/**
 * The people writing with you, as dots in the colours their cursors have (`among`: the board's people, which decide
 * the colours), and their names (`bare`: the dots only, where the names are said beside them).
 */
/** Said where a description can't be written because the page is older than the app (see EDITOR_VERSION). */
function Stale() {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-0 flex-1">Kanbanto has been updated since this page was opened. Load the page again to write here.</span>
      <button type="button" className="font-medium text-primary hover:underline" onClick={() => window.location.reload()}>
        Load the page again
      </button>
    </span>
  )
}

function Together({ people, among, bare }: { people: Writer[]; among: { id: string }[]; bare?: boolean }) {
  if (!people.length) return null
  return (
    <span
      className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground"
      title={bare ? undefined : `Writing with ${namesOf(people)}`}
    >
      <span className="flex -space-x-1">
        {people.slice(0, 4).map((p) => (
          <span
            key={p.id}
            aria-hidden
            style={{ backgroundColor: colorFor(p.id, among) }}
            className={cn('grid size-4 place-items-center rounded-full text-[9px] font-semibold text-white ring-1 ring-background')}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </span>
        ))}
      </span>
      {!bare && <span className="max-sm:sr-only">With {namesOf(people)}</span>}
    </span>
  )
}

/**
 * Long text, folded to a few lines with a fade and "Show more". Clicking the text (not a link or checkbox) calls
 * `onOpen` (to edit), with the place in the text that was clicked (see caret.ts).
 */
export function Folded({ children, onOpen, height = FOLDED }: { children: React.ReactNode; onOpen?: (caret?: Place) => void; height?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const check = () => setLong(el.scrollHeight > height + 40)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])
  const folded = long && !open
  return (
    <div>
      <div
        ref={box}
        role={onOpen ? 'button' : undefined}
        tabIndex={onOpen ? 0 : undefined}
        onClick={(e) => {
          // Selecting text, or a link or checkbox, isn't asking to edit.
          if (!onOpen || window.getSelection()?.toString() || (e.target as HTMLElement).closest('a, input, button')) return
          onOpen(placeAtPoint(e.currentTarget, e.clientX, e.clientY) ?? undefined)
        }}
        onKeyDown={(e) => onOpen && e.key === 'Enter' && e.target === e.currentTarget && (e.preventDefault(), onOpen())}
        style={folded ? { maxHeight: height } : undefined}
        className={cn(
          'relative overflow-hidden rounded-lg px-3 py-2',
          onOpen && 'cursor-text hover:bg-muted/50',
          folded && '[mask-image:linear-gradient(to_bottom,black_70%,transparent)]',
        )}
      >
        {children}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 px-3 text-xs font-medium text-primary hover:underline">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
