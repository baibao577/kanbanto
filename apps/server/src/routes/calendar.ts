import { createHash, randomBytes } from 'node:crypto'
import type { AccountCalendar } from '@kanbanto/model/api'
import { calendarItems } from '@kanbanto/model/calendar'
import { toIcs, type IcsEvent } from '@kanbanto/model/ics'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { SessionUser } from '../auth/sessions'
import { requireAccess } from '../boards/access'
import { boardsInCalendar, calendarChoices, setBoardOff, taskUrl } from '../calendar/items'
import { badApp } from '../calendar/google'
import { googleApp } from '../calendar/sync'
import { decrypt, encrypt, encryptionReady } from '../crypto'
import { calendarConnections, calendarFeeds, users } from '../db/schema'
import { env } from '../env'
import { loggable } from '../errors'
import { HttpError, parse, siteUrl } from '../http'
import { loadSettings } from '../settings'
import { requireUser } from './auth'

/**
 * Your cards in a calendar (Account → Calendar), two ways:
 *
 * - A calendar link: a private address that calendar apps subscribe to (an .ics file, see model/ics.ts). Whoever has
 *   the address can read it, so it's a long random token, only its SHA-256 is looked up, and making a new one stops
 *   the old one. Off until a platform admin turns calendar links on.
 * - Google Calendar: sign in with Google once, and Kanbanto keeps a calendar of its own there up to date (see
 *   calendar/sync.ts). Needs the site's Google app, set in the Platform console.
 *
 * Both show the same things (model/calendar.ts), and leave out the boards you turned off.
 */

const TOKEN_PREFIX = 'kbc_'
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
/** Bumped when the file's format changes, so calendar apps fetch it again. */
const FEED_VERSION = 1

// Calendar apps ask again every so often; this is far more than they need.
const FEED_LIMIT = { config: { rateLimit: { max: env.test ? 1000 : 120, timeWindow: '1 minute' } } }

/** Kept while someone is at Google signing in: what Google must send back, and who started it. */
const STATE_COOKIE = 'kankan_google'
const GOOGLE_PATH = '/api/account/calendar/google'
export const googleRedirectUri = (req: FastifyRequest) => `${siteUrl(req)}${GOOGLE_PATH}/callback`

const NO_KEY = 'Calendar connections can’t be saved until the server has an encryption key. Restart Kanbanto to make one.'

