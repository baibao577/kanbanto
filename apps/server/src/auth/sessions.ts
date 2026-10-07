import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import type { Db } from '../db'
import { sessions, users } from '../db/schema'
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

/** Signs a user out everywhere (password changed or reset, account disabled). */
export async function endAllSessions(db: Db, userId: string, exceptToken?: string) {
  const keep = exceptToken ? hashToken(exceptToken) : null
  const all = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))
  for (const s of all) if (s.id !== keep) await db.delete(sessions).where(eq(sessions.id, s.id))
}

export async function deleteExpiredSessions(db: Db) {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
}
