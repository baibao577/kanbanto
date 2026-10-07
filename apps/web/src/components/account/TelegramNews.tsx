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
  /** The bots you connected to your own chat, each with the board it's on (and tells you about). */
  bots: { bot: string; board: string; inbox: boolean }[]
}

/**
 * Your own news on Telegram: reminders, mentions and (if you ask) news from the cards you follow, through a bot you
 * connected to your own chat with it, each bot for the board it's on. Shown where Telegram bots are allowed on the
 * site, or you have one.
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
  const joined = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)
  return (
    <SettingsCard title="Telegram" description="The same news in Telegram, as things happen, through a bot you connected to your own chat with it.">
      {mine.bots.length ? (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Through {joined(mine.bots.map(where))}.{' '}
            {mine.bots.length > 1 ? 'Each tells you about cards on its own board.' : 'It tells you about cards on that board.'} A board without a bot
            of yours sends nothing to Telegram.
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
          Telegram), and connect it with “My own chat with the bot”. It then tells you your reminders and mentions on that board.
        </p>
      )}
    </SettingsCard>
  )
}
