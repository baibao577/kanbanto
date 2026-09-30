import { useEffect, useState } from 'react'

/** The time now (ms), refreshed every `every` ms, so time-based views stay current without reading the clock while rendering. */
export function useNow(every = 60_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(t)
  }, [every])
  return now
}
