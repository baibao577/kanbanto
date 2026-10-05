import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { LinkedCard } from '@kanbanto/model/api'
import type { LinkStore } from '@/data/links'

/**
 * Links between cards, for the chips that show them: what each points at, and how to open it. Its own context (and
 * the same value for as long as a board is open), apart from the board's: a chip is told about its own card and
 * nothing else, so a board with thousands of them isn't redrawn when one title arrives.
 */
export interface LinksContextValue {
  store: LinkStore
  /** Opens the card a link points at: on this board as usual, on another board in place, to look. */
  open: (ref: string) => void
}

export const LinksContext = createContext<LinksContextValue | null>(null)

export const useLinks = () => useContext(LinksContext)

const never = () => {}

/** What one link points at, kept up to date (undefined while it isn't known, or outside a board). */
export function useLinked(ref: string): LinkedCard | undefined {
  const store = useContext(LinksContext)?.store
  const subscribe = useCallback((l: () => void) => store?.subscribe(ref, l) ?? never, [store, ref])
  return useSyncExternalStore(subscribe, () => store?.get(ref))
}
