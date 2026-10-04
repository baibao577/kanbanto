import type { AdminGoogleCalendar, AdminSettings } from '@kanbanto/model/api'
import { eq, sql } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { createEmailToken } from '../auth/email-tokens'
import { endAllSessions } from '../auth/sessions'
import { decrypt, encrypt, encryptionReady } from '../crypto'
import { apiTokens, boardMembers, calendarConnections, calendarFeeds, oauthCodes, oauthGrants, siteSettings, users } from '../db/schema'
import { endEmailTokens } from '../auth/email-tokens'
import { HttpError, parse, siteUrl } from '../http'
import { emails } from '../mail/templates'
import { getSettings, requireUser } from './auth'
import { googleRedirectUri } from './calendar'

const UserParams = z.object({ id: z.uuid() })

/**
 * The platform console, for platform admins (granted on the server with `admin grant <email>`, see src/cli.ts):
 * accounts, sign-up, and totals. It deliberately doesn't open people's boards.
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    if (!requireUser(req.user).isAdmin) throw new HttpError(403, 'Only platform admins can do that.')
  })

  app.get('/stats', async () => {
    const [row] = await app.db.execute<{ users: number; active_users: number; boards: number; tasks: number; new_users: number }>(sql`
      select
        (select count(*)::int from users) as users,
        (select count(*)::int from users where disabled_at is null) as active_users,
        (select count(*)::int from boards) as boards,
        (select count(*)::int from tasks) as tasks,
        (select count(*)::int from users where created_at > now() - interval '7 days') as new_users`)
    return { users: row.users, activeUsers: row.active_users, boards: row.boards, tasks: row.tasks, newUsers: row.new_users }
  })

  app.get('/users', async () => {
    const rows = await app.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        isAdmin: users.isAdmin,
        emailVerifiedAt: users.emailVerifiedAt,
        disabledAt: users.disabledAt,
        createdAt: users.createdAt,
        boards: sql<number>`(select count(*)::int from ${boardMembers} where ${boardMembers.userId} = ${users.id} and ${boardMembers.role} = 'owner')`,
      })
      .from(users)
      .orderBy(sql`${users.createdAt} desc`)
    return {
      users: rows.map(({ emailVerifiedAt, ...u }) => ({
        ...u,
        emailVerified: !!emailVerifiedAt,
        disabled: !!u.disabledAt,
        disabledAt: u.disabledAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
      })),
    }
  })

  /**
   * Turns an account off (signed out, can't sign in) or back on, or marks its email as confirmed (the admin vouches
   * for it, e.g. an address that can't receive the confirmation email). Admin rights are only changed on the server.
   */
  app.patch('/users/:id', async (req) => {
    const { id } = parse(UserParams, req.params)
    const me = requireUser(req.user)
    const body = parse(z.strictObject({ disabled: z.boolean(), emailVerified: z.literal(true) }).partial(), req.body)
    if (id === me.id && body.disabled !== undefined) throw new HttpError(400, 'You can’t turn off your own account.')
    const updated = await app.db
      .update(users)
      .set({
        ...(body.disabled !== undefined && { disabledAt: body.disabled ? new Date() : null }),
        ...(body.emailVerified && { emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning({ id: users.id })
    if (!updated.length) throw new HttpError(404, 'That account doesn’t exist.')
    if (body.disabled) {
      await endAllSessions(app.db, id)
      await app.push.forget(id, {})
      // Everything else that acts as them goes too: links, API tokens, connected apps, the calendar link. Turned
      // back on, the account starts without them.
      await endEmailTokens(app.db, id)
      await app.db.delete(apiTokens).where(eq(apiTokens.userId, id))
      await app.db.delete(oauthGrants).where(eq(oauthGrants.userId, id))
      await app.db.delete(oauthCodes).where(eq(oauthCodes.userId, id))
      await app.db.delete(calendarFeeds).where(eq(calendarFeeds.userId, id))
      app.hub.signOut(id)
    }
    return { ok: true }
  })

  /**
   * A one-time link for setting a new password (24 hours), for the admin to pass on: nothing changes until it's used,
   * and then the person picks their own password and is signed out everywhere else. The person is told by email (when
   * the site sends email), so a link they didn't ask for doesn't go unnoticed. Returns the token: the browser builds
   * the link from the address the admin is using.
   */
  app.post('/users/:id/reset-link', async (req) => {
    const { id } = parse(UserParams, req.params)
    const [u] = await app.db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, id))
    if (!u) throw new HttpError(404, 'That account doesn’t exist.')
    const token = await createEmailToken(app.db, u.id, 'admin-reset', u.email)
    if (app.mail.platformReady) {
      const site = siteUrl(req)
      await app.mail.queue({
        kind: 'notice',
        to: u.email,
        requestedBy: null,
        content: (brand) => emails.notice(brand, { name: u.name, what: 'admin-reset', site }),
      })
    }
    return { token }
  })

  const settings = async (): Promise<AdminSettings> => {
    const { openSignup, apiTokens, webhooks, oauthApps, calendarLinks } = await getSettings(app.db)
    return { openSignup, apiTokens, webhooks, oauthApps, calendarLinks }
  }

  app.get('/settings', settings)

  /**
   * Sign-up, API tokens (turning them off stops every token working), where webhooks may go, which apps may connect,
   * and calendar links (turning them off stops every link working).
   */
  app.patch('/settings', async (req): Promise<AdminSettings> => {
    const body = parse(
      z
        .object({
          openSignup: z.boolean(),
          apiTokens: z.boolean(),
          webhooks: z.enum(['off', 'public', 'any']),
          oauthApps: z.enum(['off', 'known', 'any']),
          calendarLinks: z.boolean(),
        })
        .partial()
        .strict(),
      req.body,
    )
    if (Object.keys(body).length)
      await app.db
        .insert(siteSettings)
        .values({ id: 1, ...body })
        .onConflictDoUpdate({ target: siteSettings.id, set: body })
    return settings()
  })

  // ── The site's Google app, for people's Google Calendar connections ───────────

  const googleCalendar = async (req: FastifyRequest): Promise<AdminGoogleCalendar> => {
    const [s] = await app.db.select({ id: siteSettings.googleClientId, secret: siteSettings.googleClientSecretEncrypted }).from(siteSettings)
    const [{ n }] = await app.db.select({ n: sql<number>`count(*)::int` }).from(calendarConnections)
    return { clientId: s?.id ?? null, configured: !!(s?.id && s.secret), redirectUri: googleRedirectUri(req), connections: n }
  }

  app.get('/calendar/google', googleCalendar)

  /**
   * Saves the Google app's client ID and secret (the secret encrypted, and never sent back). Leave the secret out to
   * keep it. Google is asked first whether it knows them: nothing is saved unless it does.
   */
  app.put('/calendar/google', async (req) => {
    const body = parse(
      z.object({
        clientId: z.string().trim().min(1, 'Enter the client ID from Google.').max(300),
        clientSecret: z.string().trim().min(1).max(300).optional(),
      }),
      req.body,
    )
    if (!encryptionReady()) throw new HttpError(503, 'Keys can’t be saved until the server has an encryption key. Restart Kanbanto to make one.')
    const [saved] = await app.db.select({ secret: siteSettings.googleClientSecretEncrypted }).from(siteSettings)
    if (!body.clientSecret && !saved?.secret) throw new HttpError(400, 'Enter the client secret from Google.')
    let clientSecret = body.clientSecret
    if (!clientSecret)
      try {
        clientSecret = decrypt(saved!.secret!)
      } catch {
        throw new HttpError(400, 'The saved client secret can’t be read any more. Enter it again.')
      }
    let refused: string | null
    try {
      refused = await app.calendar.google.checkApp({ clientId: body.clientId, clientSecret }, googleRedirectUri(req))
    } catch {
      throw new HttpError(502, 'Couldn’t reach Google to check the client ID and secret. Try again in a moment.')
    }
    if (refused)
      throw new HttpError(
        400,
        `Google doesn’t accept this client ID and secret (“${refused}”). Copy both from the same client. Google shows the whole secret only when it’s made: if you only see a shortened one, add a new secret to the client and copy that. A secret made a moment ago can take a few minutes to start working: try again shortly.`,
      )
    const set = { googleClientId: body.clientId, ...(body.clientSecret && { googleClientSecretEncrypted: encrypt(body.clientSecret) }) }
    await app.db
      .insert(siteSettings)
      .values({ id: 1, ...set })
      .onConflictDoUpdate({ target: siteSettings.id, set })
    app.calendar.changed()
    return googleCalendar(req)
  })

  /** Stops using the Google app: calendars already connected stop updating, until one is set up again. */
  app.delete('/calendar/google', async (req) => {
    await app.db.update(siteSettings).set({ googleClientId: null, googleClientSecretEncrypted: null })
    return googleCalendar(req)
  })
}
