import { EnvelopeSimple } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { PublicUser } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthLayout } from './AuthLayout'

/** Shown instead of the app until you confirm your email. */
export function CheckInboxView() {
  const { user, signOut, refresh } = useAuth()
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const resend = async () => {
    setBusy(true)
    try {
      await api('POST', '/auth/verify/send')
      setNote('Sent. It can take a minute to arrive; check your spam folder too.')
    } catch (e) {
      setNote(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Check your inbox" subtitle={`We sent a link to ${user?.email}. Click it to confirm it’s your email and start using the app.`}>
      <div className="mb-5 grid place-items-center">
        <div className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
          <EnvelopeSimple className="size-6" />
        </div>
      </div>
      <div className="space-y-2">
        <Button className="w-full" variant="outline" onClick={() => void refresh()}>
          I’ve confirmed it
        </Button>
        <Button className="w-full" variant="ghost" onClick={() => void resend()} disabled={busy}>
          Send the link again
        </Button>
      </div>
      {note && <p className="mt-3 text-center text-sm text-muted-foreground">{note}</p>}
      <p className="mt-5 text-center text-sm text-muted-foreground">
        Wrong address?{' '}
        <button
          className="font-medium text-primary hover:underline"
          onClick={() => void signOut().then(() => navigate({ page: 'signup' }, { replace: true }))}
        >
          Sign out and start again
        </button>
      </p>
    </AuthLayout>
  )
}

/**
 * After signing up (when the site sends email): the account waits for its address to be confirmed. The link in the
 * email signs you in; if it's opened in this browser, this page notices and goes on to the app.
 */
export function SentLinkView({ email }: { email: string }) {
  const { user, refresh } = useAuth()
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (user) navigate({ page: 'home' }, { replace: true })
  }, [user])

  const resend = async () => {
    setBusy(true)
    try {
      await api('POST', '/auth/verify/resend', { email })
      setNote('If the link hasn’t arrived, another one is on its way. Check your spam folder too.')
    } catch (e) {
      setNote(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Check your inbox" subtitle={`We sent a link to ${email}. Click it to confirm your address and sign in.`}>
      <div className="mb-5 grid place-items-center">
        <div className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
          <EnvelopeSimple className="size-6" />
        </div>
      </div>
      <div className="space-y-2">
        <Button className="w-full" variant="outline" onClick={() => void refresh()}>
          I’ve clicked the link
        </Button>
        <Button className="w-full" variant="ghost" onClick={() => void resend()} disabled={busy}>
          Send the link again
        </Button>
      </div>
      {note && <p className="mt-3 text-center text-sm text-muted-foreground">{note}</p>}
      <p className="mt-5 text-center text-sm text-muted-foreground">
        Already confirmed?{' '}
        <a href={hrefFor({ page: 'signin' })} className="font-medium text-primary hover:underline">
          Sign in
        </a>
      </p>
    </AuthLayout>
  )
}

/** The link from the "confirm your email" message: confirms the address and signs you in. */
export function VerifyView({ token }: { token: string }) {
  const { user, setUser } = useAuth()
  const [state, setState] = useState<'working' | 'done' | string>('working')
  const once = useRef(false)

  useEffect(() => {
    // Links are single-use: make sure a re-render (or StrictMode) doesn't spend it twice.
    if (once.current) return
    once.current = true
    api<{ user: PublicUser | null }>('POST', '/auth/verify', { token }).then(
      (r) => {
        if (r.user) setUser(r.user)
        setState('done')
      },
      (e) => setState(errorMessage(e)),
    )
  }, [token, setUser])

  if (state === 'working') return null
  if (state === 'done')
    return (
      <AuthLayout title="Email confirmed" subtitle="Thanks! Your account is ready.">
        <Button className="w-full" onClick={() => navigate(user ? { page: 'home' } : { page: 'signin' }, { replace: true })}>
          {user ? 'Go to your boards' : 'Sign in'}
        </Button>
      </AuthLayout>
    )
  return (
    <AuthLayout title="This link doesn’t work" subtitle={state}>
      <a href={hrefFor(user ? { page: 'home' } : { page: 'signin' })} className="text-sm font-medium text-primary hover:underline">
        {user ? 'Get a new link' : 'Sign in'}
      </a>
    </AuthLayout>
  )
}

/** "Forgot your password?": asks for the email and sends a reset link. */
export function ForgotView() {
  const { emailEnabled } = useAuth()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!emailEnabled)
    return (
      <AuthLayout title="Reset your password" subtitle="This site can’t send email yet, so ask an admin to reset your password for you.">
        <a href={hrefFor({ page: 'signin' })} className="text-sm font-medium text-primary hover:underline">
          Back to sign in
        </a>
      </AuthLayout>
    )
  if (sent)
    return (
      <AuthLayout
        title="Check your inbox"
        subtitle={`If ${email} has an account, we’ve sent it a link to choose a new password. The link works for 1 hour.`}
      >
        <a href={hrefFor({ page: 'signin' })} className="text-sm font-medium text-primary hover:underline">
          Back to sign in
        </a>
      </AuthLayout>
    )
  return (
    <AuthLayout title="Reset your password" subtitle="Enter your email and we’ll send you a link to choose a new password.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await api('POST', '/auth/forgot', { email })
            setSent(true)
          } catch (err) {
            setError(errorMessage(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="forgot-email">Email</Label>
          <Input id="forgot-email" type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          Send reset link
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        <a href={hrefFor({ page: 'signin' })} className="font-medium text-primary hover:underline">
          Back to sign in
        </a>
      </p>
    </AuthLayout>
  )
}

/** The link from the reset email: choose a new password (then you're signed in). */
export function ResetView({ token }: { token: string }) {
  const { setUser } = useAuth()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <AuthLayout title="Choose a new password" subtitle="You’ll be signed out everywhere else.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const { user } = await api<{ user: PublicUser }>('POST', '/auth/reset', { token, password })
            setUser(user)
            navigate({ page: 'home' }, { replace: true })
          } catch (err) {
            setError(errorMessage(err))
            setBusy(false)
          }
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="reset-password">New password</Label>
          <Input
            id="reset-password"
            type="password"
            autoFocus
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">At least 8 characters.</p>
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}{' '}
            <a href={hrefFor({ page: 'forgot' })} className="font-medium underline">
              Ask for a new link
            </a>
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          Save and sign in
        </Button>
      </form>
    </AuthLayout>
  )
}
