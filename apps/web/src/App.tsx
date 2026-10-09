import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Tray } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { api, ApiError, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import type { BoardAccess, WhereIs } from '@kanbanto/model/api'
import { backgroundOf, boardGradient } from '@kanbanto/model/colors'
import type { Command } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'
import { fromTemplate, type CardTemplate } from '@kanbanto/model/templates'
import { parseRef } from '@kanbanto/model/fields'
import { indexFor } from '@kanbanto/model/indexer'
import type { PrefsAction } from '@kanbanto/model/prefs'
import type { BoardData, Layout } from '@kanbanto/model/types'
import { BoardContext, type BoardContextValue } from '@/app/board-context'
import { LinksContext } from '@/app/links-context'
import { setTabIcon } from '@/app/tabIcon'
import { closeTask, currentRoute, hrefFor, navigate, openTask, parseRoute, useRoute, type BoardRoute, type Route } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { useInbox } from '@/app/use-inbox'
import { AuthView } from '@/components/auth/AuthView'
import { CheckInboxView, ForgotView, ResetView, VerifyView } from '@/components/auth/EmailViews'
import { JoinView } from '@/components/auth/JoinView'
import { zones, type DropZone } from '@/components/board/dnd'
import { HomeView } from '@/components/home/HomeView'
import { InboxDock } from '@/components/inbox/InboxDock'
import { SettingsDialog } from '@/components/shell/SettingsDialog'
import { TopBar } from '@/components/shell/TopBar'
import { ViewBar } from '@/components/shell/ViewBar'
import { VIEWS } from '@/components/views'
import { lastBoard, rememberBoard } from '@/data/lastBoard'
import { prefsStoreFor } from '@/data/prefsStore'
import { useArchivedCard, useBoardStore } from '@/data/useBoardStore'

// Dialogs load the first time they're opened.
const ExportDialog = lazy(() => import('@/components/shell/ExportDialog').then((m) => ({ default: m.ExportDialog })))
const ImportCardsDialog = lazy(() => import('@/components/shell/ImportCardsDialog').then((m) => ({ default: m.ImportCardsDialog })))
const StatsDialog = lazy(() => import('@/components/shell/StatsDialog').then((m) => ({ default: m.StatsDialog })))
const TaskDialog = lazy(() => import('@/components/task/TaskDialog').then((m) => ({ default: m.TaskDialog })))
const LogBox = lazy(() => import('@/components/time/LogBox'))
const MyWeek = lazy(() => import('@/components/time/MyWeek'))
const CardPeek = lazy(() => import('@/components/cards/CardPeek').then((m) => ({ default: m.CardPeek })))
const MoveToBoardDialog = lazy(() => import('@/components/task/MoveToBoardDialog').then((m) => ({ default: m.MoveToBoardDialog })))
const CardsView = lazy(() => import('@/components/cards/CardsView').then((m) => ({ default: m.CardsView })))
const NotificationsPage = lazy(() => import('@/components/notifications/NotificationsPage').then((m) => ({ default: m.NotificationsPage })))
const ShareDialog = lazy(() => import('@/components/share/ShareDialog').then((m) => ({ default: m.ShareDialog })))
const AccountView = lazy(() => import('@/components/account/AccountView').then((m) => ({ default: m.AccountView })))
const AddView = lazy(() => import('@/components/add/AddView').then((m) => ({ default: m.AddView })))
const AdminView = lazy(() => import('@/components/admin/AdminView').then((m) => ({ default: m.AdminView })))
const AuthorizeView = lazy(() => import('@/components/auth/AuthorizeView').then((m) => ({ default: m.AuthorizeView })))
const WorkspaceView = lazy(() => import('@/components/workspace/WorkspaceView').then((m) => ({ default: m.WorkspaceView })))

/**
 * The Board tab's background: a vivid gradient, plus text colors for anything drawn straight on it
 * (white on dark gradients, dark on light ones). Lists and cards keep their own colors on top.
 */
function canvasStyle(background?: string): React.CSSProperties | undefined {
  const bg = backgroundOf(background)
  if (!bg) return undefined
  const light = bg.text === 'light'
  const gradient = boardGradient(bg)
  return {
    background: gradient,
    backgroundAttachment: 'fixed',
    '--board-bg': gradient,
    '--canvas-fg': light ? 'oklch(0.99 0 0)' : 'oklch(0.22 0.02 260)',
    '--canvas-muted': light ? 'oklch(0.99 0 0 / 0.78)' : 'oklch(0.22 0.02 260 / 0.7)',
    '--canvas-chip': light ? 'oklch(1 0 0 / 0.2)' : 'oklch(0 0 0 / 0.08)',
  } as React.CSSProperties
}

/** Commands whose effect is easy to miss, so they get an "Undo" button in their toast. */
const UNDOABLE_TOAST: Partial<Record<Command['type'], string>> = {
  'task.delete': 'Task deleted',
  'task.archive': 'Card archived',
  'tasks.archive': 'Cards archived',
  'tasks.delete': 'Cards deleted',
  'column.delete': 'List deleted',
  'label.delete': 'Label deleted',
  'tasks.clearField': 'Field cleared on every card',
}

/** Across an archived board: it's read-only, and owners can bring it back. */
function ArchivedBanner({ boardId, owner }: { boardId: string; owner: boolean }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <Archive className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">This board is archived: it’s read-only{owner ? '' : '. Its owners can restore it'}.</span>
      {owner && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 bg-background"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            api('POST', `/boards/${boardId}/archive`, { archived: false }).then(
              () => toast('Board restored'),
              (e) => {
                setBusy(false)
                toast.error(errorMessage(e))
              },
            )
          }}
        >
          Restore
        </Button>
      )}
    </div>
  )
}

