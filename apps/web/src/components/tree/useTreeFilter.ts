import { useMemo } from 'react'
import { useBoard } from '@/app/board-context'
import { descendantsOf } from '@kanbanto/model/indexer'
import { filterCount, matchesFilter } from '@kanbanto/model/table'
import { keepMatching } from '@kanbanto/model/tree'
import { matcher } from '@kanbanto/model/view'

/**
 * Search, filters and "Hide done" for the tree tabs (Timeline, Outline): the tasks to show plus their parents for
 * context. `matched` (what search and filters found) is undefined when neither is on; `hiddenDone` counts the
 * finished tasks left out.
 */
export function useTreeFilter(search: string) {
  const { prefs, idx, counts } = useBoard()
  const f = prefs.filter
  const filtering = filterCount(f) > 0
  const hideDone = !!prefs.outline.hideDone
  const focusId = prefs.focusId
  return useMemo(() => {
    const m = matcher(search)
    if (!m && !filtering && !hideDone) return { keep: undefined, matched: undefined, filtering, hiddenDone: 0 }
    const passes = (id: string) => (!m || m(idx.tasks[id].title)) && (!filtering || matchesFilter(idx, id, f, counts.lastComment))
    const open = (id: string) => idx.category.get(id) !== 'done'
    const r = keepMatching(idx, (id) => passes(id) && (!hideDone || open(id)))
    const scope = focusId && focusId in idx.tasks ? descendantsOf(idx, focusId) : idx.preorder
    const hiddenDone = hideDone ? scope.filter((id) => !open(id) && !r.keep.has(id) && passes(id)).length : 0
    return { keep: r.keep, matched: m || filtering ? r.matched : undefined, filtering, hiddenDone }
  }, [idx, search, filtering, f, counts.lastComment, hideDone, focusId])
}
