import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt, ne } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import { apiTokens, calendarFeeds, emailTokens, oauthCodes, oauthGrants, pushDevices, sessions, users } from '../db/schema'
import { pictureUrl } from '../pictures'

export const SESSION_COOKIE = 'kankan_session'
const DAY = 24 * 60 * 60 * 1000
/** Sessions last 30 days, and are extended when used in their second half. */
export const SESSION_DAYS = 30

export interface SessionUser {
  id: string
  email: string
  name: string
  /** Where their profile picture is (null: none). */
  picture: string | null
  isAdmin: boolean
  emailVerified: boolean
  /** Has a password to sign in with (someone who only ever signed in with Google has none). */
  hasPassword: boolean
  /** Wants the daily email summary of @mentions. */
  mentionEmails: boolean
  /** Wants reminders by email too. */
  reminderEmails: boolean
  /** IANA time zone, or null when not known yet. */
  timeZone: string | null
  /** Desktop notifications for reminders, and for @mentions (where they're turned on). */
  pushReminders: boolean
  pushMentions: boolean
  pushFollows: boolean
  /** The same news through a Telegram bot they connected to their own chat, when they have one. */
  telegramReminders: boolean
  telegramMentions: boolean
  telegramFollows: boolean
  /** Has to confirm their email before using the app (set per request: only once the site can send email). */
  mustVerify?: boolean
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Starts a session. Returns the token for the cookie (only its hash is stored). */
export async function createSession(db: Db, userId: string) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY)
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt })
  return { token, expiresAt }
}

/** The signed-in user for a cookie token, or null (expired, signed out, or the account is disabled). */
export async function userForToken(db: Db, token: string): Promise<SessionUser | null> {
  const id = hashToken(token)
  const [row] = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()), isNull(users.disabledAt)))
  if (!row) return null
  if (row.expiresAt.getTime() - Date.now() < (SESSION_DAYS / 2) * DAY)
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_DAYS * DAY) })
      .where(eq(sessions.id, id))
  return sessionUser(row.user)
}

/** The signed-in person, from their row. */
export const sessionUser = (u: typeof users.$inferSelect): SessionUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  picture: pictureUrl(u.picture),
  isAdmin: u.isAdmin,
  emailVerified: !!u.emailVerifiedAt,
  hasPassword: u.passwordHash !== null,
  mentionEmails: u.mentionEmails,
  reminderEmails: u.reminderEmails,
  timeZone: u.timeZone,
  pushReminders: u.pushReminders,
  pushMentions: u.pushMentions,
  pushFollows: u.pushFollows,
  telegramReminders: u.telegramReminders,
  telegramMentions: u.telegramMentions,
  telegramFollows: u.telegramFollows,
})

export async function endSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)))
}

/**
 * Signs a user out everywhere (password changed or reset, account disabled): all of their sessions in one step, so
 * however many there are, none is left for a moment after the others. Given the transaction that changes the
 * account, it is part of that change.
 */
export async function endAllSessions(db: Db | Tx, userId: string, exceptToken?: string) {
  const theirs = eq(sessions.userId, userId)
  await db.delete(sessions).where(exceptToken ? and(theirs, ne(sessions.id, hashToken(exceptToken))) : theirs)
}

/** Whether a session is still there (in the transaction that is about to act on its word). */
export async function sessionStands(db: Db | Tx, token: string): Promise<boolean> {
  const [s] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
  return !!s
}

/**
 * An account changes hands, or is closed: everything that acts as it stops. Its sessions, the links emailed to it,
 * the browsers it sends desktop notifications to, its API tokens, the apps connected to it and its calendar link.
 * Done in the transaction that changes the account (`tx`), so there is no moment between the two in which
 * something of whoever had it before can still act as it: set a password, make a token.
 */
export async function endWhatActsAs(tx: Db | Tx, userId: string) {
  await endAllSessions(tx, userId)
  await tx
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailTokens.userId, userId), isNull(emailTokens.usedAt)))
  await tx.delete(pushDevices).where(eq(pushDevices.userId, userId))
  await tx.delete(apiTokens).where(eq(apiTokens.userId, userId))
  await tx.delete(oauthGrants).where(eq(oauthGrants.userId, userId))
  await tx.delete(oauthCodes).where(eq(oauthCodes.userId, userId))
  await tx.delete(calendarFeeds).where(eq(calendarFeeds.userId, userId))
}

export async function deleteExpiredSessions(db: Db) {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
}