/** Goes somewhere else as soon as it renders (replacing the current address). */
function Redirect({ to }: { to: Route }) {
  useEffect(() => {
    navigate(to, { replace: true })
  }, [to])
  return null
}

const here = () => location.hash || '#/'

export default function App() {
  const route = useRoute()
  const { user, mustVerify } = useAuth()

  // The bare address opens the board you had open last, else your boards.
  useEffect(() => {
    if (location.hash || !user) return
    const last = lastBoard(user.id)
    navigate(last ? { page: 'board', id: last } : { page: 'home' }, { replace: true })
  }, [user])

  // ⌘K / Ctrl+K, anywhere: search all cards.
  useEffect(() => {
    if (!user) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      e.preventDefault()
      if (currentRoute().page !== 'cards') navigate({ page: 'cards', state: 'active' })
      else document.querySelector<HTMLInputElement>('input[aria-label="Search cards"]')?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [user])

  // Links from emails work whatever state you're in.
  if (route.page === 'verify') return <VerifyView token={route.token} />
  if (route.page === 'reset') return <ResetView token={route.token} />
  // Until you confirm your email, that's all there is (signed-out pages still work, and so do invites: accepting
  // one emailed to you confirms your address).
  if (mustVerify && route.page !== 'signin' && route.page !== 'signup' && route.page !== 'join') return <CheckInboxView />

  switch (route.page) {
    case 'signin':
    case 'signup':
      if (user) return <Redirect to={route.next ? parseNext(route.next) : { page: 'home' }} />
      return <AuthView mode={route.page} next={route.next} problem={route.page === 'signin' ? route.problem : undefined} />
    case 'forgot':
      if (user) return <Redirect to={{ page: 'home' }} />
      return <ForgotView />
    case 'join':
      return <JoinView token={route.token} />
    case 'account':
      if (!user) return <Redirect to={{ page: 'signin', next: here() }} />
      return (
        <Suspense fallback={null}>
          <AccountView section={route.section} problem={route.problem} />
        </Suspense>
      )
    case 'admin':
      if (!user) return <Redirect to={{ page: 'signin', next: here() }} />
      return (
        <Suspense fallback={null}>
          <AdminView section={route.section} />
        </Suspense>
      )
    case 'authorize':
      if (!user) return <Redirect to={{ page: 'signin', next: here() }} />
      return (
        <Suspense fallback={null}>
          <AuthorizeView query={route.query} />
        </Suspense>
      )
    case 'add':
      // (Signing in comes back here, with what was handed over still in the address.)
      if (!user) return <Redirect to={{ page: 'signin', next: here() }} />
      return (
        <Suspense fallback={null}>
          <AddView route={route} />
        </Suspense>
      )
    case 'time':
      if (!user) return <Redirect to={{ page: 'signin', next: here() }} />
      return (
        <Suspense fallback={null}>
          <MyWeek key={route.week ?? ''} week={route.week} />
        </Suspense>
      )
    case 'cards':
      if (!user) return <Redirect to={{ page: 'signin', next: here() }} />
      return (
        <Suspense fallback={null}>
          <CardsView route={route} />
        </Suspense>
      )
    case 'notifications':
      if (!user) return <Redirect to={{ page: 'signin', next: here() }} />
      return (
        <Suspense fallback={null}>
          <NotificationsPage key={`${route.show ?? ''}|${route.board ?? ''}`} route={route} />
        </Suspense>
      )
    case 'workspace':
      if (!user) return <Redirect to={{ page: 'signin', next: here() }} />
      return (
        <Suspense fallback={null}>
          <WorkspaceView key={route.id} route={route} />
        </Suspense>
      )
    case 'board':
      // Public boards open signed out, so the board decides whether sign-in is needed.
      return <BoardScreen key={route.id} id={route.id} />
    case 'home':
      if (!user) return <Redirect to={{ page: 'signin' }} />
      return <HomeView />
  }
}

/** A `next` address (from ?next=) as a route; only addresses inside the app are followed. */
const parseNext = (next: string): Route => (next.startsWith('#/') ? parseRoute(next) : { page: 'home' })

/** One board: loads it from the server and keeps it in step. */
function BoardScreen({ id }: { id: string }) {
  const { user, refresh } = useAuth()
  const prefsStore = useMemo(() => prefsStoreFor(id), [id])
  const [gone, setGone] = useState<'deleted' | 'access-lost' | null>(null)
  const store = useBoardStore(id, prefsStore, (e) => {
    if (e.type === 'refused') toast.error(e.message, { id: 'refused' })
    else if (e.type === 'signed-out') {
      // Unsaved changes wait in this tab; signing in brings you back here and sends them.
      toast('You were signed out. Sign in again to keep working: your unsaved changes will be saved then.', { id: 'signed-out' })
      void refresh().then(() => navigate({ page: 'signin', next: here() }, { replace: true }))
    } else setGone(e.reason)
  })

  useEffect(() => {
    if (user && store.data) rememberBoard(user.id, id)
  }, [user, id, store.data])
  const name = store.data?.board.name
  useEffect(() => {
    if (name) document.title = `${name} · Kanbanto`
  }, [name])
  // The tab's icon takes the board's colors, so its tab can be told from other boards'.
  const background = store.data?.board.background
  useEffect(() => {
    setTabIcon(backgroundOf(background))
    return () => setTabIcon(null)
  }, [background])

  if (gone)
    return (
      <Message title={gone === 'deleted' ? 'This board was deleted' : 'You no longer have access to this board'}>
        {gone === 'deleted' ? 'Someone deleted it while you had it open.' : 'Its owner changed who can open it.'}
      </Message>
    )
  if (store.error?.status === 401) return <Redirect to={{ page: 'signin', next: here() }} />
  if (store.error)
    return (
      <Message title={store.error.status === 404 ? 'This board doesn’t exist' : 'Couldn’t open this board'}>
        {store.error.status === 404 ? 'It may have been deleted, the link is wrong, or it hasn’t been shared with you.' : store.error.message}
      </Message>
    )
  if (!store.data || !store.access) return null
  return <Workspace store={store as typeof store & { data: BoardData; access: BoardAccess }} />
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  const { user } = useAuth()
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-sm text-center">
        <p className="text-base font-semibold">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{children}</p>
        <a
          href={hrefFor(user ? { page: 'home' } : { page: 'signin', next: here() })}
          className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
        >
          {user ? 'Go to your boards' : 'Sign in'}
        </a>
      </div>
    </div>
  )
}

