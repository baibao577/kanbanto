import { useState } from 'react'
import { hrefFor, navigate, parseRoute } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { api, errorMessage } from '@/api/client'
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

/** Why signing in with Google didn't work (Google sends people back with ?problem=…, see the server's routes/google-auth.ts). */
const GOOGLE_PROBLEMS: Record<string, string> = {
  expired: 'That took too long, or was started in another browser. Try again.',
  unverified: 'Google hasn’t confirmed that email address yet. Confirm it with Google, or use your email and password here.',
  password: 'That email address already has an account here, and Google can’t vouch that it’s yours. Sign in with your password.',
  disabled: 'This account has been turned off. Ask your admin.',
  closed: 'No account uses that Google address, and sign-up is closed on this site. Ask a board owner for an invite link.',
  invite: 'That invite doesn’t work for this Google address. Ask for a new link.',
  off: 'Signing in with Google isn’t turned on for this site.',
  setup: 'Google doesn’t accept this site’s Google app. Tell the people who run this site.',
  failed: 'Signing in with Google didn’t work. Try again.',
}

/** Google's "G", in its own colours, as its sign-in button has to show it. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className="size-[18px]">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

/** Sign in, or create an account. `problem`: why coming back from Google didn't sign them in. */
export function AuthView({ mode, next, problem }: { mode: Mode; next?: string; problem?: string }) {
  const { signIn, signUp, openSignup, googleSignIn } = useAuth()
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

  /** Off to Google; it sends them back signed in (or to this page, with why not). */
  const withGoogle = async () => {
    setBusy(true)
    setError(null)
    try {
      location.href = (await api<{ url: string }>('POST', '/auth/google/start', { next, invite })).url
    } catch (e) {
      setBusy(false)
      setError(errorMessage(e))
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
      {googleSignIn && (
        <div className="mb-4 space-y-4">
          {problem && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {GOOGLE_PROBLEMS[problem] ?? GOOGLE_PROBLEMS.failed}
            </p>
          )}
          {/* Google's own colours for its button, in light and dark, rather than the theme's. */}
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2.5 border-[#747775] bg-white text-[#1f1f1f] shadow-none hover:bg-[#f2f2f2] hover:text-[#1f1f1f] dark:border-[#8e918f] dark:bg-[#131314] dark:text-[#e3e3e3] dark:hover:bg-[#28292a] dark:hover:text-[#e3e3e3]"
            disabled={busy}
            onClick={() => void withGoogle()}
          >
            <GoogleMark /> Continue with Google
          </Button>
          <div className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            or
          </div>
        </div>
      )}
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
