import { CheckCircle } from '@phosphor-icons/react'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
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

/** The Timeline's "Hide done" (the Outline has it in Display; both follow the same setting). */
export function HideDoneToggle() {
  const { prefs, setPrefs } = useBoard()
  const on = !!prefs.outline.hideDone
  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={on}
      title={on ? 'Show done tasks' : 'Hide done tasks'}
      onClick={() => setPrefs({ type: 'setOutline', config: { ...prefs.outline, hideDone: on ? undefined : true } })}
      className="h-8 gap-1.5 aria-pressed:border-primary/50 aria-pressed:bg-primary/10 aria-pressed:text-primary max-sm:px-2"
    >
      <CheckCircle weight={on ? 'fill' : 'regular'} />
      <span className="max-sm:hidden">Hide done</span>
    </Button>
  )
}
