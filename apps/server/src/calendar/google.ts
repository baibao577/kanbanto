/**
 * Google, as the calendar connection uses it: signing someone in (OAuth, with offline access), and keeping events in
 * a calendar of Kanbanto's own in their account. Plain HTTPS calls to Google's fixed addresses, no SDK.
 *
 * The permission asked for (`calendar.app.created`) only covers calendars Kanbanto made: it can't see or change the
 * person's other calendars. `openid email` is for showing which Google account is connected.
 *
 * And as signing in to Kanbanto with Google uses it (routes/google-auth.ts): the same Google app, asked only who the
 * person is (`openid email profile`), with nothing kept from Google afterwards.
 */

export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.app.created', 'openid', 'email']
const CALENDAR_SCOPE = GOOGLE_SCOPES[0]
/** What signing in with Google asks for: who they are, and nothing of theirs. */
export const SIGN_IN_SCOPES = ['openid', 'email', 'profile']
const TIMEOUT_MS = 15_000
const API = 'https://www.googleapis.com/calendar/v3'

/** The site's Google app (an OAuth client), from the Platform console. */
export interface GoogleApp {
  clientId: string
  clientSecret: string
}

/** Who signed in with Google, as Google says. */
export interface GoogleIdentity {
  /** Google's own id for the account: it never changes, and no two accounts share one. */
  sub: string
  email: string
  /** Google has checked the address is theirs. */
  emailVerified: boolean
  /**
   * Google runs the mailbox (Gmail, or an organisation's Google Workspace), so it knows whose the address is today.
   * For any other address it only knows who had it when the Google account was made.
   */
  hosted: boolean
  name: string | null
}

/** A day (all-day events end the day after), or a moment in UTC. */
type GoogleTime = { date: string } | { dateTime: string; timeZone: 'UTC' }

export interface GoogleEvent {
  summary: string
  description?: string
  start: GoogleTime
  end: GoogleTime
  /** A deadline doesn't make you busy. */
  transparency: 'transparent'
  source?: { title: string; url: string }
  reminders: { useDefault: false; overrides: { method: 'popup'; minutes: number }[] }
}

/**
 * Why Google said no. `refused`: the connection itself no longer works (taken away in their Google account, expired,
 * or the calendar permission wasn't given), and only connecting again helps. Anything else may work later.
 */
export class GoogleError extends Error {
  readonly status: number
  readonly refused: boolean
  /** Google's short name for what went wrong ("invalid_client": it doesn't know this client ID and secret). */
  readonly reason: string
  constructor(status: number, message: string, refused = false, reason = '') {
    super(message)
    this.status = status
    this.refused = refused
    this.reason = reason
  }
}

/** Google doesn't accept the site's Google app (its client ID and secret): the site's setting is wrong, not the person's connection. */
export const badApp = (e: unknown) => e instanceof GoogleError && e.reason === 'invalid_client'

export interface GoogleApi {
  /** Asks Google whether it knows this client ID and secret. Null: it does. Otherwise why not, in Google's words. */
  checkApp(app: GoogleApp, redirectUri: string): Promise<string | null>
  /** Where to send the person to sign in and allow the connection. */
  authUrl(app: GoogleApp, redirectUri: string, state: string): string
  /** Swaps the code Google sent them back with for a refresh token (kept) and who they are. */
  exchange(app: GoogleApp, redirectUri: string, code: string): Promise<{ refreshToken: string; email: string | null; calendar: boolean }>
  /** Where to send the person to sign in to Kanbanto with Google: asks who they are, and for nothing lasting. */
  signInUrl(app: GoogleApp, redirectUri: string, state: string): string
  /** Swaps the code Google sent them back with for who they are. */
  identify(app: GoogleApp, redirectUri: string, code: string): Promise<GoogleIdentity>
  /** A short-lived access token. */
  refresh(app: GoogleApp, refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>
  /** Ends the connection on Google's side. */
  revoke(refreshToken: string): Promise<void>
  createCalendar(accessToken: string, calendar: { name: string; timeZone: string }): Promise<string>
  deleteCalendar(accessToken: string, calendarId: string): Promise<void>
  /** Adds an event under an id chosen here (409: there already is one with that id). */
  insertEvent(accessToken: string, calendarId: string, eventId: string, event: GoogleEvent): Promise<void>
  /** Replaces an event (404 or 410: it, or the calendar, is gone). */
  updateEvent(accessToken: string, calendarId: string, eventId: string, event: GoogleEvent): Promise<void>
  /** Removes an event; one that's already gone is fine. */
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === 'TimeoutError'
    throw new GoogleError(0, timedOut ? `Google didn’t answer within ${TIMEOUT_MS / 1000} seconds.` : 'Couldn’t reach Google.')
  }
}

