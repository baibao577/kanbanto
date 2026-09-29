import { X } from '@phosphor-icons/react'
import { useBoard } from '@/app/board-context'
import { filterChips, type TableFilter } from '@kanbanto/model/table'

/** The active filters as removable chips; shown in the view bar on every tab. */
export function FilterChips() {
  const { data, prefs, setPrefs } = useBoard()
  const chips = filterChips(prefs.filter, data.columns, data.labels, data.members)
  if (!chips.length) return null
  const remove = (key: keyof TableFilter) => setPrefs({ type: 'setFilter', filter: { ...prefs.filter, [key]: undefined } })
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span key={c.key} className="inline-flex h-7 items-center gap-1 rounded-full border bg-card pr-1 pl-3 text-xs">
          <span className="text-muted-foreground">{c.label}</span>
          <span className="font-medium">{c.value}</span>
          <button
            aria-label={`Remove “${c.label} ${c.value}”`}
            onClick={() => remove(c.key)}
            className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button onClick={() => setPrefs({ type: 'setFilter', filter: {} })} className="px-1 text-xs text-muted-foreground hover:text-foreground">
          Clear all
        </button>
      )}
    </div>
  )
}
