import { useBoard } from '@/app/board-context'
import { cn } from '@/lib/utils'

/** "12 done tasks hidden · Show", under the Outline and the Timeline while Hide done is on. */
export function HiddenDoneNote({ count, className }: { count: number; className?: string }) {
  const { prefs, setPrefs } = useBoard()
  if (!count) return null
  return (
    <p className={cn('px-1 text-xs text-muted-foreground', className)}>
      {count.toLocaleString()} done {count === 1 ? 'task' : 'tasks'} hidden ·{' '}
      <button
        onClick={() => setPrefs({ type: 'setOutline', config: { ...prefs.outline, hideDone: undefined } })}
        className="font-medium text-foreground/80 hover:text-foreground hover:underline"
      >
        Show
      </button>
    </p>
  )
}
