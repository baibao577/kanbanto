import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app'
import { MemoryGoogle } from '../src/calendar/google'
import { createDb, migrateDb, type Db } from '../src/db'
import { MemoryTransport } from '../src/mail/transport'
import { forgetSignInFailures } from '../src/routes/auth'

let shared: { app: FastifyInstance; db: Db; mail: MemoryTransport; google: MemoryGoogle; close: () => Promise<void> } | null = null

/**
 * One app + database for a test file; tables are emptied before each test with `reset()`. Emails are kept in `mail`,
 * and `google` stands in for Google Calendar (a new one for each test).
 */
export async function setup() {
  if (shared) return shared
  const { db, client } = createDb(process.env.DATABASE_URL!)
  await migrateDb(db)
  const mail = new MemoryTransport()
  const google = new MemoryGoogle()
  const app = await buildApp(db, { transport: mail, google })
  await app.ready()
  shared = {
    app,
    db,
    mail,
    google,
    close: async () => {
      await app.close()
      await client.end()
      shared = null
    },
  }
  return shared
}

export async function reset(db: Db) {
  await db.execute(
    sql`truncate users, sessions, site_settings, boards, board_members, board_invites, lists, labels, tasks, email_senders, email_tokens, email_outbox, comments, notifications, task_followers, fields, board_fields, storage_backends, attachments, workspaces, workspace_members, workspace_invites, api_tokens, webhooks, webhook_deliveries, oauth_clients, oauth_codes, oauth_grants, board_activity, reminder_sends, push_devices, board_presets, board_favorites, planning_state, planning_roles, planning_people, planning_projects, planning_lines, planning_blocks, time_entries, calendar_feeds, calendar_connections, calendar_boards, calendar_events cascade`,
  )
  forgetSignInFailures()
  if (shared) {
    shared.mail.sent = []
    shared.mail.fail = null
    shared.app.calendar.google = shared.google = new MemoryGoogle()
    await shared.app.mail.refresh()
  }
}

/** A signed-in person: keeps their session cookie and sends it with each request. */
export class Person {
  cookie = ''
  user!: { id: string; email: string; name: string; isAdmin: boolean; emailVerified: boolean }
  private readonly app: FastifyInstance
  constructor(app: FastifyInstance) {
    this.app = app
  }

  async request<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    })
    const set = res.headers['set-cookie']
    const first = Array.isArray(set) ? set[0] : set
    if (first) this.cookie = first.split(';')[0]
    const json = res.headers['content-type']?.includes('json')
    return { status: res.statusCode, body: (json && res.body ? res.json() : res.body || null) as T, headers: res.headers, raw: res.rawPayload }
  }

  /** Makes the request and expects a 2xx; returns the body. */
  async ok<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
    const r = await this.request<T>(method, url, body)
    if (r.status >= 300) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }

  /**
   * Signs up. Once the site sends email, a new account first has to confirm its address: then `checkEmail` is true
   * and the person isn't signed in yet (see `confirm`).
   */
  static async signUp(app: FastifyInstance, name: string, extra: { invite?: string; email?: string } = {}) {
    const p = new Person(app)
    const r = await p.ok('POST', '/api/auth/signup', {
      name,
      email: extra.email ?? `${name.toLowerCase()}@example.com`,
      password: 'correct horse',
      ...(extra.invite ? { invite: extra.invite } : {}),
    })
    p.user = r.user
    return Object.assign(p, { joinedBoardId: (r.boardId ?? null) as string | null, checkEmail: !!r.checkEmail })
  }

  /** Clicks the link in the latest confirmation email sent to `email`: confirms the address and signs in. */
  async confirm(mail: MemoryTransport, email: string) {
    await flushMail(this.app)
    const token = linkToken(mail.last(email)?.text, 'verify')
    if (!token) throw new Error(`No confirmation email for ${email}`)
    const r = await this.ok('POST', '/api/auth/verify', { token, password: 'correct horse' })
    this.user = r.user
    return this
  }
}

/** Platform admin rights come from the server CLI; tests grant them the same way. */
export { setPlatformAdmin } from '../src/admins'

/** Waits for queued emails to go out (the outbox normally sends in the background). */
export async function flushMail(app: FastifyInstance) {
  await new Promise((r) => setImmediate(r))
  await app.mail.process()
}

/** The token at the end of the first link like …/#/<page>/<token> in an email. */
export const linkToken = (text: string | undefined, page: string) => text?.match(new RegExp(`#/${page}/([A-Za-z0-9_-]+)`))?.[1]

let n = 0
export const mid = () => `m-${Date.now()}-${n++}`
