import { useCallback } from 'react'
import { toast } from 'sonner'
import type { PublicUser } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useAuth } from '@/app/use-auth'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { Switch } from '@/components/ui/switch'
import { useLoaded } from '@/data/useLoaded'

interface Mine {
  allowed: boolean
  /** The bots you connected to your own chat, the one that's used by default first. */
  bots: { bot: string; board: string; inbox: boolean }[]
}

/**
 * Your own news on Telegram: reminders, mentions and (if you ask) news from the cards you follow, through a bot you
 * connected to your own chat with it, on any board. Shown where Telegram bots are allowed on the site, or you have one.
 */
export function TelegramNews() {
  const { user, setUser } = useAuth()
  const [mine] = useLoaded(useCallback(() => api<Mine>('GET', '/account/telegram'), []))
  if (!user || !mine || (!mine.allowed && !mine.bots.length)) return null
  const setPref = (field: 'telegramReminders' | 'telegramMentions' | 'telegramFollows', value: boolean) =>
    api<{ user: PublicUser }>('PATCH', '/auth/me', { [field]: value }).then(
      (r) => setUser(r.user),
      (e) => toast.error(errorMessage(e)),
    )
  const where = (b: Mine['bots'][number]) => `@${b.bot} (on ${b.inbox ? 'your Inbox' : `“${b.board}”`})`
  return (
    <SettingsCard title="Telegram" description="The same news in Telegram, as things happen, through a bot you connected to your own chat with it.">
      {mine.bots.length ? (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Through {where(mine.bots[0])}.
            {mine.bots.length > 1 &&
              ` You have ${mine.bots.length} bots of your own: news about a card comes through the bot on that card’s board when it has one (${mine.bots
                .slice(1)
                .map(where)
                .join(', ')}).`}
          </p>
          <label className="flex items-center justify-between gap-3 text-sm">
            Reminders
            <Switch
              checked={user.telegramReminders}
              onCheckedChange={(v) => void setPref('telegramReminders', v)}
              aria-label="Telegram for reminders"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            When I’m @mentioned
            <Switch checked={user.telegramMentions} onCheckedChange={(v) => void setPref('telegramMentions', v)} aria-label="Telegram for mentions" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            Comments and changes on cards I follow
            <Switch
              checked={user.telegramFollows}
              onCheckedChange={(v) => void setPref('telegramFollows', v)}
              aria-label="Telegram for cards I follow"
            />
          </label>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          You have no Telegram bot connected to your own chat yet. Add one to a board of yours, or to your Inbox (Board settings → People & apps →
          Telegram), and connect it with “My own chat with the bot”. It then tells you your reminders and mentions, from every board.
        </p>
      )}
    </SettingsCard>
  )
}
