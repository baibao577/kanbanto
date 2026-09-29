import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** One group of settings in the Platform console: a title, a line saying what it's for, and the controls. */
export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border bg-card', className)}>
      <header className="flex items-start gap-4 border-b px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </header>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </section>
  )
}

/** The title of a console page. */
export function PageTitle({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}
