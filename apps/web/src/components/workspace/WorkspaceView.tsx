import { ArrowLeft, ArrowsClockwise, Copy, EnvelopeSimple, SignOut, Trash, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { InvitationResult, WorkspaceDetail, WorkspaceRole } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Avatar } from '@/components/common/bits'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { LogoMark } from '@/components/common/Logo'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { AccountMenu } from '@/components/shell/AccountMenu'
import { NotificationBell } from '@/components/shell/NotificationBell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

const ROLE_TEXT: Record<WorkspaceRole, string> = { admin: 'Admin', member: 'Member' }
const ROLE_HINT: Record<WorkspaceRole, string> = {
  admin: 'Invites and removes people, renames or deletes the workspace',
  member: 'Opens the boards shared with the workspace',
}

const linkFor = (token: string) => `${location.origin}${location.pathname}${hrefFor({ page: 'join', token })}`

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`)
  } catch {
    toast.error('Couldn’t copy. Select it and copy it yourself.')
  }
}

/**
 * A workspace's page: its people (admins invite, change roles and remove; anyone can leave), and for admins, its name
 * and deleting it. Boards aren't managed here: they're on the boards page, grouped by workspace.
 */
export function WorkspaceView({ id }: { id: string }) {
  const { user } = useAuth()
  const base = `/workspaces/${id}`
  const [ws, setWs] = useState<WorkspaceDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    () =>
      api<WorkspaceDetail>('GET', base).then(
        (w) => setWs(w),
        (e) => setError(errorMessage(e)),
      ),
    [base],
  )
  useEffect(() => {
    void load()
  }, [load])
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  useEffect(() => {
    document.title = `${ws?.name ?? 'Workspace'} · Kanbanto`
  }, [ws?.name])

  /** Makes a change, then shows the result (or why it didn't work). */
  const act = async (method: 'PATCH' | 'PUT' | 'DELETE' | 'POST', path: string, body?: unknown, done?: string) => {
    try {
      await api(method, `${base}${path}`, body)
      if (done) toast(done)
      await load()
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    }
  }

  const admin = ws?.role === 'admin'

  const askLeave = () =>
    setConfirm({
      title: `Leave “${ws!.name}”?`,
      description:
        'You won’t be able to open its boards any more, except ones you were added to yourself. Boards you own there stay in the workspace, and an admin becomes their owner.',
      confirmLabel: 'Leave workspace',
      destructive: true,
      onConfirm: () =>
        api('DELETE', `${base}/members/${user!.id}`).then(
          () => {
            toast(`You left “${ws!.name}”`)
            navigate({ page: 'home' }, { replace: true })
          },
          (e) => toast.error(errorMessage(e)),
        ),
    })

  const askRemove = (m: { userId: string; name: string }) =>
    setConfirm({
      title: `Remove ${m.name} from “${ws!.name}”?`,
      description: `${m.name} won’t be able to open its boards any more, except ones they were added to. Boards they own there stay in the workspace, and you become their owner.`,
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: () => void act('DELETE', `/members/${m.userId}`, undefined, `Removed ${m.name}`),
    })

  const askDelete = () =>
    setConfirm({
      title: `Delete “${ws!.name}”?`,
      description: 'Its people lose nothing: it has no boards. They’ll just no longer be in it.',
      confirmLabel: 'Delete workspace',
      destructive: true,
      onConfirm: () =>
        api('DELETE', base).then(
          () => {
            toast(`Deleted “${ws!.name}”`)
            navigate({ page: 'home' }, { replace: true })
          },
          (e) => toast.error(errorMessage(e)),
        ),
    })

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
        <a href={hrefFor({ page: 'home' })} className="grid size-8 place-items-center rounded-md hover:bg-accent" aria-label="Your boards">
          <LogoMark className="size-7" title="Your boards" />
        </a>
        <a href={hrefFor({ page: 'home' })} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Boards
        </a>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <AccountMenu />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-8">
          {!ws ? (
            error && (
              <div className="space-y-2">
                <p className="text-sm">{error}</p>
                <a href={hrefFor({ page: 'home' })} className="text-sm font-medium text-primary hover:underline">
                  Go to your boards
                </a>
              </div>
            )
          ) : (
            <>
              <PageTitle
                title={ws.name}
                description={`${ws.memberCount} ${ws.memberCount === 1 ? 'person' : 'people'} · ${ws.boardCount} ${ws.boardCount === 1 ? 'board' : 'boards'}. Everyone here can open the boards shared with the workspace.`}
              />

              <SettingsCard title={`People (${ws.memberCount})`} description={admin ? undefined : 'Only admins can invite or remove people.'}>
                <ul className="space-y-1">
                  {ws.members.map((m) => {
                    const me = m.userId === user?.id
                    return (
                      <li key={m.userId} className="flex items-center gap-3 py-1.5">
                        <Avatar name={m.name} className="size-8 text-xs" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {m.name}
                            {me && <span className="font-normal text-muted-foreground"> (you)</span>}
                          </span>
                          {m.email && <span className="block truncate text-xs text-muted-foreground">{m.email}</span>}
                        </span>
                        {admin ? (
                          <RoleSelect value={m.role} onChange={(role) => void act('PATCH', `/members/${m.userId}`, { role })} />
                        ) : (
                          <span className="text-xs text-muted-foreground">{ROLE_TEXT[m.role]}</span>
                        )}
                        {admin && !me && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground"
                            aria-label={`Remove ${m.name}`}
                            title={`Remove ${m.name}`}
                            onClick={() => askRemove(m)}
                          >
                            <X />
                          </Button>
                        )}
                      </li>
                    )
                  })}
                  {ws.pending.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 py-1.5">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">
                        <EnvelopeSimple className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{p.email}</span>
                        <span className="block truncate text-xs text-muted-foreground">Invited, hasn’t joined yet</span>
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        aria-label={`Cancel the invite to ${p.email}`}
                        title="Cancel the invite"
                        onClick={() => void act('DELETE', `/invitations/${p.id}`, undefined, `Invite to ${p.email} cancelled`)}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              </SettingsCard>

              {admin && (
                <SettingsCard title="Invite people" description="They can open the boards shared with the workspace as soon as they join.">
                  <InviteByEmail base={base} onDone={() => void load()} />
                  <div className="space-y-2 border-t pt-4">
                    <div className="flex items-start gap-4">
                      <div className="flex-1">
                        <p className="text-sm font-medium">Invite link</p>
                        <p className="text-xs text-muted-foreground">Anyone with the link can join after signing in (or creating an account).</p>
                      </div>
                      <Switch
                        checked={!!ws.link}
                        aria-label="Invite link"
                        onCheckedChange={(on) =>
                          void (on ? act('PUT', '/invites/link', {}) : act('DELETE', '/invites/link', undefined, 'Link turned off'))
                        }
                      />
                    </div>
                    {ws.link && (
                      <div className="flex items-center gap-2">
                        <Input
                          readOnly
                          value={linkFor(ws.link.token)}
                          onFocus={(e) => e.target.select()}
                          className="h-8 font-mono text-xs"
                          aria-label="Invite link"
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label="Copy"
                          title="Copy"
                          onClick={() => void copy(linkFor(ws.link!.token), 'Link')}
                        >
                          <Copy />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0 text-muted-foreground"
                          aria-label="Make a new one"
                          title="Make a new one (the old one stops working)"
                          onClick={() => void act('PUT', '/invites/link', { regenerate: true }, 'New link made. The old one no longer works.')}
                        >
                          <ArrowsClockwise />
                        </Button>
                      </div>
                    )}
                  </div>
                </SettingsCard>
              )}

              {admin && <Rename key={ws.name} name={ws.name} onSave={(name) => act('PATCH', '', { name }, 'Workspace renamed')} />}

              <SettingsCard title={admin ? 'Leave or delete' : 'Leave'}>
                <div className="flex items-center gap-4">
                  <p className="flex-1 text-xs text-muted-foreground">Boards you own here stay in the workspace, and an admin becomes their owner.</p>
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={askLeave}>
                    <SignOut /> Leave workspace
                  </Button>
                </div>
                {admin && (
                  <div className="flex items-center gap-4 border-t pt-4">
                    <p className="flex-1 text-xs text-muted-foreground">
                      {ws.boardCount
                        ? `It still has ${ws.boardCount} ${ws.boardCount === 1 ? 'board' : 'boards'}. Move ${ws.boardCount === 1 ? 'it' : 'them'} to another place or delete ${ws.boardCount === 1 ? 'it' : 'them'} first (in each board’s menu on the boards page).`
                        : 'The workspace has no boards, so nothing is lost.'}
                    </p>
                    <Button variant="outline" size="sm" className="gap-1.5 text-destructive" disabled={ws.boardCount > 0} onClick={askDelete}>
                      <Trash /> Delete workspace
                    </Button>
                  </div>
                )}
              </SettingsCard>
            </>
          )}
        </div>
      </main>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

function RoleSelect({ value, onChange }: { value: WorkspaceRole; onChange: (r: WorkspaceRole) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as WorkspaceRole)}>
      <SelectTrigger size="sm" className="h-8 w-28 text-xs" aria-label="Role">
        <SelectValue>{ROLE_TEXT[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="w-64">
        {(['admin', 'member'] as const).map((r) => (
          <SelectItem key={r} value={r}>
            <span className="flex flex-col">
              <span>{ROLE_TEXT[r]}</span>
              <span className="text-[11px] text-muted-foreground">{ROLE_HINT[r]}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Rename({ name: current, onSave }: { name: string; onSave: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState(current)
  return (
    <SettingsCard title="Name">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void onSave(name.trim())
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" aria-label="Workspace name" required />
        <Button type="submit" size="sm" className="h-8" disabled={!name.trim() || name.trim() === current}>
          Save
        </Button>
      </form>
    </SettingsCard>
  )
}

/**
 * Invite by email: people with an account are added at once, anyone else gets an invite for their address. When no
 * email can go out, the invite link is shown to send yourself.
 */
function InviteByEmail({ base, onDone }: { base: string; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [fallback, setFallback] = useState<{ email: string; why: string; link?: string } | null>(null)

  const invite = async () => {
    setBusy(true)
    setFallback(null)
    try {
      const r = await api<InvitationResult>('POST', `${base}/invitations`, { email: email.trim() })
      const who = r.outcome === 'added' ? (r.name ?? email) : email
      if (r.emailed) toast(r.outcome === 'added' ? `Added ${who} and let them know by email` : `Invite sent to ${who}`)
      else if (r.outcome === 'added') toast(`Added ${who}`, { description: r.why ?? undefined })
      else setFallback({ email: email.trim(), why: r.why ?? 'The email couldn’t be sent.', link: r.token && linkFor(r.token) })
      setEmail('')
      onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">By email</p>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void invite()
        }}
      >
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          className="h-8"
          aria-label="Email"
          required
        />
        <Button type="submit" size="sm" className="h-8" disabled={busy}>
          Invite
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        People with an account are added right away (once they’ve confirmed their email); anyone else gets an invite that only works for their
        address.
      </p>
      {fallback && (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-xs">
          <p>
            <span className="font-medium">No email was sent to {fallback.email}.</span> {fallback.why}
          </p>
          {fallback.link && (
            <div className="flex items-center gap-2">
              <Input readOnly value={fallback.link} onFocus={(e) => e.target.select()} className="h-8 font-mono text-xs" aria-label="Invite link" />
              <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void copy(fallback.link!, 'Invite link')}>
                <Copy /> Copy
              </Button>
            </div>
          )}
          {fallback.link && <p className="text-muted-foreground">Send it to them yourself. It only works for {fallback.email}.</p>}
        </div>
      )}
    </div>
  )
}
