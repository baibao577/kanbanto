import { newId } from '@kanbanto/model/ids'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { createEmailToken, lastEmailToken, useEmailToken } from '../auth/email-tokens'
import { hashPassword, verifyPassword } from '../auth/password'
import { createSession, endAllSessions, endSession, SESSION_COOKIE, type SessionUser } from '../auth/sessions'
import { findInvite, joinWithInvite } from '../boards/invites'
import { createBoard } from '../boards/service'
import { emailOutbox, users } from '../db/schema'
import { env } from '../env'
import { HttpError, parse, siteUrl } from '../http'
import { loggable } from '../errors'
import { emails } from '../mail/templates'
import { loadSettings as getSettings } from '../settings'
import { announceSharingChange } from './sharing'

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
const ChangePassword = z.object({ current: z.string().max(200), next: password })

export const publicUser = (u: SessionUser) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  isAdmin: u.isAdmin,
  emailVerified: u.emailVerified,
  mentionEmails: u.mentionEmails,
})

export { loadSettings as getSettings } from '../settings'

// Sign-in attempts per address, per minute: slows down password guessing.
const LIMIT = { config: { rateLimit: { max: env.test ? 1000 : 10, timeWindow: '1 minute' } } }
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

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Secure (HTTPS-only) whenever the request came over HTTPS — including behind a host's proxy — so a local
  // production container on http://localhost still works.
  const setCookie = (reply: FastifyReply, token: string, expires: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: reply.request.protocol === 'https', expires })

  app.get('/me', async (req) => {
    const settings = await getSettings(app.db)
    return {
      user: req.user ? publicUser(req.user) : null,
      openSignup: settings.openSignup,
      /** The site can send email (so password reset works, and new accounts confirm their email). */
      emailEnabled: app.mail.platformReady,
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
      // Signing up never makes anyone a platform admin: that's granted on the server (see src/cli.ts).
      const invite = body.invite ? await findInvite(tx, body.invite) : null
      if (!(await getSettings(tx)).openSignup && !invite) throw new HttpError(403, 'Sign-up is closed. Ask a board owner for an invite link.')
      const [taken] = await tx.select().from(users).where(eq(users.email, body.email))
      if (taken) {
        if (!app.mail.platformReady) throw new HttpError(409, 'There’s already an account with that email. Sign in instead.')
        return { kind: 'existing' as const, name: taken.name, email: taken.email, disabled: !!taken.disabledAt }
      }
      // Arriving through an invite emailed to this address proves the address is theirs — unless the inviter was
      // shown the link (the email couldn't be sent), since then the inviter could be the one using it.
      const verified = invite?.invite.kind === 'email' && invite.invite.email === body.email && !invite.invite.linkShown
      const user = { id: newId(), email: body.email, name: body.name, isAdmin: false, emailVerified: verified, mentionEmails: true }
      await tx.insert(users).values({ id: user.id, email: user.email, name: user.name, passwordHash, emailVerifiedAt: verified ? new Date() : null })
      const joined = body.invite ? await joinWithInvite(tx, { id: user.id, email: user.email }, body.invite) : null
      return { kind: 'created' as const, user, joined }
    })
    if (result.kind === 'existing') {
      if (!result.disabled) await accountExistsNotice(app, req, result)
      return { checkEmail: true }
    }
    const { user, joined } = result
    // Everyone starts with the example board, except people who came to join someone else's.
    const setUp = async () => {
      if (joined) await announceSharingChange(app, joined.boardId)
      else await createBoard(app.db, user.id, { name: 'My first board', template: 'example' })
    }
    if (!user.emailVerified && app.mail.platformReady) {
      await sendVerification(app, req, user)
      // Not needed until they've confirmed, so it doesn't hold up (or give away) this answer.
      void setUp().catch((e) => req.log.error({ err: loggable(e) }, 'setting up a new account'))
      return { checkEmail: true }
    }
    await setUp()
    const session = await createSession(app.db, user.id)
    setCookie(reply, session.token, session.expiresAt)
    return { user, boardId: joined?.boardId ?? null }
  })

  app.post('/signin', LIMIT, async (req, reply) => {
    const body = parse(SignIn, req.body)
    if (tooManyFailures(body.email)) throw new HttpError(429, 'Too many wrong passwords for this email. Wait 15 minutes, or reset your password.')
    const [u] = await app.db.select().from(users).where(eq(users.email, body.email))
    // Same answer for an unknown email and a wrong password, so accounts can't be discovered.
    const ok = u ? await verifyPassword(body.password, u.passwordHash) : await verifyPassword(body.password, DUMMY_HASH)
    if (!u || !ok) {
      recordFailure(body.email)
      throw new HttpError(401, 'Wrong email or password.')
    }
    failures.delete(body.email)
    if (u.disabledAt) throw new HttpError(403, 'This account has been turned off. Ask your admin.')
    const session = await createSession(app.db, u.id)
    setCookie(reply, session.token, session.expiresAt)
    return { user: publicUser({ ...u, emailVerified: !!u.emailVerifiedAt }) }
  })

  app.post('/signout', async (req, reply) => {
    if (req.sessionToken) {
      await endSession(app.db, req.sessionToken)
      app.hub.endSession(req.sessionToken)
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  /** Your name, and whether you get the daily email summary of @mentions. */
  app.patch('/me', async (req) => {
    const user = requireUser(req.user, { allowUnverified: true })
    const body = parse(z.object({ name, mentionEmails: z.boolean() }).partial(), req.body)
    await app.db
      .update(users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(users.id, user.id))
    return { user: { ...publicUser(user), ...body } }
  })

  app.post('/password', LIMIT, async (req) => {
    const user = requireUser(req.user, { allowUnverified: true })
    const body = parse(ChangePassword, req.body)
    const [u] = await app.db.select().from(users).where(eq(users.id, user.id))
    if (!(await verifyPassword(body.current, u.passwordHash))) throw new HttpError(400, 'Your current password isn’t right.')
    await app.db
      .update(users)
      .set({ passwordHash: await hashPassword(body.next), updatedAt: new Date() })
      .where(eq(users.id, user.id))
    // Other devices are signed out; this one stays signed in.
    await endAllSessions(app.db, user.id, req.sessionToken ?? undefined)
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
   * The link in the email. Confirms the address it was sent to (in case the email changed since) and signs its owner
   * in on this device: the link reached their inbox, which is how a password reset proves who you are too.
   */
  app.post('/verify', LIMIT, async (req, reply) => {
    const body = parse(z.object({ token }), req.body)
    const t = await useEmailToken(app.db, body.token, 'verify')
    if (!t) throw new HttpError(400, 'This link has expired or was already used. Sign in to get a new one.')
    const [u] = await app.db
      .update(users)
      .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(sql`${users.id} = ${t.userId} and ${users.email} = ${t.email}`)
      .returning()
    if (!u || u.disabledAt) return { ok: true, user: null }
    if (req.user?.id !== u.id) {
      const session = await createSession(app.db, u.id)
      setCookie(reply, session.token, session.expiresAt)
    }
    return { ok: true, user: publicUser({ ...u, emailVerified: true }) }
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
    app.hub.signOut(u.id)
    failures.delete(u.email)
    const session = await createSession(app.db, u.id)
    setCookie(reply, session.token, session.expiresAt)
    return { user: publicUser({ ...u, emailVerified: !!u.emailVerifiedAt }) }
  })
}

/** Checked against when the email is unknown, so both cases take the same time. */
const DUMMY_HASH = await hashPassword('not-a-real-password')

/** The signed-in person. Unless `allowUnverified`, they must have confirmed their email (when the site requires it). */
export function requireUser(user: SessionUser | null, opts: { allowUnverified?: boolean } = {}): SessionUser {
  if (!user) throw new HttpError(401, 'Please sign in.')
  if (user.mustVerify && !opts.allowUnverified)
    throw new HttpError(403, 'Confirm your email address first: check your inbox for the link.', 'verify-email')
  return user
}
