import { useSyncExternalStore } from 'react'

/** Whether a CSS media query matches now (and re-renders when that changes), e.g. '(max-width: 767px)'. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query)
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}
