import { useState } from 'react'
import { hrefFor, navigate, parseRoute } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthLayout } from './AuthLayout'
import { SentLinkView } from './EmailViews'

type Mode = 'signin' | 'signup'

/** The invite in a `next` that points at a share link (#/join/<token>), so signing up can join it at once. */
const inviteIn = (next?: string) => {
  const r = next ? parseRoute(next) : null
  return r?.page === 'join' ? r.token : undefined
}

/** Sign in, or create an account. */
export function AuthView({ mode, next }: { mode: Mode; next?: string }) {
  const { signIn, signUp, openSignup } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const invite = inviteIn(next)
  const signingUp = mode === 'signup'
  const closed = mode === 'signup' && !openSignup && !invite

  const done = (boardId?: string | null) => {
    if (boardId) navigate({ page: 'board', id: boardId }, { replace: true })
    else navigate(next?.startsWith('#/') ? parseRoute(next) : { page: 'home' }, { replace: true })
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      if (signingUp) {
        const r = await signUp({ name, email, password, invite })
        if ('checkEmail' in r) setSentTo(email.trim())
        else done(r.boardId)
      } else {
        await signIn(email, password)
        done()
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const other = (page: 'signin' | 'signup') => hrefFor({ page, next })

  const title = signingUp ? 'Create your account' : 'Sign in'
  const subtitle = invite ? 'You’ve been invited to a board. Sign in or create an account to join it.' : undefined

  if (sentTo) return <SentLinkView email={sentTo} />
  if (closed)
    return (
      <AuthLayout title="Sign-up is closed" subtitle="To get an account here, ask someone who uses Kanbanto to share a board with you.">
        <a href={other('signin')} className="text-sm font-medium text-primary hover:underline">
          I already have an account
        </a>
      </AuthLayout>
    )

  return (
    <AuthLayout title={title} subtitle={subtitle}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {signingUp && (
          <div className="space-y-1.5">
            <Label htmlFor="auth-name">Your name</Label>
            <Input id="auth-name" autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="auth-email">Email</Label>
          <Input
            id="auth-email"
            type="email"
            autoFocus={!signingUp}
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="auth-password">Password</Label>
            {!signingUp && (
              <a href={hrefFor({ page: 'forgot' })} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
                Forgot password?
              </a>
            )}
          </div>
          <Input
            id="auth-password"
            type="password"
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            minLength={signingUp ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {signingUp && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {signingUp ? 'Create account' : 'Sign in'}
        </Button>
      </form>
      {
        <p className="mt-5 text-center text-sm text-muted-foreground">
          {signingUp ? (
            <>
              Already have an account?{' '}
              <a href={other('signin')} className="font-medium text-primary hover:underline">
                Sign in
              </a>
            </>
          ) : (
            <>
              New here?{' '}
              <a href={other('signup')} className="font-medium text-primary hover:underline">
                Create an account
              </a>
            </>
          )}
        </p>
      }
    </AuthLayout>
  )
}
