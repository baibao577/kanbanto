import { useEffect, useState } from 'react'
import { Buildings } from '@phosphor-icons/react'
import { toast } from 'sonner'
import type { InvitePreview, JoinResult } from '@kanbanto/model/api'
import { backgroundOf, gradientCss } from '@kanbanto/model/colors'
import { api, ApiError, errorMessage } from '@/api/client'
import { hrefFor, navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Button } from '@/components/ui/button'
import { AuthLayout } from './AuthLayout'
import { CheckInboxView } from './EmailViews'

const CAN = { editor: 'add and change tasks', viewer: 'view it' }

/** An invite link: shows which board or workspace it's for, then joins it (after signing in or up, if needed). */
export function JoinView({ token }: { token: string }) {
  const { user, signOut, refresh } = useAuth()
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mustConfirm, setMustConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<InvitePreview>('GET', `/invites/${encodeURIComponent(token)}`).then(setPreview, (e) => setError(errorMessage(e)))
  }, [token])

  const join = async () => {
    setBusy(true)
    try {
      const joined = await api<JoinResult>('POST', '/join', { invite: token })
      // Accepting an invite emailed to you may have just confirmed your address.
      await refresh()
      navigate(joined.kind === 'board' ? { page: 'board', id: joined.boardId } : { page: 'home' }, { replace: true })
      if (joined.kind === 'workspace') toast(`You joined “${preview?.kind === 'workspace' ? preview.workspace.name : 'the workspace'}”`)
    } catch (e) {
      // A share link or code needs your address confirmed first.
      if (e instanceof ApiError && e.code === 'verify-email') setMustConfirm(true)
      else setError(errorMessage(e))
      setBusy(false)
    }
  }

  if (mustConfirm) return <CheckInboxView />
  if (error)
    return (
      <AuthLayout title="This invite doesn’t work" subtitle={error}>
        <a href={hrefFor({ page: 'home' })} className="text-sm font-medium text-primary hover:underline">
          Go to Kanbanto
        </a>
      </AuthLayout>
    )
  if (!preview) return null

  const next = hrefFor({ page: 'join', token })
  const forWorkspace = preview.kind === 'workspace'
  const bg = forWorkspace ? null : backgroundOf(preview.board.background)
  return (
    <AuthLayout
      title={forWorkspace ? `Join “${preview.workspace.name}”` : `Join “${preview.board.name}”`}
      subtitle={
        forWorkspace
          ? 'You’ve been invited to this workspace: you’ll be able to open the boards shared with it.'
          : `You’ve been invited to ${CAN[preview.role]}.`
      }
    >
      <div
        className="mb-5 grid h-16 place-items-center rounded-lg bg-muted text-muted-foreground"
        style={bg ? { background: gradientCss(bg) } : undefined}
        aria-hidden
      >
        {forWorkspace && <Buildings className="size-7" />}
      </div>
      {preview.email && (
        <p className="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          This invite is for <span className="font-medium text-foreground">{preview.email}</span>
          {user ? '.' : ': sign up or sign in with that address.'}
        </p>
      )}
      {!forWorkspace && preview.private ? (
        <p className="text-sm text-muted-foreground">This board is private right now, so it can’t be joined. Ask its owner to share it again.</p>
      ) : user && preview.email && preview.email !== user.email ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            You’re signed in as {user.email}. Sign in with {preview.email} to accept it.
          </p>
          <Button variant="outline" className="w-full" onClick={() => void signOut().then(() => navigate({ page: 'signin', next }))}>
            Switch account
          </Button>
        </div>
      ) : user ? (
        <Button className="w-full" onClick={() => void join()} disabled={busy}>
          {forWorkspace ? 'Join workspace' : 'Join board'}
        </Button>
      ) : (
        <div className="space-y-2">
          <Button className="w-full" onClick={() => navigate({ page: 'signup', next })}>
            Create an account to join
          </Button>
          <Button variant="outline" className="w-full" onClick={() => navigate({ page: 'signin', next })}>
            I have an account
          </Button>
        </div>
      )}
    </AuthLayout>
  )
}
