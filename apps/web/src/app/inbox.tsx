import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InboxInfo } from '@kanbanto/model/api'
import { api } from '@/api/client'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { currentRoute, navigate, useRoute } from './router'
import { useAuth } from './use-auth'
import { InboxContext, type InboxActs, type InboxPage, type InboxValue } from './use-inbox'

const InboxLive = lazy(() => import('@/components/inbox/InboxLive'))

const OPEN_KEY = 'kankan:inbox:open'
const wasOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Your Inbox, beside whatever page is open: a board of your own (see boards/inbox.ts on the server) shown as a panel
 * that a button in the top bar opens. This knows which board it is and how many cards wait in it, keeps the panel
 * open from page to page, and holds the board itself live while the panel (or one of its cards) is showing.
 */
export function InboxProvider({ children }: { children: ReactNode }) {
  const { user, mustVerify } = useAuth()
  const route = useRoute()
  const userId = user && !mustVerify ? user.id : null
  const [info, setInfo] = useState<{ userId: string; boardId: string | null; open: number } | null>(null)
  const boardId = info && info.userId === userId ? info.boardId : null

  const refresh = useCallback(() => {
    if (!userId) return
    api<InboxInfo>('GET', '/inbox').then(
      (r) => setInfo({ userId, ...r }),
      () => {},
    )
  }, [userId])
  useEffect(() => {
    if (!userId) return
    let alive = true
    // Everyone has an Inbox: it's made the first time the app opens for them.
    api<InboxInfo>('GET', '/inbox')
      .then((r) => (r.boardId ? r : api<InboxInfo>('POST', '/inbox')))
      .then(
        (r) => alive && setInfo({ userId, ...r }),
        () => {},
      )
    const timer = setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [userId, refresh])
  const setCount = useCallback((open: number) => setInfo((i) => (i && i.open !== open ? { ...i, open } : i)), [])

  // Open or closed: on a computer it's remembered; on a phone it covers the page, so it starts closed each time.
  const phone = useMediaQuery('(max-width: 639px)')
  const where = route.page === 'board' ? route.id : route.page
  const [docked, setDocked] = useState(wasOpen)
  const [sheetOn, setSheetOn] = useState<string | null>(null)
  const [addSignal, setAddSignal] = useState(0)
  const addTaken = useCallback(() => setAddSignal(0), [])
  const show = useCallback(
    (open: boolean, opts?: { add?: boolean }) => {
      if (phone) setSheetOn(open ? where : null)
      else {
        setDocked(open)
        try {
          localStorage.setItem(OPEN_KEY, open ? '1' : '0')
        } catch {
          // (Private browsing: it just isn't remembered.)
        }
      }
      if (open && opts?.add) setAddSignal(Date.now())
    },
    [phone, where],
  )

  const [dock, setDock] = useState<HTMLElement | null>(null)
  const [page, setPage] = useState<InboxPage | null>(null)
  const acts = useRef<InboxActs | null>(null)
  const setActs = useCallback((a: InboxActs | null) => {
    acts.current = a
  }, [])
  const lastActs = useCallback(() => acts.current, [])

  const onPage = route.page === 'board' || route.page === 'home'
  const here = route.page === 'board' && !!boardId && route.id === boardId
  const open = phone ? sheetOn === where : docked
  const card = onPage ? route.inbox : undefined

  // A card of the Inbox in the address. Arrived with it (a link, a new tab): put the page under it, so closing the
  // card goes there. On the Inbox board itself, it's simply one of the board's cards.
  useEffect(() => {
    if (!card || !boardId) return
    const r = currentRoute()
    if ((r.page !== 'board' && r.page !== 'home') || r.inbox !== card) return
    if (r.page === 'board' && r.id === boardId) navigate({ ...r, inbox: undefined, task: card }, { replace: true, state: history.state })
    else if (!(history.state as { taskDepth?: number } | null)?.taskDepth) {
      navigate({ ...r, inbox: undefined }, { replace: true })
      navigate(r, { state: { taskDepth: 1 } })
    }
  }, [card, boardId])

  // I: open the Inbox with the cursor in "Add a card". On your boards page, undo and redo are for the panel (on a
  // board, the board's own keys ask the panel first: see Workspace in App.tsx).
  const active = !!boardId && onPage && !here
  const home = route.page === 'home'
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('[role=dialog]')) return
      const key = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey
      if (key === 'i' && !mod && !e.altKey) {
        e.preventDefault()
        show(true, { add: true })
      } else if (home && mod && (key === 'z' || key === 'y') && acts.current) {
        e.preventDefault()
        if (key === 'y' || e.shiftKey) acts.current.redo()
        else acts.current.undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, home, show])

  const value: InboxValue = useMemo(
    () => ({
      boardId,
      here,
      count: boardId ? (info?.open ?? 0) : 0,
      setCount,
      open,
      phone,
      show,
      addSignal,
      addTaken,
      dock,
      setDock,
      page,
      setPage,
      refresh,
      setActs,
      lastActs,
    }),
    [boardId, here, info?.open, setCount, open, phone, show, addSignal, addTaken, dock, page, refresh, setActs, lastActs],
  )

  return (
    <InboxContext.Provider value={value}>
      {children}
      {active && (open || card) && (
        <Suspense fallback={null}>
          <InboxLive key={boardId} boardId={boardId} cardId={card} />
        </Suspense>
      )}
    </InboxContext.Provider>
  )
}