export const calendarRoutes: FastifyPluginAsync = async (app) => {
  const view = async (req: FastifyRequest, me: SessionUser): Promise<AccountCalendar> => {
    const [feed] = await app.db.select().from(calendarFeeds).where(eq(calendarFeeds.userId, me.id))
    const [c] = await app.db.select().from(calendarConnections).where(eq(calendarConnections.userId, me.id))
    let link: AccountCalendar['link'] = null
    if (feed)
      try {
        link = { url: `${siteUrl(req)}/api/calendar/feed/${decrypt(feed.tokenEncrypted)}/kanbanto.ics`, createdAt: feed.createdAt.toISOString() }
      } catch {
        // Saved with an encryption key the server no longer has: it can't be shown, so they make a new one.
      }
    return {
      linksEnabled: (await loadSettings(app.db)).calendarLinks,
      googleEnabled: !!(await googleApp(app.db)),
      link,
      google: c
        ? {
            email: c.googleEmail,
            connectedAt: c.createdAt.toISOString(),
            lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
            problem: c.lastError,
            reconnect: !!c.failingSince,
          }
        : null,
      boards: (await calendarChoices(app.db, me.id)).map(({ id, name, off }) => ({ id, name, off })),
    }
  }

  app.get('/account/calendar', async (req) => view(req, requireUser(req.user)))

  /** Makes your calendar link, or a new one (the old address stops working). */
  app.put('/account/calendar/link', async (req) => {
    const me = requireUser(req.user)
    if (!(await loadSettings(app.db)).calendarLinks)
      throw new HttpError(403, 'Calendar links are turned off on this site. A platform admin can turn them on.')
    if (!encryptionReady()) throw new HttpError(503, NO_KEY)
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const fresh = { tokenHash: hash(token), tokenEncrypted: encrypt(token), createdAt: new Date() }
    await app.db
      .insert(calendarFeeds)
      .values({ userId: me.id, ...fresh })
      .onConflictDoUpdate({ target: calendarFeeds.userId, set: fresh })
    return view(req, me)
  })

  app.delete('/account/calendar/link', async (req) => {
    const me = requireUser(req.user)
    await app.db.delete(calendarFeeds).where(eq(calendarFeeds.userId, me.id))
    return view(req, me)
  })

  /** Leaves a board out of your calendar, or puts it back. */
  app.put('/account/calendar/boards/:id', async (req) => {
    const me = requireUser(req.user)
    const { id } = parse(z.object({ id: z.string().min(1).max(100) }), req.params)
    const { off } = parse(z.object({ off: z.boolean() }), req.body)
    const { access } = await requireAccess(app.db, me, id, 'viewer', { archived: true })
    if (access.via === 'public') throw new HttpError(403, 'Only boards you’re on can be in your calendar.')
    await setBoardOff(app.db, me.id, id, off)
    app.calendar.changed()
    return view(req, me)
  })

  // ── Google Calendar ───────────────────────────────────────────────────────────

  /** Where to go to sign in with Google and allow the connection. */
  app.post('/account/calendar/google/start', async (req, reply) => {
    const me = requireUser(req.user)
    const google = await googleApp(app.db)
    if (!google) throw new HttpError(403, 'Google Calendar isn’t set up on this site. A platform admin can set it up.')
    if (!encryptionReady()) throw new HttpError(503, NO_KEY)
    const state = randomBytes(24).toString('base64url')
    reply.setCookie(STATE_COOKIE, `${state}.${me.id}`, {
      path: GOOGLE_PATH,
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: 10 * 60,
    })
    return { url: app.calendar.google.authUrl(google, googleRedirectUri(req), state) }
  })

  /**
   * Google sends them back here. Whatever happened, they land on Account → Calendar, which says what went wrong:
   * denied (they said no), permission (they left the calendar box unticked), expired (took too long, or this isn't
   * the browser that started it), signin, off, setup (Google doesn't accept the site's client ID and secret), failed.
   */
  app.get('/account/calendar/google/callback', async (req, reply) => {
    const back = (problem?: string) => reply.redirect(`${siteUrl(req)}/#/account/calendar${problem ? `?problem=${problem}` : ''}`)
    const q = z
      .object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() })
      .safeParse(req.query)
    const expected = req.cookies[STATE_COOKIE]
    reply.clearCookie(STATE_COOKIE, { path: GOOGLE_PATH })
    if (!req.user) return back('signin')
    if (!q.success) return back('failed')
    if (q.data.error) return back(q.data.error === 'access_denied' ? 'denied' : 'failed')
    if (!q.data.code || !q.data.state || expected !== `${q.data.state}.${req.user.id}`) return back('expired')
    const google = await googleApp(app.db)
    if (!google || !encryptionReady()) return back('off')
    try {
      const grant = await app.calendar.google.exchange(google, googleRedirectUri(req), q.data.code)
      if (!grant.calendar) {
        await app.calendar.google.revoke(grant.refreshToken).catch(() => {})
        return back('permission')
      }
      await app.calendar.connect(req.user.id, grant)
    } catch (e) {
      req.log.warn({ err: loggable(e) }, 'connecting Google Calendar')
      return back(badApp(e) ? 'setup' : 'failed')
    }
    return back()
  })

  /** Disconnects: the calendar is removed from your Google account, and Kanbanto's access to it given back. */
  app.delete('/account/calendar/google', async (req) => {
    const me = requireUser(req.user)
    await app.calendar.disconnect(me.id)
    return view(req, me)
  })

  // ── The calendar link itself (no sign-in: the token in the address is the key) ──

  app.get('/calendar/feed/:token/kanbanto.ics', FEED_LIMIT, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(200) }), req.params)
    const missing = () => new HttpError(404, 'This calendar link doesn’t work any more. Make a new one in Kanbanto: Account → Calendar.')
    if (!token.startsWith(TOKEN_PREFIX) || !(await loadSettings(app.db)).calendarLinks) throw missing()
    const [feed] = await app.db
      .select({ userId: calendarFeeds.userId })
      .from(calendarFeeds)
      .innerJoin(users, eq(users.id, calendarFeeds.userId))
      .where(and(eq(calendarFeeds.tokenHash, hash(token)), isNull(users.disabledAt)))
    if (!feed) throw missing()

    const site = siteUrl(req)
    const boards = await boardsInCalendar(app.db, feed.userId)
    // Every board's change number covers its cards, lists and people; the list itself covers access and what's left out.
    const etag = `"${createHash('sha256')
      .update(JSON.stringify([FEED_VERSION, feed.userId, site, boards.map((b) => [b.id, b.seq])]))
      .digest('base64url')
      .slice(0, 32)}"`
    reply.header('etag', etag).header('cache-control', 'private, max-age=0, must-revalidate')
    if (req.headers['if-none-match'] === etag) return reply.status(304).send()

    const events: IcsEvent[] = []
    for (const b of boards) {
      const { data } = await app.engine.snapshot(b.id).catch(() => ({ data: null }))
      if (!data) continue
      // Every reminder as an event of its own: calendar apps mostly ignore the alerts in a calendar they subscribe to.
      for (const item of calendarItems(data, feed.userId, { maxAlerts: 0 })) {
        const url = taskUrl(site, b.id, item.taskId)
        events.push({
          uid: `${b.id}-${item.taskId}-${item.key}@kanbanto`,
          title: item.title,
          description: `${data.board.name}\n${url}`,
          url,
          when: item.when,
          alerts: item.alerts,
          changedAt: data.tasks[item.taskId].updatedAt,
        })
      }
    }
    const { brandName } = await loadSettings(app.db)
    return reply.type('text/calendar; charset=utf-8').send(toIcs({ name: brandName, events }))
  })
}
