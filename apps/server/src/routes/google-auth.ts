import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { endEmailTokens } from '../auth/email-tokens'
import { createSession, endAllSessions } from '../auth/sessions'
import { badApp, type GoogleIdentity } from '../calendar/google'
import { googleSignInApp } from '../calendar/sync'
import { users } from '../db/schema'
import { loggable } from '../errors'
import { HttpError, parse, siteUrl } from '../http'
import { insertAccount, inviteForSignUp, LIMIT, setSessionCookie, setUpAccount } from './auth'

/**
 * Signing in, and signing up, with Google: the site's Google app (the one the calendar connection uses, see
 * calendar/google.ts) says who someone is, and that is their account here.
 *
 * Which account, in this order:
 * 1. the one already tied to this Google account (its `sub`), whatever its email address is now;
 * 2. the one with the same email address, when Google has checked the address and runs its mailbox: it is tied to
 *    this Google account from then on, and its password keeps working. One that never confirmed its email is
 *    confirmed by this, and loses its password and its sessions: someone else may have made it with this address
 *    and their own password (the same takeover "Forgot password" is, see routes/auth.ts);
 * 3. a new one, already confirmed and without a password, under the rules of the sign-up form (closed sign-up
 *    needs an invite).
 *
 * Nothing is kept from Google but that `sub`.
 */

/** Kept while someone is at Google signing in: what Google must send back, where they were going, and their invite. */
const STATE_COOKIE = 'kankan_google_signin'
const GOOGLE_PATH = '/api/auth/google'
export const googleSignInRedirectUri = (req: FastifyRequest) => `${siteUrl(req)}${GOOGLE_PATH}/callback`