/** Google's reason for an error, in its words ("Rate Limit Exceeded"), and its short code ("rateLimitExceeded"). */
async function problem(res: Response): Promise<{ message: string; reason: string }> {
  try {
    const body = (await res.json()) as {
      error?: string | { message?: string; errors?: { reason?: string }[]; status?: string }
      error_description?: string
    }
    if (typeof body.error === 'string') return { message: body.error_description ?? body.error, reason: body.error }
    return { message: body.error?.message ?? `Google answered ${res.status}.`, reason: body.error?.errors?.[0]?.reason ?? body.error?.status ?? '' }
  } catch {
    return { message: `Google answered ${res.status}.`, reason: '' }
  }
}

/** A calendar API call. 401, and a 403 that isn't about going too fast, mean the connection no longer works. */
async function api(accessToken: string, method: string, path: string, body?: object): Promise<Response> {
  const res = await call(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (res.ok) return res
  const { message, reason } = await problem(res)
  const tooFast = /rateLimitExceeded|quotaExceeded/i.test(reason)
  throw new GoogleError(res.status, message, res.status === 401 || (res.status === 403 && !tooFast))
}

async function token(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await call('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  if (res.ok) return (await res.json()) as Record<string, unknown>
  const { message, reason } = await problem(res)
  // invalid_grant: the code or refresh token is no good (used, expired, or the person took the access away).
  throw new GoogleError(res.status, message, reason === 'invalid_grant' || reason === 'invalid_client' || reason === 'unauthorized_client', reason)
}

/** What an ID token says. It came straight from Google over HTTPS, so its signature isn't checked again. */
function claimsIn(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== 'string') return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function emailIn(idToken: unknown): string | null {
  const email = claimsIn(idToken)?.email
  return typeof email === 'string' ? email : null
}

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const GMAIL = /@(gmail|googlemail)\.com$/i

const cal = (id: string) => encodeURIComponent(id)

export const google: GoogleApi = {
  async checkApp(app, redirectUri) {
    try {
      // A made-up code: Google checks who's asking before it looks at the code, so the answer is about the client.
      await token({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code: 'kanbanto-check',
      })
      return null
    } catch (e) {
      if (badApp(e)) return (e as GoogleError).message
      // The code was refused, as it should be: the client itself is fine.
      if (e instanceof GoogleError && e.status >= 400 && e.status < 500) return null
      throw e
    }
  },

  authUrl(app, redirectUri, state) {
    const q = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      state,
      // A refresh token, every time (Google only gives one on the first consent otherwise).
      access_type: 'offline',
      prompt: 'consent',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  },

  async exchange(app, redirectUri, code) {
    const t = await token({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
    })
    if (typeof t.refresh_token !== 'string') throw new GoogleError(400, 'Google didn’t give a lasting connection.', true)
    // People can untick a permission on Google's page.
    const calendar = typeof t.scope === 'string' && t.scope.split(' ').includes(CALENDAR_SCOPE)
    return { refreshToken: t.refresh_token, email: emailIn(t.id_token), calendar }
  },

  signInUrl(app, redirectUri, state) {
    const q = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SIGN_IN_SCOPES.join(' '),
      state,
      // Someone signed in to several Google accounts picks which one, every time.
      prompt: 'select_account',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  },

  async identify(app, redirectUri, code) {
    const t = await token({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
    })
    const claims = claimsIn(t.id_token)
    // Made by Google, for this app: anything else isn't an answer to our question.
    if (!claims || claims.aud !== app.clientId || !GOOGLE_ISSUERS.includes(String(claims.iss)) || typeof claims.sub !== 'string' || !claims.sub)
      throw new GoogleError(502, 'Google didn’t say who signed in.')
    if (typeof claims.email !== 'string' || !claims.email) throw new GoogleError(502, 'Google didn’t give an email address.')
    return {
      sub: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      hosted: GMAIL.test(claims.email) || (typeof claims.hd === 'string' && claims.hd !== ''),
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name : null,
    }
  },

  async refresh(app, refreshToken) {
    const t = await token({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken })
    if (typeof t.access_token !== 'string') throw new GoogleError(502, 'Google didn’t give an access token.')
    return { accessToken: t.access_token, expiresIn: typeof t.expires_in === 'number' ? t.expires_in : 3600 }
  },

  async revoke(refreshToken) {
    await call('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    })
  },

  async createCalendar(accessToken, { name, timeZone }) {
    const res = await api(accessToken, 'POST', '/calendars', { summary: name, timeZone })
    return ((await res.json()) as { id: string }).id
  },

  async deleteCalendar(accessToken, calendarId) {
    await api(accessToken, 'DELETE', `/calendars/${cal(calendarId)}`).catch((e) => {
      if (!(e instanceof GoogleError) || (e.status !== 404 && e.status !== 410)) throw e
    })
  },

  async insertEvent(accessToken, calendarId, eventId, event) {
    await api(accessToken, 'POST', `/calendars/${cal(calendarId)}/events`, { id: eventId, ...event })
  },

  async updateEvent(accessToken, calendarId, eventId, event) {
    // Put back an event they deleted in Google, too.
    await api(accessToken, 'PUT', `/calendars/${cal(calendarId)}/events/${cal(eventId)}`, { status: 'confirmed', ...event })
  },

  async deleteEvent(accessToken, calendarId, eventId) {
    await api(accessToken, 'DELETE', `/calendars/${cal(calendarId)}/events/${cal(eventId)}`).catch((e) => {
      if (!(e instanceof GoogleError) || (e.status !== 404 && e.status !== 410)) throw e
    })
  },
}

/**
 * A stand-in for Google that keeps calendars in memory (tests). `fail` makes the next calls fail with it; `calls`
 * counts what was asked.
 */
export class MemoryGoogle implements GoogleApi {
  calendars = new Map<string, Map<string, GoogleEvent>>()
  /** Refresh tokens that still work, and the account each is for. */
  grants = new Map<string, string>()
  revoked: string[] = []
  calls = 0
  fail: GoogleError | null = null
  /** Set to Google's words for it ("The provided client secret is invalid.") to have the site's Google app refused. */
  badApp: string | null = null
  /** What signing in gives: the account, and whether they left the calendar permission ticked. */
  account = { email: 'someone@gmail.com', calendar: true }
  /** Who signing in to Kanbanto with Google says they are. */
  person: GoogleIdentity = { sub: 'google-1', email: 'someone@gmail.com', emailVerified: true, hosted: true, name: 'Some One' }
  private n = 0

  private step() {
    this.calls++
    if (this.fail) throw this.fail
  }
  private calendar(accessToken: string, calendarId: string) {
    if (!this.grants.has(accessToken.replace(/^access:/, ''))) throw new GoogleError(401, 'Invalid Credentials', true)
    const events = this.calendars.get(calendarId)
    if (!events) throw new GoogleError(404, 'Not Found')
    return events
  }
  /** The events in someone's (only) calendar, by title. */
  titles(calendarId = [...this.calendars.keys()][0]) {
    return [...(this.calendars.get(calendarId)?.values() ?? [])].map((e) => e.summary).sort()
  }

  async checkApp() {
    return this.badApp
  }
  authUrl(app: GoogleApp, redirectUri: string, state: string) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state })}`
  }
  async exchange(_app: GoogleApp, _redirectUri: string, code: string) {
    this.step()
    if (this.badApp) throw new GoogleError(401, this.badApp, true, 'invalid_client')
    if (code !== 'good-code') throw new GoogleError(400, 'Bad Request', true)
    const refreshToken = `refresh-${++this.n}`
    this.grants.set(refreshToken, this.account.email)
    return { refreshToken, email: this.account.email, calendar: this.account.calendar }
  }
  signInUrl(app: GoogleApp, redirectUri: string, state: string) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state, scope: SIGN_IN_SCOPES.join(' ') })}`
  }
  async identify(_app: GoogleApp, _redirectUri: string, code: string) {
    this.step()
    if (this.badApp) throw new GoogleError(401, this.badApp, true, 'invalid_client')
    if (code !== 'good-code') throw new GoogleError(400, 'Bad Request', true)
    return { ...this.person }
  }
  async refresh(_app: GoogleApp, refreshToken: string) {
    this.step()
    if (!this.grants.has(refreshToken)) throw new GoogleError(400, 'Token has been expired or revoked.', true)
    return { accessToken: `access:${refreshToken}`, expiresIn: 3600 }
  }
  async revoke(refreshToken: string) {
    this.grants.delete(refreshToken)
    this.revoked.push(refreshToken)
  }
  async createCalendar(accessToken: string) {
    this.step()
    if (!this.grants.has(accessToken.replace(/^access:/, ''))) throw new GoogleError(401, 'Invalid Credentials', true)
    const id = `cal-${++this.n}`
    this.calendars.set(id, new Map())
    return id
  }
  async deleteCalendar(_accessToken: string, calendarId: string) {
    this.step()
    this.calendars.delete(calendarId)
  }
  async insertEvent(accessToken: string, calendarId: string, eventId: string, event: GoogleEvent) {
    this.step()
    const events = this.calendar(accessToken, calendarId)
    if (events.has(eventId)) throw new GoogleError(409, 'The requested identifier already exists.')
    events.set(eventId, event)
  }
  async updateEvent(accessToken: string, calendarId: string, eventId: string, event: GoogleEvent) {
    this.step()
    const events = this.calendar(accessToken, calendarId)
    if (!events.has(eventId)) throw new GoogleError(404, 'Not Found')
    events.set(eventId, event)
  }
  async deleteEvent(accessToken: string, calendarId: string, eventId: string) {
    this.step()
    if (!this.grants.has(accessToken.replace(/^access:/, ''))) throw new GoogleError(401, 'Invalid Credentials', true)
    // Already gone (or its calendar is): fine, as with Google.
    this.calendars.get(calendarId)?.delete(eventId)
  }
}
