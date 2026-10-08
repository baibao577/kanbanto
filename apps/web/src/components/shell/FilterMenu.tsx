import { FunnelSimple } from '@phosphor-icons/react'
import { useState } from 'react'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { filterCount } from '@kanbanto/model/table'
import { FilterEditor } from './FilterEditor'

/**
 * "Filter" popover, shared by every tab: the person's own filter, changed with the controls that say which cards
 * (see FilterEditor).
 */
export function FilterMenu() {
  const { prefs, setPrefs } = useBoard()
  const f = prefs.filter
  const n = filterCount(f)
  // (A field opened and left without a test is put away again when the menu closes, or the filter is cleared.)
  const [round, setRound] = useState(0)

  return (
    <Popover onOpenChange={(open) => !open && setRound((r) => r + 1)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 max-sm:px-2" title="Filter">
          <FunnelSimple />
          <span className="max-sm:hidden">Filter</span>
          {n > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {n}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[calc(100dvh-7rem)] w-80 overflow-y-auto p-0">
        <FilterEditor key={round} value={f} onChange={(filter) => setPrefs({ type: 'setFilter', filter })} />
        {n > 0 && (
          <>
            <Separator />
            <div className="flex justify-end p-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setPrefs({ type: 'setFilter', filter: {} })
                  setRound((r) => r + 1)
                }}
              >
                Clear filters
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