const Waiting = z.object({
  state: z.string().min(1).max(200),
  // Only ever a place in the app.
  next: z.string().max(2000).startsWith('#/').optional(),
  invite: z.string().max(200).optional(),
})
type Waiting = z.infer<typeof Waiting>
const pack = (w: Waiting) => Buffer.from(JSON.stringify(w)).toString('base64url')
function unpack(raw: string | undefined): Waiting | null {
  if (!raw) return null
  try {
    return Waiting.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

/**
 * Why it didn't work, as the sign-in page is told (?problem=…): expired (took too long, or this isn't the browser
 * that started it), unverified (Google hasn't checked the address), password (the address has an account that Google
 * can't vouch for), disabled, closed (no account, and sign-up is closed), invite (the invite isn't theirs to use),
 * off, setup (Google doesn't accept the site's client ID and secret), failed.
 */
type Problem = 'expired' | 'unverified' | 'password' | 'disabled' | 'closed' | 'invite' | 'off' | 'setup' | 'failed'

/** A name for the account from what Google gave: theirs, or the first part of their address. */
function nameFrom(who: GoogleIdentity) {
  // oxlint-disable-next-line no-control-regex
  const name = (who.name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return (name || who.email.split('@')[0]).slice(0, 100)
}

export const googleAuthRoutes: FastifyPluginAsync = async (app) => {
  /** Where to go to sign in with Google. `next`: where they were going (#/…); `invite`: the invite they came with. */
  app.post('/start', LIMIT, async (req, reply) => {
    const body = parse(z.object({ next: z.string().max(2000).optional(), invite: z.string().max(200).optional() }), req.body ?? {})
    const google = await googleSignInApp(app.db)
    if (!google) throw new HttpError(403, 'Signing in with Google isn’t turned on for this site.')
    const state = randomBytes(24).toString('base64url')
    const waiting = { state, ...(body.next?.startsWith('#/') && { next: body.next }), ...(body.invite && { invite: body.invite }) }
    reply.setCookie(STATE_COOKIE, pack(waiting), {
      path: GOOGLE_PATH,
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: 10 * 60,
    })
    return { url: app.calendar.google.signInUrl(google, googleSignInRedirectUri(req), state) }
  })

  /** The account for someone Google vouches for (see the top of this file), or why there isn't one. */
  const accountFor = (who: GoogleIdentity, invite: string | undefined) =>
    app.db.transaction(async (tx) => {
      const [known] = await tx.select().from(users).where(eq(users.googleSub, who.sub))
      if (known) return known.disabledAt ? { problem: 'disabled' as const } : { userId: known.id }
      if (!who.emailVerified) return { problem: 'unverified' as const }
      const email = who.email.trim().toLowerCase()
      const [same] = await tx.select().from(users).where(eq(users.email, email))
      if (same) {
        // Tied to another Google account, or an address Google only knew the owner of once: their password it is.
        if (same.googleSub || !who.hosted) return { problem: 'password' as const }
        if (same.disabledAt) return { problem: 'disabled' as const }
        const takenOver = !same.emailVerifiedAt
        await tx
          .update(users)
          .set({ googleSub: who.sub, ...(takenOver && { emailVerifiedAt: new Date(), passwordHash: null }), updatedAt: new Date() })
          .where(eq(users.id, same.id))
        return { userId: same.id, takenOver }
      }
      await inviteForSignUp(tx, invite, email)
      const { user, joined } = await insertAccount(tx, { email, name: nameFrom(who), passwordHash: null, googleSub: who.sub, verified: true, invite })
      return { userId: user.id, created: { joined } }
    })

  /** Google sends them back here. Signed in, they go on to where they were going; otherwise to the sign-in page, which says why. */
  app.get('/callback', LIMIT, async (req, reply) => {
    const waiting = unpack(req.cookies[STATE_COOKIE])
    reply.clearCookie(STATE_COOKIE, { path: GOOGLE_PATH })
    const back = (problem?: Problem) => {
      const q = new URLSearchParams({ ...(problem && { problem }), ...(waiting?.next && { next: waiting.next }) }).toString()
      return reply.redirect(`${siteUrl(req)}/#/signin${q ? `?${q}` : ''}`)
    }
    const q = z
      .object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() })
      .safeParse(req.query)
    if (!q.success) return back('failed')
    // (They said no at Google: back to the page, with nothing to explain.)
    if (q.data.error) return back(q.data.error === 'access_denied' ? undefined : 'failed')
    if (!waiting || !q.data.code || q.data.state !== waiting.state) return back('expired')
    const google = await googleSignInApp(app.db)
    if (!google) return back('off')

    let who: GoogleIdentity
    try {
      who = await app.calendar.google.identify(google, googleSignInRedirectUri(req), q.data.code)
    } catch (e) {
      req.log.warn({ err: loggable(e) }, 'signing in with Google')
      return back(badApp(e) ? 'setup' : 'failed')
    }

    let found: Awaited<ReturnType<typeof accountFor>>
    try {
      found = await accountFor(who, waiting.invite)
    } catch (e) {
      // Refused the way the sign-up form would be: sign-up is closed, or the invite isn't theirs to use.
      if (e instanceof HttpError) return back(waiting.invite ? 'invite' : 'closed')
      req.log.error({ err: loggable(e) }, 'signing in with Google')
      return back('failed')
    }
    if ('problem' in found) return back(found.problem)

    if (found.takenOver) {
      // Whoever made the account (and whatever acted as it) is out; see the top of this file.
      await endAllSessions(app.db, found.userId)
      await app.push.forget(found.userId, {})
      await endEmailTokens(app.db, found.userId)
      app.hub.signOut(found.userId)
    }
    let land = waiting.next ?? ''
    if (found.created) {
      const { joined } = found.created
      await setUpAccount(app, found.userId, joined)
      // (The invite is used up, so not back to its page.)
      if (joined?.kind === 'board') land = `#/b/${encodeURIComponent(joined.boardId)}`
      else if (joined) land = `#/w/${encodeURIComponent(joined.workspaceId)}`
    }
    const session = await createSession(app.db, found.userId)
    setSessionCookie(reply, session.token, session.expiresAt)
    return reply.redirect(`${siteUrl(req)}/${land}`)
  })
}
