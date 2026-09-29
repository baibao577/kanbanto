import { ArrowLeft, type Icon } from '@phosphor-icons/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { hrefFor, type Route } from '@/app/router'
import { LogoMark } from '@/components/common/Logo'
import { AccountMenu } from '@/components/shell/AccountMenu'
import { NotificationBell } from '@/components/shell/NotificationBell'
import { cn } from '@/lib/utils'

export interface SettingsNavItem {
  id: string
  label: string
  icon: Icon
  href: Route
}

/**
 * A settings area (your account, the Platform console): a sidebar of sections — a row of tabs on narrow screens —
 * and the chosen section on the right. Each section has its own address, so links and Back work.
 */
export function SettingsLayout({
  title,
  items,
  current,
  children,
}: {
  title: string
  items: SettingsNavItem[]
  current: string
  children: ReactNode
}) {
  // On narrow screens the sections are a scrolling row of tabs: keep the chosen one in view.
  const active = useRef<HTMLAnchorElement>(null)
  // (Braces matter: newer browsers return a promise from scrollIntoView, and an effect may only return a cleanup.)
  useEffect(() => {
    active.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current])
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
        <a href={hrefFor({ page: 'home' })} className="grid size-8 place-items-center rounded-md hover:bg-accent" aria-label="Your boards">
          <LogoMark className="size-7" title="Your boards" />
        </a>
        <a href={hrefFor({ page: 'home' })} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Boards
        </a>
        <span className="text-sm font-semibold">{title}</span>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <AccountMenu />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label={`${title} sections`} className="shrink-0 border-b bg-muted/30 md:w-56 md:border-r md:border-b-0">
          <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col md:p-3">
            {items.map(({ id, label, icon: Icon, href }) => {
              const on = id === current
              return (
                <li key={id}>
                  <a
                    ref={on ? active : undefined}
                    href={hrefFor(href)}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground',
                      on && 'bg-background font-medium text-foreground shadow-xs',
                    )}
                  >
                    <Icon weight={on ? 'fill' : 'regular'} className="size-4" />
                    {label}
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
