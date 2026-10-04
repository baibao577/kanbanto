import type { ReactNode } from 'react'
import { useAuth } from '@/app/use-auth'
import { LogoMark } from '@/components/common/Logo'

/** A centered card with the logo, for sign-in, sign-up and invites; under it, the site's own links (privacy policy, terms…). */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { links } = useAuth()
  return (
    <div className="grid min-h-full place-items-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <LogoMark className="size-9" />
          <span className="text-lg font-semibold">Kanbanto</span>
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {links.length > 0 && (
          <nav aria-label="About this site" className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {links.map((l) => (
              <a key={`${l.label} ${l.url}`} href={l.url} className="hover:text-foreground hover:underline">
                {l.label}
              </a>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}
