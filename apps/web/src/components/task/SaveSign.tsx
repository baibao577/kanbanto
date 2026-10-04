import { cn } from '@/lib/utils'

/**
 * Whether what's being written is saved: a dot, and the words (on a narrow screen, the dot alone). Writing is saved
 * when you finish; until then it's kept as a draft in this browser.
 */
export function SaveSign({ dirty, className }: { dirty: boolean; className?: string }) {
  const label = dirty ? 'Not saved yet' : 'Saved'
  return (
    <span
      role="status"
      title={dirty ? 'Saved when you finish (Esc, ⌘Enter or clicking away), or with ⌘S. Until then it’s kept as a draft in this browser.' : undefined}
      className={cn('flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground', className)}
    >
      <span className={cn('size-1.5 rounded-full', dirty ? 'bg-amber-500' : 'bg-emerald-500')} />
      <span className="max-sm:sr-only">{label}</span>
    </span>
  )
}
