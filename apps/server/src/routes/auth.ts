import { newId } from '@kanbanto/model/ids'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { JoinResult } from '@kanbanto/model/api'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { createEmailToken, endEmailTokens, lastEmailToken, peekEmailToken, useEmailToken } from '../auth/email-tokens'
import { hashPassword, verifyPassword } from '../auth/password'
import { createSession, endAllSessions, endSession, SESSION_COOKIE, sessionUser, type SessionUser } from '../auth/sessions'
import { acceptInvite, checkInviteFor, findAnyInvite, provesEmail } from '../boards/invites'
import { createBoard } from '../boards/service'
import { googleApp } from '../calendar/sync'
import type { Db, Tx } from '../db'
import { emailOutbox, users } from '../db/schema'
import { env } from '../env'
import { HttpError, parse, siteUrl } from '../http'
import { loggable } from '../errors'
import { emails } from '../mail/templates'
import { loadSettings as getSettings } from '../settings'
import { VERSION } from '../version'
import { announceSharingChange, announceWorkspaceChange, changePerson } from '../boards/announce'

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address.' }))
const password = z.string().min(8, 'Use at least 8 characters for your password.').max(200)
const name = z
  .string()
  .trim()
  .min(1, 'Enter your name.')
  .max(100)
  // oxlint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'Names can’t contain line breaks or other control characters.')
const token = z.string().min(10).max(200)

const SignUp = z.object({ name, email, password, invite: z.string().max(200).optional() })
const SignIn = z.object({ email, password: z.string().min(1, 'Enter your password.').max(200) })
const ChangePassword = z.object({ current: z.string().max(200).optional(), next: password, pushEndpoint: z.string().max(2000).optional() })

/** A time zone name the server can use (IANA, e.g. Asia/Bangkok). */
const validZone = (tz: string | null) => {
  if (tz === null) return true
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const publicUser = (u: SessionUser) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  picture: u.picture,
  isAdmin: u.isAdmin,
  emailVerified: u.emailVerified,
  hasPassword: u.hasPassword,
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

export { loadSettings as getSettings } from '../settings'

// Sign-in attempts per address, per minute: slows down password guessing.
export const LIMIT = { config: { rateLimit: { max: env.test ? 1000 : 10, timeWindow: '1 minute' } } }
/** How often someone can ask for another confirmation or reset email. */
const RESEND_AFTER_MS = 60_000

/**
 * Failed sign-ins per email address, whatever address they come from: after 10 in 15 minutes, that address has to
 * wait. Counted for unknown addresses too, so it doesn't tell which ones have accounts. Kept in memory (one server).
 */
const failures = new Map<string, { n: number; since: number }>()
const FAIL_LIMIT = 10
const FAIL_WINDOW_MS = 15 * 60_000
function tooManyFailures(email: string) {
  const f = failures.get(email)
  if (f && Date.now() - f.since > FAIL_WINDOW_MS) failures.delete(email)
  return (failures.get(email)?.n ?? 0) >= FAIL_LIMIT
}
/** Forgets every count (tests start each case clean). */
export const forgetSignInFailures = () => failures.clear()
function recordFailure(email: string) {
  const f = failures.get(email)
  if (f && Date.now() - f.since <= FAIL_WINDOW_MS) f.n++
  else {
    failures.delete(email)
    failures.set(email, { n: 1, since: Date.now() })
  }
  if (failures.size > 10_000) failures.delete(failures.keys().next().value!)
}

/** Sends the "confirm your email" link. */
export async function sendVerification(app: FastifyInstance, req: FastifyRequest, user: { id: string; name: string; email: string }) {
  const t = await createEmailToken(app.db, user.id, 'verify', user.email)
  const url = `${siteUrl(req)}/#/verify/${t}`
  return app.mail.queue({
    kind: 'verify',
    to: user.email,
    requestedBy: user.id,
    content: (brand) => emails.verify(brand, { name: user.name, email: user.email, url }),
  })
}

/** Tells someone that a sign-up used their address, which already has an account (at most once an hour). */
async function accountExistsNotice(app: FastifyInstance, req: FastifyRequest, user: { name: string; email: string }) {
  const [recent] = await app.db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.kind, 'notice'), eq(emailOutbox.toAddress, user.email), gte(emailOutbox.createdAt, new Date(Date.now() - 3600_000))))
    .limit(1)
  if (recent) return
  const site = siteUrl(req)
  await app.mail.queue({
    kind: 'notice',
    to: user.email,
    requestedBy: null,
    content: (brand) => emails.notice(brand, { name: user.name, what: 'account-exists', site }),
  })
}

