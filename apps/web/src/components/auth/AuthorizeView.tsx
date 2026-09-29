import { PlugsConnected } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { OAuthRequestView } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { AuthLayout } from './AuthLayout'

/**
 * Approving an app that connects with sign-in (OAuth), like Claude: which app, where it sends you back to, and what it
 * may do. Allowing sends you back to the app with a one-time code; cancelling tells the app you said no.
 */
export function AuthorizeView({ query }: { query: string }) {
  const { user, signOut } = useAuth()
  const [request, setRequest] = useState<OAuthRequestView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<'read' | 'write'>('write')
  const [busy, setBusy] = useState(false)
  const params = Object.fromEntries(new URLSearchParams(query))

  useEffect(() => {
    api<OAuthRequestView>('GET', `/oauth/request?${query}`).then(
      (r) => {
        setRequest(r)
        setChoice(r.maxScope)
      },
      (e) => setError(errorMessage(e)),
    )
  }, [query])

  const decide = async (allow: boolean) => {
    setBusy(true)
    try {
      const { redirect } = await api<{ redirect: string }>('POST', allow ? '/oauth/approve' : '/oauth/deny', allow ? { ...params, choice } : params)
      location.href = redirect
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  if (error)
    return (
      <AuthLayout title="This app can’t connect" subtitle={error}>
        <a href={hrefFor({ page: 'home' })} className="text-sm font-medium text-primary hover:underline">
          Go to your boards
        </a>
      </AuthLayout>
    )
  if (!request) return null

  return (
    <AuthLayout title={`Connect “${request.app}” to Kanbanto?`} subtitle="It will act as you, on the boards you can open.">
      <div className="space-y-5">
        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
          <PlugsConnected className="size-5 shrink-0 text-muted-foreground" />
          <p>
            You’ll be sent back to <span className="font-semibold">{request.sendsBackTo}</span>. Only continue if that’s where you started.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">It may</p>
          {request.maxScope === 'write' ? (
            <RadioGroup value={choice} onValueChange={(v) => setChoice(v as 'read' | 'write')} className="gap-2">
              <Choice value="write" title="Read and make changes" hint="Find, add and update tasks, and comment, as you." />
              <Choice value="read" title="Only read" hint="See your boards and tasks. It can’t change anything." />
            </RadioGroup>
          ) : (
            <p className="text-sm text-muted-foreground">Only read: see your boards and tasks, without changing anything.</p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Signed in as {user?.email}.{' '}
          <button
            className="font-medium text-primary hover:underline"
            onClick={() => void signOut().then(() => navigate({ page: 'signin', next: hrefFor({ page: 'authorize', query }) }))}
          >
            Not you?
          </button>{' '}
          You can disconnect it any time in Account settings → API & apps.
        </p>

        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => void decide(true)} disabled={busy}>
            Allow
          </Button>
          <Button variant="outline" className="flex-1" onClick={() => void decide(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </AuthLayout>
  )
}

function Choice({ value, title, hint }: { value: string; title: string; hint: string }) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}
