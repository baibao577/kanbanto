import { useMemo } from 'react'
import { useBoard } from '@/app/board-context'
import { filterCount, matchesFilter } from '@kanbanto/model/table'
import { keepMatching } from '@kanbanto/model/tree'
import { matcher } from '@kanbanto/model/view'

/**
 * Search + filters for the tree tabs (Timeline, Outline): the matching tasks plus their parents for context.
 * Both are undefined when nothing is searched or filtered.
 */
export function useTreeFilter(search: string) {
  const { prefs, idx, counts } = useBoard()
  const f = prefs.filter
  const filtering = filterCount(f) > 0
  return useMemo(() => {
    const m = matcher(search)
    if (!m && !filtering) return { keep: undefined, matched: undefined, filtering }
    const r = keepMatching(idx, (id) => (!m || m(idx.tasks[id].title)) && (!filtering || matchesFilter(idx, id, f, counts.lastComment)))
    return { ...r, filtering }
  }, [idx, search, filtering, f, counts.lastComment])
}
