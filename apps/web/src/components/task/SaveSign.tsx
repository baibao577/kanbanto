import { cn } from '@/lib/utils'

/**
 * Whether what's being written is saved: a dot, and the words (on a narrow screen, the dot alone). Writing is saved
 * when you finish; until then it's kept as a draft in this browser. `auto`: it is saved as it is written (a
 * description written with other people, see data/liveDoc.ts). `offline`: there's no connection just now. `long`: the
 * text is longer than a description may be, so it isn't being saved.
 */
export function SaveSign({
  dirty,
  auto,
  offline,
  long,
  className,
}: {
  dirty: boolean
  auto?: boolean
  offline?: boolean
  long?: boolean
  className?: string
}) {
  const label = long ? 'Too long to save' : offline ? 'Offline' : dirty ? (auto ? 'Saving…' : 'Not saved yet') : 'Saved'
  const title = long
    ? 'A description holds 50,000 characters at the most. This one is longer, so it isn’t being saved: shorten it.'
    : offline
      ? 'No connection just now. What you write stays here, and is put together with what the others wrote when you’re back.'
      : auto
        ? 'Saved as you write.'
        : dirty
          ? 'Saved when you finish (Esc, ⌘Enter or clicking away), or with ⌘S. Until then it’s kept as a draft in this browser.'
          : undefined
  return (
    <span role="status" title={title} className={cn('flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground', className)}>
      <span className={cn('size-1.5 rounded-full', long ? 'bg-red-500' : dirty || offline ? 'bg-amber-500' : 'bg-emerald-500')} />
      <span className="max-sm:sr-only">{label}</span>
    </span>
  )
}
