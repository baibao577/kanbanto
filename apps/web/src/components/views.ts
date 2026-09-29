import { ChartBarHorizontal, Kanban, TreeView, type Icon } from '@phosphor-icons/react'
import { lazy, type ComponentType } from 'react'
import { LAYOUTS, type Layout } from '@kanbanto/model/types'
import { BoardView } from '@/components/board/BoardView'

/** What every view is given. */
export interface ViewProps {
  search: string
}

/**
 * The ways to look at a board (the tabs). To add one: add its id to LAYOUTS in packages/model/src/types.ts (the
 * saved preferences and addresses take it from there), then describe it here. Views other than the board load on
 * first use.
 */
export const VIEWS: Record<Layout, { label: string; icon: Icon; hint: string; component: ComponentType<ViewProps> }> = {
  board: { label: 'Board', icon: Kanban, hint: 'Cards in lists', component: BoardView },
  timeline: {
    label: 'Timeline',
    icon: ChartBarHorizontal,
    hint: 'Tasks on a calendar',
    component: lazy(() => import('@/components/timeline/TimelineView').then((m) => ({ default: m.TimelineView }))),
  },
  outline: {
    label: 'Outline',
    icon: TreeView,
    hint: 'Everything as a table you can sort and filter',
    component: lazy(() => import('@/components/outline/OutlineView').then((m) => ({ default: m.OutlineView }))),
  },
}

/** The tabs, in order. */
export const VIEW_TABS = LAYOUTS.map((id) => ({ id, ...VIEWS[id] }))