type Store = ReturnType<typeof useBoardStore> & { data: BoardData; access: BoardAccess }

/**
 * A card the address asks for that this board doesn't have: by its number here (`n`), or by the id it had here
 * (`task`). The server says where it is: archived here (its number alone doesn't say which card that is), or on
 * the board it was moved to, and the address is changed to that. True while the answer is awaited.
 */
function useMovedCard(boardId: string, ask: { n: string } | { task: string } | null): boolean {
  const key = ask && ('n' in ask ? `n=${ask.n}` : `task=${encodeURIComponent(ask.task)}`)
  const [answered, setAnswered] = useState<string | null>(null)
  useEffect(() => {
    if (!key || answered === key) return
    let alive = true
    api<WhereIs>('GET', `/boards/${encodeURIComponent(boardId)}/whereis?${key}`)
      .then(
        (at) => {
          const r = currentRoute()
          if (!alive || r.page !== 'board' || r.id !== boardId) return
          if (at.moved) {
            toast(`This card was moved to ${at.board}.${at.ref ? ` It’s ${at.ref} there.` : ''}`)
            navigate({ page: 'board', id: at.boardId, task: at.taskId }, { replace: true })
          } else if (!('task' in r) || r.task !== at.taskId)
            navigate({ ...r, task: at.taskId, n: undefined }, { replace: true, state: history.state })
        },
        (e) => {
          // A number that isn't a card's is said; a card that's simply gone (deleted while open, an old link) closes
          // quietly, as it did, unless it went to a board that can't be followed to.
          if (alive && (key.startsWith('n=') || (e instanceof ApiError && e.code === 'moved'))) toast.error(errorMessage(e))
        },
      )
      .finally(() => alive && setAnswered(key))
    return () => {
      alive = false
    }
  }, [boardId, key, answered])
  return !!key && answered !== key
}