// Secure (HTTPS-only) whenever the request came over HTTPS — including behind a host's proxy — so a local
// production container on http://localhost still works.
export const setSessionCookie = (reply: FastifyReply, token: string, expires: Date) =>
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: reply.request.protocol === 'https', expires })

/**
 * The invite someone signing up arrived with, or null without one. Refused: signing up without one while sign-up is
 * closed (or, with the form, while new accounts are only made with Google), and an invite that `email` can't use,
 * whether or not the address has an account (so the answer doesn't tell).
 */
export async function inviteForSignUp(tx: Tx, token: string | undefined, email: string, via: 'form' | 'google') {
  const invite = token ? await findAnyInvite(tx, token) : null
  if (!invite) {
    const { openSignup, signupGoogleOnly } = await getSettings(tx)
    if (!openSignup) throw new HttpError(403, 'Sign-up is closed. Ask a board owner for an invite link.')
    if (signupGoogleOnly && via === 'form')
      throw new HttpError(403, 'New accounts here are made with Google: use “Continue with Google”, or ask a board owner for an invite link.')
  }
  if (token) checkInviteFor(invite, email)
  return invite
}

/**
 * Makes an account, and joins what its invite is for. `passwordHash` null: they signed up with Google. Signing up
 * never makes anyone a platform admin: that's granted on the server (see src/cli.ts).
 */
export async function insertAccount(
  tx: Tx,
  fields: { email: string; name: string; passwordHash: string | null; googleSub?: string; verified: boolean; invite?: string },
) {
  const [row] = await tx
    .insert(users)
    .values({
      id: newId(),
      email: fields.email,
      name: fields.name,
      passwordHash: fields.passwordHash,
      googleSub: fields.googleSub ?? null,
      emailVerifiedAt: fields.verified ? new Date() : null,
    })
    .returning()
  const user = sessionUser(row)
  const joined = fields.invite ? await acceptInvite(tx, { id: user.id, email: user.email }, fields.invite) : null
  return { user, joined }
}

