import { Desktop, Trash } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { PublicUser } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useAuth } from '@/app/use-auth'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useLoaded } from '@/data/useLoaded'
import { currentSubscription, pushPermission, pushSupported, turnOffHere, turnOnHere } from '@/lib/push'

type Device = { id: string; label: string; endpoint: string; createdAt: string; lastUsedAt: string | null }

/**
 * Desktop notifications (Web Push): turned on per computer, no app to install. Reminders, mentions and news from
 * the cards you follow show as
 * notifications there; clicking one opens the card.
 */
export function DesktopNotifications() {
  const { user, setUser } = useAuth()
  const [devices, reload] = useLoaded(useCallback(() => api<{ devices: Device[] }>('GET', '/push/devices').then((r) => r.devices), []))
  const [here, setHere] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void currentSubscription().then((s) => setHere(s?.endpoint ?? null))
  }, [devices])
  if (!user) return null
  const thisDevice = devices?.find((d) => d.endpoint === here)
  const supported = pushSupported()
  const blocked = supported && pushPermission() === 'denied'

  const on = async () => {
    setBusy(true)
    try {
      const r = await turnOnHere()
      if (r === 'denied') toast.error('Your browser blocked notifications for this site. Allow them in its site settings, then try again.')
      else toast('Desktop notifications are on for this computer')
      await reload()
    } catch (e) {
      // The browser's push service said no (private windows, some browser settings, no push service).
      if (e instanceof DOMException && (e.name === 'NotAllowedError' || /permission denied/i.test(e.message)))
        toast.error('Notifications may be off for this browser in your computer’s settings (on a Mac: System Settings → Notifications).', {
          description: e.message,
        })
      else if (e instanceof DOMException && /public key/i.test(e.message))
        // The browser's own push keys (for every site) can't be read: nothing this site can reset.
        toast.error('This browser couldn’t set up its notification keys. Quit and reopen the browser, then try again.', {
          description: e.message,
        })
      else if (e instanceof DOMException)
        toast.error('This browser couldn’t set up notifications here. Quit and reopen the browser, then try again.', {
          description: e.message,
        })
      else toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const setPref = (field: 'pushReminders' | 'pushMentions' | 'pushFollows', value: boolean) =>
    api<{ user: PublicUser }>('PATCH', '/auth/me', { [field]: value }).then(
      (r) => setUser(r.user),
      (e) => toast.error(errorMessage(e)),
    )

  return (
    <SettingsCard
      title="Desktop notifications"
      description="Reminders, mentions and news from the cards you follow pop up on your computer, even when Kanbanto isn’t open (as long as the browser is running). Turn them on for each computer."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Desktop className="size-5 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-sm">
            {!supported
              ? 'This browser can’t show desktop notifications.'
              : thisDevice
                ? `On for this computer (${thisDevice.label}).`
                : blocked
                  ? 'Blocked in this browser’s settings for this site.'
                  : 'Off for this computer.'}
          </span>
          {supported && !thisDevice && (
            <Button size="sm" disabled={busy || blocked} onClick={() => void on()}>
              Turn on for this computer
            </Button>
          )}
          {thisDevice && (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const r = await api<{ sent: number }>('POST', '/push/test').catch((e) => (toast.error(errorMessage(e)), null))
                if (r) toast(r.sent ? 'Sent: it should pop up in a moment' : 'Nothing was sent: try turning it off and on')
              }}
            >
              Send a test
            </Button>
          )}
        </div>

        <div className="space-y-2 border-t pt-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            Reminders
            <Switch
              checked={user.pushReminders}
              onCheckedChange={(v) => void setPref('pushReminders', v)}
              aria-label="Desktop notifications for reminders"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            When I’m @mentioned
            <Switch
              checked={user.pushMentions}
              onCheckedChange={(v) => void setPref('pushMentions', v)}
              aria-label="Desktop notifications for mentions"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            Comments and changes on cards I follow
            <Switch
              checked={user.pushFollows}
              onCheckedChange={(v) => void setPref('pushFollows', v)}
              aria-label="Desktop notifications for cards I follow"
            />
          </label>
        </div>

        {!!devices?.length && (
          <div className="border-t pt-3">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">On for</p>
            <ul className="space-y-1">
              {devices.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {d.label}
                    {d.endpoint === here && <span className="text-muted-foreground"> · this computer</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    added {formatDistanceToNow(parseISO(d.createdAt), { addSuffix: true })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    aria-label={`Turn off for ${d.label}`}
                    onClick={async () => {
                      try {
                        if (d.endpoint === here) await turnOffHere(d.id)
                        else await api('DELETE', `/push/devices/${d.id}`)
                        await reload()
                      } catch (e) {
                        toast.error(errorMessage(e))
                      }
                    }}
                  >
                    <Trash />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