function Workspace({ store }: { store: Store }) {
  const { data, access, undo, redo } = store
  const idx = useMemo(() => indexFor(data), [data])
  // An archived board is read-only for everyone until an owner restores it.
  const readOnly = access.role === 'viewer' || !!access.archivedAt

  // The tab, focused task and open task come from the address, so Back/Forward and links work.
  // A bare board address falls back to what's remembered in view settings.
  const route = useRoute() as BoardRoute
  const layout = route.layout ?? store.prefs.layout
  const wantedFocus = route.layout ? route.focus : store.prefs.focusId
  const focusId = wantedFocus && data.tasks[wantedFocus] ? wantedFocus : undefined
  // (An archived card isn't sent with the board: one in the address is fetched first.)
  const looking = useArchivedCard(store, route.task)
  // A card can also be asked for by its number here (?n=12: what a card's name in a text links to).
  const numbered = useMemo(() => {
    const n = route.task ? 0 : Number(route.n ?? 0)
    return n ? Object.values(data.tasks).find((t) => t.number === n) : undefined
  }, [route.task, route.n, data.tasks])
  const openId = route.task ? (data.tasks[route.task] || data.archived?.[route.task] ? route.task : null) : (numbered?.id ?? null)
  // Asked for and not on this board (nor archived on it): it may have been moved to another one.
  const finding = useMovedCard(
    data.board.id,
    route.task ? (openId || looking ? null : { task: route.task }) : route.n && !numbered ? { n: route.n } : null,
  )
  const prefs = useMemo(() => ({ ...store.prefs, layout, focusId }), [store.prefs, layout, focusId])

  // Keep the address complete and pointing at things that exist.
  useEffect(() => {
    const r = currentRoute()
    if (r.page !== 'board' || r.id !== data.board.id) return
    const fixed: BoardRoute = {
      page: 'board',
      id: r.id,
      layout,
      focus: focusId,
      task: openId ?? (looking || finding ? r.task : undefined),
      full: r.full,
      note: r.note,
      at: r.at,
      // (A number stays in the address only while its card is being found: then the address names the card.)
      n: finding && !r.task ? r.n : undefined,
      inbox: r.inbox,
    }
    const depth = (history.state as { taskDepth?: number } | null)?.taskDepth
    if (fixed.task && !depth) {
      // Arrived with a task open (a link, or a new tab): put the page under it, so closing the task goes there.
      navigate({ ...fixed, task: undefined }, { replace: true })
      navigate(fixed, { state: { taskDepth: 1 } })
    } else if (hrefFor(fixed) !== hrefFor(r)) navigate(fixed, { replace: true, state: history.state })
  }, [route, layout, focusId, openId, looking, finding, data.board.id])

  // Remember the tab and focus for the next time this board is opened without them in the address.
  const { setPrefs: savePrefs } = store
  useEffect(() => {
    if (layout !== store.prefs.layout) savePrefs({ type: 'setLayout', layout })
  }, [layout, store.prefs.layout, savePrefs])
  useEffect(() => {
    if (focusId !== store.prefs.focusId) savePrefs({ type: 'setFocus', id: focusId })
  }, [focusId, store.prefs.focusId, savePrefs])

  /** Switch tab or focus as a new history entry (closing any open task). */
  const go = useCallback(
    (patch: { layout?: Layout; focus?: string }) => {
      const r = currentRoute()
      if (r.page !== 'board') return
      const next: BoardRoute = { ...r, layout: r.layout ?? layout, focus: r.layout ? r.focus : focusId, ...patch, task: undefined, inbox: undefined }
      if (hrefFor(next) !== hrefFor(r)) navigate(next)
    },
    [layout, focusId],
  )
  const setPrefs = useCallback(
    (a: PrefsAction) => {
      if (a.type === 'setLayout') go({ layout: a.layout })
      else if (a.type === 'setFocus') go({ focus: a.id })
      else savePrefs(a)
    },
    [go, savePrefs],
  )
  const [search, setSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [movingId, setMovingId] = useState<string | null>(null)

  const say = useCallback((message: string | null) => message && toast(message, { id: 'undo' }), [])

  // The Inbox panel sits beside this board: it's told which board this is (to file cards here), and its last
  // change is weighed against this board's when you undo.
  const { setPage, setCount, lastActs } = useInbox()
  const boardName = data.board.name
  useEffect(() => {
    setPage({ boardId: data.board.id, name: boardName, canEdit: !readOnly })
    return () => setPage(null)
  }, [setPage, data.board.id, boardName, readOnly])
  // (Open as a board, the Inbox itself says how many cards wait in it.)
  const waiting = access.inbox ? idx.roots.filter((id) => idx.category.get(id) !== 'done').length : null
  useEffect(() => {
    if (waiting !== null) setCount(waiting)
  }, [waiting, setCount])
  const lastRun = useRef(0)

  /** Runs a command; if the rules refuse it, says why. `said`: what it did, to say with an Undo button. */
  const run = useCallback(
    (cmd: Command, said?: string) => {
      const error = store.run(cmd)
      if (error) {
        toast(error, { id: 'refused' })
        return false
      }
      lastRun.current = Date.now()
      const done = said ?? (cmd.type === 'task.archive' && cmd.complete ? 'Card completed and archived' : UNDOABLE_TOAST[cmd.type])
      if (done) toast(done, { id: 'undo', action: { label: 'Undo', onClick: () => say(undo()) } })
      return true
    },
    [store, undo, say],
  )

  const adopt = useCallback<BoardContextValue['adopt']>(
    (seq, changes, done) => {
      store.adopt(seq, changes)
      lastRun.current = Date.now()
      toast(done, { id: 'undo', action: { label: 'Undo', onClick: () => say(undo()) } })
    },
    [store, undo, say],
  )
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)

  // The log box, open (with a card picked, from a card's menu or dialog).
  const [logging, setLogging] = useState<{ taskId?: string } | null>(null)
  const logTime = useCallback((taskId?: string) => setLogging({ taskId }), [])

  // The card made and opened just now: its dialog starts in the title.
  const [justMade, setNewId] = useState<string | null>(null)
  const createTask = useCallback<BoardContextValue['createTask']>(
    (parentId, fields, opts) => {
      const id = newId()
      const parent = parentId !== undefined ? parentId : (prefs.focusId ?? null)
      if (!run({ type: 'task.create', id, parentId: parent, fields, rankAfter: opts?.rankAfter })) return null
      if (opts?.open) {
        setNewId(id)
        openTask(id)
      }
      return id
    },
    [run, prefs.focusId],
  )

  // The board's card templates: asked for when the board opens, and again whenever someone saves or removes one.
  const [templates, setTemplates] = useState<CardTemplate[]>([])
  const templatesOf = data.board.id
  const { onTemplates } = store
  useEffect(() => {
    let gone = false
    const ask = () =>
      void api<{ templates: CardTemplate[] }>('GET', `/boards/${encodeURIComponent(templatesOf)}/templates`).then(
        (r) => !gone && setTemplates(r.templates),
        () => {},
      )
    ask()
    const stop = onTemplates(ask)
    return () => {
      gone = true
      stop()
    }
  }, [templatesOf, onTemplates])
  const addFromTemplate = useCallback<BoardContextValue['addFromTemplate']>(
    (template, to, opts) => {
      const made = fromTemplate(
        data,
        template,
        { status: to?.status ?? idx.firstOf.todo, parentId: to?.parentId !== undefined ? to.parentId : (prefs.focusId ?? null), top: to?.top },
        newId,
      )
      if (!run(made.command)) return null
      toast(`Added “${template.cards[0].title}” from the template “${template.name}”`, { id: 'undo' })
      if (opts?.open) {
        setNewId(made.id)
        openTask(made.id)
      }
      return made.id
    },
    [data, idx, run, prefs.focusId],
  )

  // A linked card: one of this board opens like any card; one of another board opens over this one, to look.
  const links = store.links!
  const [peek, setPeek] = useState<{ boardId: string; taskId: string } | null>(null)
  const boardId = data.board.id
  const openLinked = useCallback(
    (ref: string) => {
      const to = parseRef(ref)
      if (!to) return
      if (to.boardId === boardId) openTask(to.taskId)
      else setPeek(to)
    },
    [boardId],
  )
  const linksCtx = useMemo(() => ({ store: links, open: openLinked }), [links, openLinked])

  const ctx: BoardContextValue = {
    data,
    prefs,
    setPrefs,
    idx,
    run,
    adopt,
    undo: () => say(undo()),
    reload: store.reload,
    access,
    readOnly,
    openTask,
    moveToBoard: setMovingId,
    createTask,
    templates,
    addFromTemplate,
    focus: (id) => go({ focus: id }),
    memberName: (id) => (id ? (idx.members.get(id)?.name ?? '') : ''),
    openShare: () => setShareOpen(true),
    counts: store.counts,
    canComment: store.canComment,
    onActivity: store.onActivity,
    logTime: readOnly ? undefined : logTime,
    links,
    canBeLinked: store.canBeLinked,
    writing: store.docLink ? { link: store.docLink, writers: store.writers, save: store.saveWriting } : undefined,
  }

  const newTask = useCallback(() => createTask(undefined, { title: 'New task' }, { open: true }), [createTask])

  // Keyboard: N = new task, L = log time, ⌘/Ctrl+Z = undo, ⇧⌘Z / Ctrl+Y = redo (not while typing or in a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('[role=dialog]')) return
      if (readOnly) return
      const key = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey
      // Undo takes back the newest change: this board's, or one made in the Inbox panel since.
      const theirs = lastActs()
      const panel = theirs && theirs.at > lastRun.current ? theirs : null
      if (mod && key === 'z') {
        e.preventDefault()
        if (!(e.shiftKey ? panel?.redo() : panel?.undo())) say(e.shiftKey ? redo() : undo())
      } else if (mod && key === 'y') {
        e.preventDefault()
        if (!panel?.redo()) say(redo())
      } else if (key === 'n' && !mod && !e.altKey) {
        e.preventDefault()
        newTask()
      } else if (key === 'l' && !mod && !e.altKey) {
        e.preventDefault()
        setLogging({})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newTask, undo, redo, readOnly, say, lastActs])

  // A card dragged out of the Inbox panel can be dropped anywhere on a view that isn't showing lists (the Timeline,
  // the Outline, a board in columns per parent): it goes to the list the move picks. See `zones` in dnd.ts.
  const viewRef = useRef<HTMLElement>(null)
  const [dropHere, setDropHere] = useState(false)
  useEffect(() => {
    if (readOnly) return
    const zone: DropZone = {
      over: (x, y) => {
        const r = viewRef.current?.getBoundingClientRect()
        const on = !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
        setDropHere(on)
        return on ? {} : null
      },
      leave: () => setDropHere(false),
    }
    zones.page = zone
    return () => {
      if (zones.page === zone) zones.page = null
    }
  }, [readOnly])

  // Remount a view when you switch tabs or focus, so paging and scroll state start fresh.
  const viewKey = `${prefs.layout}|${prefs.focusId ?? ''}`
  const View = VIEWS[prefs.layout].component

  return (
    <BoardContext.Provider value={ctx}>
      <LinksContext.Provider value={linksCtx}>
        <div className="flex h-full flex-col">
          <TopBar
            search={search}
            onSearch={setSearch}
            onNewTask={newTask}
            connection={store.connection}
            unsaved={store.unsaved}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenStats={() => setStatsOpen(true)}
            onExport={() => setExporting(true)}
            onImportCards={() => setImporting(true)}
          />
          {access.archivedAt && <ArchivedBanner boardId={data.board.id} owner={access.role === 'owner'} />}
          <div className="flex min-h-0 flex-1">
            <InboxDock />
            <ViewBar search={search} style={prefs.layout === 'board' ? canvasStyle(data.board.background) : undefined}>
              <main ref={viewRef} className="relative min-h-0 flex-1">
                <Suspense fallback={null}>
                  <View key={viewKey} search={search} />
                </Suspense>
                {dropHere && (
                  <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary/60 bg-background/60">
                    <p className="flex items-center gap-2 rounded-lg bg-background px-4 py-2 text-sm font-medium shadow-md">
                      <Tray className="size-4 text-primary" /> Drop to move to “{data.board.name}”
                    </p>
                  </div>
                )}
              </main>
            </ViewBar>
          </div>
        </div>

        {openId && (
          <Suspense fallback={null}>
            <TaskDialog id={openId} onClose={closeTask} editTitle={openId === justMade} />
          </Suspense>
        )}
        {logging && (
          <Suspense fallback={null}>
            <LogBox initialTask={logging.taskId} onClose={() => setLogging(null)} />
          </Suspense>
        )}
        {shareOpen && (
          <Suspense fallback={null}>
            <ShareDialog open onOpenChange={setShareOpen} />
          </Suspense>
        )}
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        {statsOpen && (
          <Suspense fallback={null}>
            <StatsDialog open onOpenChange={setStatsOpen} />
          </Suspense>
        )}
        {importing && (
          <Suspense fallback={null}>
            <ImportCardsDialog onClose={() => setImporting(false)} />
          </Suspense>
        )}
        {exporting && (
          <Suspense fallback={null}>
            <ExportDialog search={search} onClose={() => setExporting(false)} />
          </Suspense>
        )}
        {movingId && (
          <Suspense fallback={null}>
            <MoveToBoardDialog
              taskId={movingId}
              onClose={() => setMovingId(null)}
              onMoved={() => {
                setMovingId(null)
                if (openId) closeTask()
              }}
            />
          </Suspense>
        )}
        {peek && (
          <Suspense fallback={null}>
            <CardPeek
              key={`${peek.boardId}:${peek.taskId}`}
              boardId={peek.boardId}
              taskId={peek.taskId}
              viewOnly
              onClose={() => setPeek(null)}
              onOpenLinked={setPeek}
            />
          </Suspense>
        )}
      </LinksContext.Provider>
    </BoardContext.Provider>
  )
}