/** Everyone starts with the example board, except people who came to join someone else's board or workspace. */
export async function setUpAccount(app: FastifyInstance, userId: string, joined: JoinResult | null) {
  if (joined?.kind === 'board') await announceSharingChange(app, joined.boardId)
  else if (joined) await announceWorkspaceChange(app, joined.workspaceId)
  else await createBoard(app.db, userId, { name: 'My first board', template: 'example' })
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req) => {
    const settings = await getSettings(app.db)
    const googleSignIn = settings.googleSignIn && !!(await googleApp(app.db))
    return {
      user: req.user ? publicUser(req.user) : null,
      // (Only with Google, on a site that doesn't offer it: nobody can sign up without an invite.)
      openSignup: settings.openSignup && (!settings.signupGoogleOnly || googleSignIn),
      signupGoogleOnly: settings.openSignup && settings.signupGoogleOnly && googleSignIn,
      /** The site can send email (so password reset works, and new accounts confirm their email). */
      emailEnabled: app.mail.platformReady,
      googleSignIn,
      links: app.siteLinks,
      guidesUrl: app.guidesUrl,
      // (For people who are signed in: a visitor isn't told which release a site runs.)
      version: req.user ? VERSION : null,
    }
  })

  /**
   * Creates an account. Once the site sends email, the answer is the same whether or not the address already has
   * an account ("check your inbox"), so sign-up can't be used to find out who has one: a new account gets a
   * confirmation link (which also signs them in); an existing one gets a note saying it exists. Without email, or
   * when arriving through an invite emailed to this address, you're signed in straight away.
   */
  app.post('/signup', LIMIT, async (req, reply) => {
    const body = parse(SignUp, req.body)
    // Hashed whether or not the account gets made, so both answers take about as long.
    const passwordHash = await hashPassword(body.password)
    const result = await app.db.transaction(async (tx) => {
      const invite = await inviteForSignUp(tx, body.invite, body.email, 'form')
      const [taken] = await tx.select().from(users).where(eq(users.email, body.email))
      if (taken) {
        if (!app.mail.platformReady) throw new HttpError(409, 'There’s already an account with that email. Sign in instead.')
        return { kind: 'existing' as const, name: taken.name, email: taken.email, disabled: !!taken.disabledAt }
      }
      // Arriving through an invite emailed to this address proves the address is theirs — unless the inviter was
      // shown the link (the email couldn't be sent), since then the inviter could be the one using it.
      const verified = provesEmail(invite, body.email)
      return {
        kind: 'created' as const,
        ...(await insertAccount(tx, { email: body.email, name: body.name, passwordHash, verified, invite: body.invite })),
      }
    })
    if (result.kind === 'existing') {
      if (!result.disabled) await accountExistsNotice(app, req, result)
      return { checkEmail: true }
    }
    const { user, joined } = result
    if (!user.emailVerified && app.mail.platformReady) {
      await sendVerification(app, req, user)
      // Not needed until they've confirmed, so it doesn't hold up (or give away) this answer.
      void setUpAccount(app, user.id, joined).catch((e) => req.log.error({ err: loggable(e) }, 'setting up a new account'))
      return { checkEmail: true }
    }
    await setUpAccount(app, user.id, joined)
    const session = await createSession(app.db, user.id)
    setSessionCookie(reply, session.token, session.expiresAt)
    return { user: publicUser(user), boardId: joined?.kind === 'board' ? joined.boardId : null }
  })

  app.post('/signin', LIMIT, async (req, reply) => {
    const body = parse(SignIn, req.body)
    if (tooManyFailures(body.email)) throw new HttpError(429, 'Too many wrong passwords for this email. Wait 15 minutes, or reset your password.')
    // Counted before the password is checked (and forgotten if it's right), so tries made all at once count too.
    recordFailure(body.email)
    const [u] = await app.db.select().from(users).where(eq(users.email, body.email))
    // Same answer for an unknown email, a wrong password and an account without one, so accounts can't be discovered.
    const ok = await verifyPassword(body.password, u?.passwordHash ?? null)
    if (!u || !ok) throw new HttpError(401, 'Wrong email or password.')
    failures.delete(body.email)
    if (u.disabledAt) throw new HttpError(403, 'This account has been turned off. Ask your admin.')
    // (Checking a password takes a moment: if it was changed meanwhile, this sign-in is with the old one.)
    const [still] = await app.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, u.id))
    if (still?.hash !== u.passwordHash) throw new HttpError(401, 'Wrong email or password.')
    const session = await createSession(app.db, u.id)
    setSessionCookie(reply, session.token, session.expiresAt)
    return { user: publicUser(sessionUser(u)) }
  })

  /** Signing out also stops this browser's desktop notifications (it says which browser it is). */
  app.post('/signout', async (req, reply) => {
    if (req.sessionToken) {
      const { pushEndpoint } = parse(z.object({ pushEndpoint: z.string().max(2000).optional() }), req.body ?? {})
      if (req.user && pushEndpoint) await app.push.forget(req.user.id, { only: pushEndpoint })
      await endSession(app.db, req.sessionToken)
      app.hub.endSession(req.sessionToken)
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  /** Your name, and what you're told about by email and on your desktop. */
  app.patch('/me', async (req) => {
    const user = requireUser(req.user, { allowUnverified: true })
    const body = parse(
      z
        .object({
          name,
          mentionEmails: z.boolean(),
          reminderEmails: z.boolean(),
          pushReminders: z.boolean(),
          pushMentions: z.boolean(),
          pushFollows: z.boolean(),
          telegramReminders: z.boolean(),
          telegramMentions: z.boolean(),
          telegramFollows: z.boolean(),
          timeZone: z.string().max(64).refine(validZone, 'That isn’t a time zone this server knows (e.g. Asia/Bangkok).').nullable(),
        })
        .partial(),
      req.body,
    )
    const save = (tx: Db | Tx) =>
      tx
        .update(users)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(users.id, user.id))
    // A new name shows on every board they're on: those are told (see changePerson).
    if (body.name !== undefined && body.name !== user.name) await changePerson(app, user.id, async (tx) => void (await save(tx)))
    else await save(app.db)
    return { user: { ...publicUser(user), ...body } }
  })

  /** Changes your password, or adds one when you have none (you signed up with Google): then there's no current one to give. */
  app.post('/password', LIMIT, async (req) => {
    const user = requireUser(req.user, { allowUnverified: true })
    const body = parse(ChangePassword, req.body)
    const [u] = await app.db.select().from(users).where(eq(users.id, user.id))
    if (u.passwordHash !== null && !(await verifyPassword(body.current ?? '', u.passwordHash)))
      throw new HttpError(400, 'Your current password isn’t right.')
    await app.db
      .update(users)
      .set({ passwordHash: await hashPassword(body.next), updatedAt: new Date() })
      .where(eq(users.id, user.id))
    // Other devices are signed out (and stop getting desktop notifications); this one stays signed in.
    await endAllSessions(app.db, user.id, req.sessionToken ?? undefined)
    await app.push.forget(user.id, { keep: body.pushEndpoint })
    await endEmailTokens(app.db, user.id)
    app.hub.signOut(user.id, req.sessionToken ?? undefined)
    return { ok: true }
  })

  // ── Confirming your email ──────────────────────────────────────────────

  /** Sends another confirmation link while signed out (after signing up). Always the same answer. */
  app.post('/verify/resend', LIMIT, async (req) => {
    const body = parse(z.object({ email }), req.body)
    if (!app.mail.platformReady) return { ok: true }
    const [u] = await app.db.select().from(users).where(eq(users.email, body.email))
    if (u && !u.emailVerifiedAt && !u.disabledAt) {
      const last = await lastEmailToken(app.db, u.id, 'verify')
      if (!last || Date.now() - last.getTime() > RESEND_AFTER_MS) await sendVerification(app, req, u)
    }
    return { ok: true }
  })

  /** Sends another confirmation link (at most once a minute). */
  app.post('/verify/send', LIMIT, async (req) => {
    const user = requireUser(req.user, { allowUnverified: true })
    if (user.emailVerified) return { sent: false, alreadyVerified: true }
    const last = await lastEmailToken(app.db, user.id, 'verify')
    if (last && Date.now() - last.getTime() < RESEND_AFTER_MS) throw new HttpError(429, 'We just sent one. Wait a minute before asking for another.')
    const r = await sendVerification(app, req, user)
    if (!r.queued) throw new HttpError(503, 'We can’t send email right now. Try again later.')
    return { sent: true }
  })

  /**
   * The link in the email. Confirms the address it was sent to (in case the email changed since).
   *
   * The link shows the address is read by whoever clicked it, not that they made the account: someone else could
   * have signed up with this address and their own password, hoping its owner confirms it. So it only counts from
   * a browser signed in to the account, or with the account's password (then it signs in here too). An owner who
   * never made the account can't confirm it, and takes it over with "Forgot password" instead, which sets their own
   * password and signs everyone else out.
   */
  app.post('/verify', LIMIT, async (req, reply) => {
    const body = parse(z.object({ token, password: z.string().max(200).optional() }), req.body)
    const gone = 'This link has expired or was already used. Sign in to get a new one.'
    const seen = await peekEmailToken(app.db, body.token, 'verify')
    if (!seen) throw new HttpError(400, gone)
    if (req.user?.id !== seen.userId) {
      if (body.password === undefined) return { ok: false, needsPassword: true, user: null }
      const [owner] = await app.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, seen.userId))
      if (!owner || !(await verifyPassword(body.password, owner.hash))) throw new HttpError(400, 'That isn’t this account’s password.')
    }
    const t = await useEmailToken(app.db, body.token, 'verify')
    if (!t) throw new HttpError(400, gone)
    const [u] = await app.db
      .update(users)
      .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(sql`${users.id} = ${t.userId} and ${users.email} = ${t.email}`)
      .returning()
    if (!u || u.disabledAt) return { ok: true, user: null }
    if (req.user?.id !== u.id) {
      const session = await createSession(app.db, u.id)
      setSessionCookie(reply, session.token, session.expiresAt)
    }
    return { ok: true, user: publicUser(sessionUser(u)) }
  })

  // ── Forgot password ────────────────────────────────────────────────────

  /** Emails a reset link. Always the same answer, so it can't be used to find out who has an account. */
  app.post('/forgot', LIMIT, async (req) => {
    const body = parse(z.object({ email }), req.body)
    if (!app.mail.platformReady) throw new HttpError(503, 'Password reset by email isn’t available on this site. Ask your admin to reset it.')
    const [u] = await app.db.select().from(users).where(eq(users.email, body.email))
    if (u && !u.disabledAt) {
      const last = await lastEmailToken(app.db, u.id, 'reset')
      if (!last || Date.now() - last.getTime() > RESEND_AFTER_MS) {
        const t = await createEmailToken(app.db, u.id, 'reset', u.email)
        const url = `${siteUrl(req)}/#/reset/${t}`
        await app.mail.queue({ kind: 'reset', to: u.email, requestedBy: u.id, content: (brand) => emails.reset(brand, { name: u.name, url }) })
      }
    }
    return { ok: true }
  })

  /**
   * Sets a new password from a reset link (emailed, or passed on by a platform admin), signs out everywhere else,
   * and signs in here.
   */
  app.post('/reset', LIMIT, async (req, reply) => {
    const body = parse(z.object({ token, password }), req.body)
    const t = await useEmailToken(app.db, body.token, ['reset', 'admin-reset'])
    if (!t) throw new HttpError(400, 'This link has expired or was already used. Ask for a new one.')
    // An emailed link also proves the address is theirs; one an admin passed on doesn't.
    const emailed = t.purpose === 'reset'
    const [u] = await app.db
      .update(users)
      .set({
        passwordHash: await hashPassword(body.password),
        ...(emailed && { emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, t.userId))
      .returning()
    if (!u || u.disabledAt) throw new HttpError(403, 'This account has been turned off. Ask your admin.')
    await endAllSessions(app.db, u.id)
    await app.push.forget(u.id, {})
    await endEmailTokens(app.db, u.id)
    app.hub.signOut(u.id)
    failures.delete(u.email)
    const session = await createSession(app.db, u.id)
    setSessionCookie(reply, session.token, session.expiresAt)
    return { user: publicUser(sessionUser(u)) }
  })
}

/** The signed-in person. Unless `allowUnverified`, they must have confirmed their email (when the site requires it). */
export function requireUser(user: SessionUser | null, opts: { allowUnverified?: boolean } = {}): SessionUser {
  if (!user) throw new HttpError(401, 'Please sign in.')
  if (user.mustVerify && !opts.allowUnverified)
    throw new HttpError(403, 'Confirm your email address first: check your inbox for the link.', 'verify-email')
  return user
}
