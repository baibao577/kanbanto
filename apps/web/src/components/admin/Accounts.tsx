import { Copy, DotsThree, EnvelopeSimpleOpen, Key, Power } from '@phosphor-icons/react'
import { format, parseISO } from 'date-fns'
import { useState } from 'react'
import { toast } from 'sonner'
import type { AdminUser } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useLoaded } from '@/data/useLoaded'
import { hrefFor } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Avatar } from '@/components/common/bits'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'

const fetchAccounts = () =>
  Promise.all([api<{ users: AdminUser[] }>('GET', '/admin/users'), api<{ openSignup: boolean }>('GET', '/admin/settings')]).then(([u, s]) => ({
    users: u.users,
    openSignup: s.openSignup,
  }))

/** Platform console → Accounts: who can sign up, and everyone who has. */
export function AccountsSection() {
  const { user, emailEnabled } = useAuth()
  const [loaded, load] = useLoaded(fetchAccounts)
  const users = loaded?.users ?? null
  const openSignup = loaded?.openSignup ?? null
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [reset, setReset] = useState<{ name: string; url: string } | null>(null)

  const update = async (u: AdminUser, fields: { disabled: boolean } | { emailVerified: true }, done: string) => {
    try {
      await api('PATCH', `/admin/users/${u.id}`, fields)
      toast(done)
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  // The link uses the address you're using, so it works however this site is reached.
  const resetLink = (u: AdminUser) =>
    api<{ token: string }>('POST', `/admin/users/${u.id}/reset-link`).then(
      ({ token }) => setReset({ name: u.name, url: `${location.origin}${location.pathname}${hrefFor({ page: 'reset', token })}` }),
      (e) => toast.error(errorMessage(e)),
    )

  const confirmEmail = (u: AdminUser) =>
    setConfirm({
      title: `Confirm ${u.email} for ${u.name}?`,
      description:
        'They won’t be asked to confirm it by email. Only do this if you know the address is theirs: board invites sent to it will go to this account.',
      confirmLabel: 'Confirm email',
      onConfirm: () => void update(u, { emailVerified: true }, `${u.name}’s email is confirmed`),
    })

  const turnOff = (u: AdminUser) =>
    setConfirm({
      title: `Turn off ${u.name}’s account?`,
      description: 'They’ll be signed out and can’t sign in until you turn it back on. Their boards and tasks stay as they are.',
      confirmLabel: 'Turn off account',
      destructive: true,
      onConfirm: () => void update(u, { disabled: true }, `${u.name}’s account is turned off`),
    })

  if (!user) return null
  return (
    <div className="space-y-6">
      <PageTitle
        title="Accounts"
        description="Everyone with an account. People’s boards aren’t visible here: you see a board only if someone shares it with you."
      />
      <SettingsCard
        title="Anyone can create an account"
        description="When this is off, people can only sign up through a board’s share link, access code or email invite."
        action={
          openSignup !== null && (
            <Switch
              checked={openSignup}
              aria-label="Anyone can create an account"
              onCheckedChange={(on) =>
                api('PATCH', '/admin/settings', { openSignup: on }).then(
                  () => {
                    void load()
                    toast(on ? 'Anyone can sign up now' : 'Sign-up now needs an invite')
                  },
                  (e) => toast.error(errorMessage(e)),
                )
              }
            />
          )
        }
      >
        <p className="text-xs text-muted-foreground">{openSignup ? 'Open: anyone can create an account.' : 'Invite only.'}</p>
      </SettingsCard>
      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold">People</h2>
          {users && <span className="text-sm text-muted-foreground">{users.length}</span>}
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">Boards owned</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">Joined</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {users?.map((u) => (
                <tr key={u.id} className={cn('border-b last:border-0', u.disabled && 'text-muted-foreground')}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar name={u.name} className="size-8 text-xs" />
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {u.name}
                          {u.id === user.id && <span className="font-normal text-muted-foreground"> (you)</span>}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-4 py-2.5 tabular-nums sm:table-cell">{u.boards}</td>
                  <td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">{format(parseISO(u.createdAt), 'd MMM yyyy')}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {u.isAdmin && <Badge className="bg-primary/10 text-primary">Platform admin</Badge>}
                      {u.disabled ? <Badge className="bg-destructive/10 text-destructive">Turned off</Badge> : !u.isAdmin && <Badge>Active</Badge>}
                      {emailEnabled && !u.emailVerified && !u.isAdmin && !u.disabled && (
                        <Badge className="bg-amber-500/10 text-amber-800 dark:text-amber-200">Email not confirmed</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    {u.id !== user.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" aria-label={`${u.name} options`}>
                            <DotsThree weight="bold" className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onSelect={() => void resetLink(u)}>
                            <Key /> Password reset link…
                          </DropdownMenuItem>
                          {!u.emailVerified && !u.isAdmin && (
                            <DropdownMenuItem onSelect={() => confirmEmail(u)}>
                              <EnvelopeSimpleOpen /> Confirm email…
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {u.disabled ? (
                            <DropdownMenuItem onSelect={() => void update(u, { disabled: false }, `${u.name}’s account is turned on`)}>
                              <Power /> Turn account on
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem variant="destructive" onSelect={() => turnOff(u)}>
                              <Power /> Turn account off…
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Platform admin rights are given on the server: <code className="rounded bg-muted px-1 py-0.5">admin grant &lt;email&gt;</code>.
        </p>
      </section>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <Dialog open={!!reset} onOpenChange={(o) => !o && setReset(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Password reset link for {reset?.name}</DialogTitle>
            <DialogDescription>
              Send it to them privately. It works once, for 24 hours, and lets them choose a new password. Until they use it, their current password
              keeps working.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs">{reset?.url}</code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy link"
              onClick={() => reset && void navigator.clipboard.writeText(reset.url).then(() => toast('Link copied'))}
            >
              <Copy />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setReset(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium', className)}>{children}</span>
}
