import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Passage } from '@kanbanto/model/passages'
import { letterAtPoint, lettersOf, mark, passageOf, placesOf, rangeOf, type Letters } from '@/components/text/passages'
import type { Thread } from '@/data/cardComments'

/** The words a comment is being written about, before it is posted: where they are among the text's letters. */
export interface Pending {
  passage: Passage
  start: number
  end: number
}

/**
 * Where the open comments' words are in the text shown in `root`, kept right as the text and the comments change,
 * with the words marked (the one looked at, and the ones being commented on, in their own colours).
 *
 * `text`: what is shown, to know when to look again. `on`: off while there is nothing to mark in (an earlier
 * version is being read).
 */
export function usePassages({
  root,
  threads,
  text,
  active,
  pending,
  on,
}: {
  root: () => HTMLElement | null
  threads: Thread[]
  text: string
  active: string | null
  pending: Pending | null
  on: boolean
}) {
  /** Each open comment's place, by its id (not there: its words aren't in the text). Null until first looked. */
  const [places, setPlaces] = useState<Map<string, { start: number; end: number }> | null>(null)
  const letters = useRef<Letters | null>(null)
  const open = threads.filter((t) => !t.root.resolved)
  // (What decides the places: the text, and which words are looked for.)
  const wanted = open.map((t) => `${t.root.id}:${t.root.passage.quote}`).join('\n')

  useEffect(() => {
    if (!on) return
    // (Once the text is on the page: it may have just changed.)
    const frame = requestAnimationFrame(() => {
      const el = root()
      if (!el) return
      letters.current = lettersOf(el)
      setPlaces(
        placesOf(
          letters.current,
          open.map((t) => ({ key: t.root.id, passage: t.root.passage })),
        ),
      )
    })
    return () => cancelAnimationFrame(frame)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `open` and `root` are read as they are when it runs
  }, [text, wanted, on])

  // The marks follow the places.
  useLayoutEffect(() => {
    const el = root()
    const all = letters.current
    const range = (at: { start: number; end: number } | undefined | null) => (el && all && at ? rangeOf(el, all, at.start, at.end) : null)
    const some = (ranges: (Range | null)[]) => ranges.filter((r): r is Range => !!r)
    const shown = on && places ? [...places].filter(([id]) => id !== active).map(([, at]) => range(at)) : []
    mark('passage', some(shown))
    mark('passage-active', some([on && places && active ? range(places.get(active)) : null]))
    mark('passage-new', some([on && pending ? range(pending) : null]))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `root` is read as it is when it runs
  }, [places, active, pending, on])
  useEffect(
    () => () => {
      for (const name of ['passage', 'passage-active', 'passage-new']) mark(name, [])
    },
    [],
  )

  return {
    places: on ? places : null,
    /** The stretch of the page a comment's words are on (to scroll to them). */
    rangeOf: (id: string) => {
      const el = root()
      const at = places?.get(id)
      return el && letters.current && at ? rangeOf(el, letters.current, at.start, at.end) : null
    },
    /** The open comment whose words are at a point of the screen (the shortest stretch, when several are). */
    at: (x: number, y: number) => {
      const el = root()
      if (!el || !letters.current || !places) return null
      const i = letterAtPoint(el, letters.current, x, y)
      if (i === null) return null
      const under = [...places].filter(([, p]) => p.start <= i && i <= p.end).sort((a, b) => a[1].end - a[1].start - (b[1].end - b[1].start))
      return under[0]?.[0] ?? null
    },
    /** The passage for words selected in the text just now. */
    selected: (range: Range, words: string): Pending | null => {
      const el = root()
      if (!el) return null
      letters.current = lettersOf(el)
      return passageOf(el, letters.current, range, words)
    },
  }
}
