import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A part of the task dialog: a tinted icon, the title, an optional count, and actions on the right. Sections sit on
 * the dialog's plain background, separated by a line and spacing (the first one has no line).
 */
export function Section({
  icon,
  title,
  count,
  aside,
  children,
  className,
}: {
  icon: ReactNode
  title: string
  count?: number
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn(className)}>
      <header className="mb-3 flex min-h-7 items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        {!!count && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">{count}</span>}
        {aside && <div className="ml-auto">{aside}</div>}
      </header>
      {children}
    </section>
  )
}
