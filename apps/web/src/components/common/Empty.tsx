import { Tray } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

/** Centered message for an empty view, with an optional action. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Tray />
        </div>
        <p className="text-sm text-muted-foreground">{children}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  )
}
