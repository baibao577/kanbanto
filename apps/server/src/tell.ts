import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { users } from './db/schema'
import { env } from './env'

/** A kind of news a person can be told as it happens. */
export type NewsKind = 'reminders' | 'mentions' | 'follows'

/**
 * Tells someone a piece of their own news as it happens, wherever they asked for it: a desktop notification (in
 * the browsers where they turned those on), and Telegram, through a bot they connected to their own chat (the one
 * on the card's board, else the one on their Inbox, else another of theirs). Each has its own switch per kind of
 * news. `url`: the card's address on this site, from the "/" on.
 *
 * `about`: the board the card is on, and (`covered`) the board's own news of the same thing, when there's no way to
 * keep that from the same chat: then a bot on that board that already sends it isn't asked to say it twice.
 *
 * Returns the webhook of the bot it was told through, for the caller to leave out of the board's news of it.
 */
export async function tellPerson(
  app: FastifyInstance,
  userId: string,
  kind: NewsKind,
  message: { title: string; body: string; url: string; tag: string },
  ttl: number,
  about: { boardId?: string; covered?: string } = {},
): Promise<string | null> {
  const [u] = await app.db
    .select({
      push: { reminders: users.pushReminders, mentions: users.pushMentions, follows: users.pushFollows },
      telegram: { reminders: users.telegramReminders, mentions: users.telegramMentions, follows: users.telegramFollows },
    })
    .from(users)
    .where(eq(users.id, userId))
  if (!u) return null
  if (u.push[kind]) await app.push.toUser(userId, message, ttl)
  if (!u.telegram[kind]) return null
  const site = app.mail.siteUrl ?? env.appUrl ?? null
  // (Telling them on Telegram never gets in the way of the rest: a bot that can't be reached is its own problem.)
  return app.telegram.toPerson(userId, { title: message.title, body: message.body, url: site ? `${site}${message.url}` : null }, about).catch((e) => {
    app.log.warn({ err: e instanceof Error ? e.message : e }, 'telegram')
    return null
  })
}
