import { createContext, useContext } from 'react'

/** The board that's open, for filing Inbox cards on it. */
export interface InboxPage {
  boardId: string
  name: string
  /** You can add cards to it (not view-only, not archived). */
  canEdit: boolean
}

/**
 * The last change made in the panel, and when: the page's undo keys take back the newest change, the page's own or
 * this one. `undo` and `redo` say whether there was anything of the panel's to take back or redo.
 */
export interface InboxActs {
  at: number
  undo: () => boolean
  redo: () => boolean
}

export interface InboxValue {
  /** Your Inbox's board (null until it's known, and when signed out). */
  boardId: string | null
  /** The open page is your Inbox itself, as a board: the panel has nothing to add there. */
  here: boolean
  /** How many of its cards aren't done. */
  count: number
  setCount: (n: number) => void
  /** The panel is open (remembered on this device; on a phone, until you leave the page). */
  open: boolean
  /** A phone: the panel is a sheet over the page. */
  phone: boolean
  /** Opens or closes the panel. `add`: with the cursor in "Add a card". */
  show: (open: boolean, opts?: { add?: boolean }) => void
  /** Changes each time "Add a card" is asked for; 0 once the panel has put the cursor there (`addTaken`). */
  addSignal: number
  addTaken: () => void
  /** Where the panel goes on the open page (pages that have room for it render an `InboxDock`). */
  dock: HTMLElement | null
  setDock: (el: HTMLElement | null) => void
  page: InboxPage | null
  setPage: (page: InboxPage | null) => void
  /** Asks the server again how many cards wait (something moved in or out in a way the panel didn't see). */
  refresh: () => void
  /** The panel says what its last change was (null: it closed), and the page's undo keys ask for it. */
  setActs: (acts: InboxActs | null) => void
  lastActs: () => InboxActs | null
}

export const InboxContext = createContext<InboxValue | null>(null)

export function useInbox(): InboxValue {
  const ctx = useContext(InboxContext)
  if (!ctx) throw new Error('useInbox must be used inside <InboxProvider>')
  return ctx
}
