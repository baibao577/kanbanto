import { ArrowsClockwise, Copy, EnvelopeSimple, SignOut, X } from '@phosphor-icons/react'
import { useCallback, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { InvitationResult, Role, Sharing, Visibility } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useLoaded } from '@/data/useLoaded'
import { useBoard } from '@/app/board-context'
import { hrefFor, navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Avatar } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { VISIBILITY } from './visibility'

const ROLE_TEXT: Record<Role, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }
const ROLE_HINT: Record<Role, string> = {
  owner: 'Can edit, share and delete the board',
  editor: 'Can add and change tasks',
  viewer: 'Can see the board, not change it',
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

/** Who can open the board, invites (share link, access code, by email) and the people on it. */
export function ShareDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useBoard()
  const { user } = useAuth()
  const boardId = data.board.id
  const base = `/boards/${boardId}`
  const [sharing, load] = useLoaded(useCallback(() => api<Sharing>('GET', `${base}/sharing`), [base]))

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

  const manage = !!sharing?.canManage
  const paused = sharing?.visibility === 'private'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{data.board.name}”</DialogTitle>
          <DialogDescription>
            {manage ? 'Choose who can open this board and invite people.' : 'Only the board’s owners can change who can open it.'}
          </DialogDescription>
        </DialogHeader>

        {!sharing ? (
          <div className="h-40" />
        ) : (
          <div className="space-y-6">
            <Section title="Who can open this board">
              {manage ? (
                <RadioGroup
                  value={sharing.visibility}
                  onValueChange={(v) => void act('PATCH', '/sharing', { visibility: v as Visibility })}
                  className="gap-2"
                >
                  {(['private', 'invited', 'public'] as const).map((v) => {
                    const { icon: Icon, title, hint } = VISIBILITY[v]
                    return (
                      <label
                        key={v}
                        className="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                      >
                        <RadioGroupItem value={v} className="mt-0.5" />
                        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span className="space-y-0.5">
                          <span className="block text-sm font-medium">{title}</span>
                          <span className="block text-xs leading-relaxed text-muted-foreground">{hint}</span>
                        </span>
                      </label>
                    )
                  })}
                </RadioGroup>
              ) : (
                <p className="flex items-center gap-2 text-sm">
                  {(() => {
                    const { icon: Icon, label } = VISIBILITY[sharing.visibility]
                    return (
                      <>
                        <Icon className="size-4 text-muted-foreground" /> {label}
                      </>
                    )
                  })()}
                </p>
              )}
            </Section>

            {manage && (
              <>
                {paused && (
                  <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                    The board is private, so the link and code can’t be used to join it until you share it again.
                  </p>
                )}
                <Invite
                  title="Invite with a link"
                  hint="Anyone with the link can join after signing in (or creating an account)."
                  invite={sharing.link && { value: linkFor(sharing.link.token), role: sharing.link.role }}
                  display={(v) => (
                    <Input readOnly value={v} onFocus={(e) => e.target.select()} className="h-8 font-mono text-xs" aria-label="Share link" />
                  )}
                  onCopy={(v) => void copy(v, 'Link')}
                  onEnable={(role) => act('PUT', '/invites/link', { role })}
                  onRole={(role) => act('PUT', '/invites/link', { role })}
                  onReset={() =>
                    act('PUT', '/invites/link', { role: sharing.link!.role, regenerate: true }, 'New link made. The old one no longer works.')
                  }
                  onDisable={() => act('DELETE', '/invites/link', undefined, 'Link turned off')}
                />
                <Invite
                  title="Invite with an access code"
                  hint="People enter it under “Join with a code” on their boards page."
                  invite={sharing.code && { value: sharing.code.code, role: sharing.code.role }}
                  display={(v) => (
                    <span className="flex h-8 flex-1 items-center rounded-md border bg-muted/50 px-3 font-mono text-base tracking-[0.2em]">{v}</span>
                  )}
                  onCopy={(v) => void copy(v, 'Code')}
                  onEnable={(role) => act('PUT', '/invites/code', { role })}
                  onRole={(role) => act('PUT', '/invites/code', { role })}
                  onReset={() =>
                    act('PUT', '/invites/code', { role: sharing.code!.role, regenerate: true }, 'New code made. The old one no longer works.')
                  }
                  onDisable={() => act('DELETE', '/invites/code', undefined, 'Code turned off')}
                />
                <InviteByEmail boardId={boardId} onDone={() => void load()} />
              </>
            )}

            <Section title={`People on this board (${sharing.members.length})`}>
              <ul className="space-y-1">
                {sharing.members.map((m) => {
                  const me = m.userId === user?.id
                  return (
                    <li key={m.userId} className="flex items-center gap-3 rounded-md py-1.5">
                      <Avatar name={m.name} className="size-8 text-xs" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {m.name}
                          {me && <span className="font-normal text-muted-foreground"> (you)</span>}
                        </span>
                        {m.email && <span className="block truncate text-xs text-muted-foreground">{m.email}</span>}
                      </span>
                      {manage ? (
                        <RoleSelect
                          value={m.role}
                          roles={['owner', 'editor', 'viewer']}
                          onChange={(role) => void act('PATCH', `/members/${m.userId}`, { role })}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">{ROLE_TEXT[m.role]}</span>
                      )}
                      {(manage || me) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground"
                          aria-label={me ? 'Leave this board' : `Remove ${m.name}`}
                          title={me ? 'Leave this board' : `Remove ${m.name}`}
                          onClick={async () => {
                            const ok = await act('DELETE', `/members/${m.userId}`, undefined, me ? undefined : `Removed ${m.name}`)
                            if (ok && me) {
                              onOpenChange(false)
                              navigate({ page: 'home' }, { replace: true })
                              toast(`You left “${data.board.name}”`)
                            }
                          }}
                        >
                          {me ? <SignOut /> : <X />}
                        </Button>
                      )}
                    </li>
                  )
                })}
                {sharing.pending.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 rounded-md py-1.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">
                      <EnvelopeSimple className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{p.email}</span>
                      <span className="block truncate text-xs text-muted-foreground">Invited, hasn’t joined yet</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{ROLE_TEXT[p.role]}</span>
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
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, hint, children, action }: { title: string; hint?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Label>{title}</Label>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function RoleSelect({ value, roles, onChange, className }: { value: Role; roles: Role[]; onChange: (r: Role) => void; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)}>
      <SelectTrigger size="sm" className={cn('h-8 w-28 text-xs', className)} aria-label="Role">
        {/* Just the role here; the list also explains each one. */}
        <SelectValue>{ROLE_TEXT[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="w-64">
        {roles.map((r) => (
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

/** A share link or access code: on/off, what it lets people do, copy, and replace. */
function Invite(props: {
  title: string
  hint: string
  invite: { value: string; role: 'editor' | 'viewer' } | null
  display: (value: string) => ReactNode
  onCopy: (value: string) => void
  onEnable: (role: 'editor' | 'viewer') => Promise<boolean>
  onRole: (role: 'editor' | 'viewer') => Promise<boolean>
  onReset: () => Promise<boolean>
  onDisable: () => Promise<boolean>
}) {
  const { invite } = props
  return (
    <Section
      title={props.title}
      hint={props.hint}
      action={
        <Switch checked={!!invite} aria-label={props.title} onCheckedChange={(on) => void (on ? props.onEnable('editor') : props.onDisable())} />
      }
    >
      {invite && (
        <div className="flex items-center gap-2">
          {props.display(invite.value)}
          <Button variant="outline" size="icon" className="size-8 shrink-0" aria-label="Copy" title="Copy" onClick={() => props.onCopy(invite.value)}>
            <Copy />
          </Button>
          <RoleSelect value={invite.role} roles={['editor', 'viewer']} onChange={(r) => void props.onRole(r as 'editor' | 'viewer')} />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label="Make a new one"
            title="Make a new one (the old one stops working)"
            onClick={() => void props.onReset()}
          >
            <ArrowsClockwise />
          </Button>
        </div>
      )}
    </Section>
  )
}

/**
 * Invite by email: people with an account are added at once, anyone else gets an invite for their address.
 * When no email can go out (not set up, or over a limit), the invite link is shown to send yourself.
 */
function InviteByEmail({ boardId, onDone }: { boardId: string; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [busy, setBusy] = useState(false)
  const [fallback, setFallback] = useState<{ email: string; why: string; link?: string } | null>(null)

  const invite = async () => {
    setBusy(true)
    setFallback(null)
    try {
      const r = await api<InvitationResult>('POST', `/boards/${boardId}/invitations`, { email: email.trim(), role })
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
    <Section
      title="Invite by email"
      hint="People with an account are added right away (once they’ve confirmed their email); anyone else gets an invite that only works for their address."
    >
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
        <RoleSelect value={role} roles={['editor', 'viewer', 'owner']} onChange={setRole} />
        <Button type="submit" size="sm" className="h-8" disabled={busy}>
          Invite
        </Button>
      </form>
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
    </Section>
  )
}
