import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import pretty from 'pino-pretty'
import { TOKEN_ROUTES, userForApiToken, type TokenAccess } from './auth/apiTokens'
import { SESSION_COOKIE, userForToken, type SessionUser } from './auth/sessions'
import { BoardEngine } from './boards/engine'
import { afterBoardChange } from './boards/follows'
import type { Db } from './db'
import { env } from './env'
import { dbErrorCode, loggable } from './errors'
import { HttpError, siteUrl } from './http'
import type { SiteLink } from '@kanbanto/model/api'
import { LiveHub } from './live'
import { telegramApi, type TelegramApi } from './telegram/api'
import { Telegram } from './telegram/bots'
import { Webhooks } from './webhooks'
import { google, type GoogleApi } from './calendar/google'
import { CalendarSync } from './calendar/sync'
import { calendarRoutes } from './routes/calendar'
import { Push } from './push'
import { servePages, siteLinks } from './pages'
import { presetRoutes } from './routes/presets'
import { pushRoutes } from './routes/push'
import { Mailer } from './mail/mailer'
import { serverSender, type Sender } from './mail/senders'
import { providerTransport, type Transport } from './mail/transport'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { googleAuthRoutes } from './routes/google-auth'
import { fieldRoutes } from './routes/fields'
import { linkRoutes } from './routes/links'
import { boardRoutes } from './routes/boards'
import { cardRoutes } from './cards'
import { inboxRoutes } from './routes/inbox'
import { commentRoutes } from './routes/comments'
import { timeRoutes } from './routes/time'
import { emailRoutes } from './routes/email'
import { fileRoutes } from './routes/files'
import { uploadRoutes } from './routes/uploads'
import { sharingRoutes } from './routes/sharing'
import { mcpRoutes } from './mcp'
import { isOAuthToken, oauthRoutes, resourceMetadataUrl, userForOAuthToken } from './oauth'
import { loadSettings } from './settings'
import { openApiRoutes } from './openapi'
import { integrationRoutes } from './routes/integrations'
import { workspaceRoutes } from './routes/workspaces'
import { planningRoutes } from './routes/planning'

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in person, or null. */
    user: SessionUser | null
    /** The raw session token from the cookie (to sign out or keep this session on password change). */
    sessionToken: string | null
    /** Set when the request came with an API token instead of a session cookie. */
    apiToken: TokenAccess | null
  }
  interface FastifyInstance {
    db: Db
    engine: BoardEngine
    hub: LiveHub
    mail: Mailer
    webhooks: Webhooks
    push: Push
    calendar: CalendarSync
    /** Boards' own Telegram bots. */
    telegram: Telegram
    /** Links to the site's own pages, shown under the sign-in form (see src/pages.ts). */
    siteLinks: SiteLink[]
    /** Where "Guides" in the account menu goes; null: no such item (GUIDES_URL). */
    guidesUrl: string | null
  }
}

/** Tokens in addresses (share links, calendar links, Google's sign-in code) are replaced, so logs are safe to paste into an issue. */
export const redactUrl = (url: string) =>
  url
    .replace(/(\/api\/invites\/)[^/?#]+/, '$1[token]')
    .replace(/(\/api\/calendar\/feed\/)[^/?#]+/, '$1[token]')
    .replace(/(\/api\/uploads\/)[^/?#]+/, '$1[token]')
    .replace(/(\/api\/account\/calendar\/google\/callback)\?.*/, '$1?[…]')
    .replace(/(\/api\/auth\/google\/callback)\?.*/, '$1?[…]')

/**
 * Log lines: short and readable by default (LOG_FORMAT=json for log collectors). Each API request is one line;
 * health checks and the web app's files aren't logged.
 */
function logger(): FastifyServerOptions['logger'] {
  const level = env.production ? 'info' : 'debug'
  if (env.logFormat === 'json') return { level }
  return {
    level,
    stream: pretty({ colorize: !!process.stdout.isTTY, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname,reqId', sync: true }),
  }
}

/** Trust the nearest `n` proxies (what TRUST_PROXY=<n> means). */
const trustHops = (n: number) => (_address: string, hop: number) => hop < n

export async function buildApp(
  db: Db,
  opts: {
    logger?: boolean
    transport?: Transport
    mailWorker?: boolean
    /** The platform's sender set on the server (default: from SMTP_URL and SMTP_FROM). */
    serverSender?: Sender | null
    /** Google, for calendar connections (tests pass a stand-in). */
    google?: GoogleApi
    /** Telegram, for boards' bots (tests pass a stand-in). */
    telegram?: TelegramApi
    /** The folder of the site's own pages (default: PAGES_DIR). */
    pagesDir?: string
    /** Where "Guides" in the account menu goes, or null for none (default: GUIDES_URL). */
    guidesUrl?: string | null
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? logger() : false,
    // Each API request gets one short line (onResponse, below) instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true }),
    // Believe X-Forwarded-* only from the proxies named in TRUST_PROXY (none by default): otherwise anyone could
    // claim any address and dodge the rate limits.
    trustProxy: typeof env.trustProxy === 'number' ? trustHops(env.trustProxy) : env.trustProxy,
    // Requests are small JSON; the routes that need more say so (board import, file uploads).
    bodyLimit: 1024 * 1024,
  })
  const pagesDir = opts.pagesDir ?? env.pagesDir
  app.decorate('siteLinks', siteLinks(pagesDir))
  app.decorate('guidesUrl', opts.guidesUrl !== undefined ? opts.guidesUrl : env.guidesUrl)
  const hub = new LiveHub()
  const mail = new Mailer(db, opts.transport ?? providerTransport, opts.serverSender !== undefined ? opts.serverSender : serverSender(env))
  app.decorate('db', db)
  app.decorate('hub', hub)
  const engine = new BoardEngine(db, hub)
  const webhooks = new Webhooks(db, () => mail.siteUrl ?? env.appUrl ?? null)
  const calendar = new CalendarSync(db, engine, opts.google ?? google, () => mail.siteUrl ?? env.appUrl ?? null)
  engine.onChanged = (boardId, e) => {
    webhooks.later(webhooks.boardChanged(boardId, e).catch((err) => app.log.error({ err: loggable(err) }, 'queueing webhooks')))
    calendar.kick()
  }
  // (Telling people never undoes the change it's about.)
  engine.afterChange = (boardId, e) => afterBoardChange(app, boardId, e).catch((err) => app.log.error({ err: loggable(err) }, 'telling followers'))
  app.decorate('engine', engine)
  app.decorate('mail', mail)
  app.decorate('webhooks', webhooks)
  app.decorate('push', new Push(db, () => mail.siteUrl ?? env.appUrl ?? null, app.log))
  app.decorate('calendar', calendar)
  const telegram = new Telegram(app, opts.telegram ?? telegramApi(), () => mail.siteUrl ?? env.appUrl ?? null)
  app.decorate('telegram', telegram)
  // (A webhook whose format is Telegram is delivered through the board's bot.)
  webhooks.telegram = (hook, payload) => telegram.deliver(hook, payload)
  if (opts.mailWorker) {
    await mail.start(app.log)
    webhooks.start(app.log)
    calendar.start(app.log)
    telegram.start(app.log)
  } else await mail.refresh()
  app.addHook('onClose', async () => {
    mail.stop()
    webhooks.stop()
    calendar.stop()
    telegram.stop()
  })

  await app.register(fastifyCookie)
  await app.register(fastifyRateLimit, { global: false })
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } })

  app.decorateRequest('user', null)
  app.decorateRequest('sessionToken', null)
  app.decorateRequest('apiToken', null)
  // Background jobs (the daily digest) link to APP_URL; in development, to the address of the first request.
  if (env.appUrl) mail.siteUrl = env.appUrl
  // Apps (some in a browser, like the MCP Inspector) call the OAuth and MCP endpoints from other sites. None of them use
  // cookies, so any site may.
  app.addHook('onRequest', async (req, reply) => {
    if (!/^\/(\.well-known\/|oauth\/(register|token|revoke)|api\/mcp)/.test(req.url)) return
    reply.header('access-control-allow-origin', '*')
    reply.header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id')
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
    reply.header('access-control-expose-headers', 'www-authenticate, mcp-session-id')
    if (req.method === 'OPTIONS') return reply.status(204).send()
  })
  // A 401 from the MCP endpoint says where to sign in, when apps may connect with sign-in (the MCP spec's discovery).
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode === 401 && req.url.startsWith('/api/mcp'))
      reply.header(
        'www-authenticate',
        (await loadSettings(db)).oauthApps === 'off' ? 'Bearer' : `Bearer resource_metadata="${resourceMetadataUrl(req)}"`,
      )
    return payload
  })

  app.addHook('onRequest', async (req) => {
    mail.siteUrl ??= siteUrl(req)
    // An app connected with sign-in (OAuth): its tokens are for the MCP endpoint only.
    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
    if (bearer && isOAuthToken(bearer)) {
      if (req.url.split('?')[0] !== '/api/mcp') throw new HttpError(403, 'This token is only for the MCP endpoint (/api/mcp).')
      const { user, token } = await userForOAuthToken(db, bearer)
      req.user = user
      req.apiToken = token
      req.user.mustVerify = !req.user.emailVerified && mail.platformReady && !req.user.isAdmin
      return
    }
    // An API token (scripts, integrations, AI assistants): only for what TOKEN_ROUTES allows, and a read-only token
    // only reads (the MCP endpoint checks each tool itself).
    if (bearer) {
      const { user, token } = await userForApiToken(db, bearer)
      const path = req.url.split('?')[0]
      if (!TOKEN_ROUTES.test(path)) throw new HttpError(403, 'API tokens can’t be used for this. Sign in on the website instead.')
      if (token.scope === 'read' && req.method !== 'GET' && req.method !== 'HEAD' && path !== '/api/mcp')
        throw new HttpError(403, 'This API token can only read. Make one that can also make changes.')
      // "Who am I" is for reading: the account's own settings are changed on the website.
      if (path === '/api/auth/me' && req.method !== 'GET' && req.method !== 'HEAD')
        throw new HttpError(403, 'API tokens can’t be used for this. Sign in on the website instead.')
      req.user = user
      req.apiToken = token
      req.user.mustVerify = !req.user.emailVerified && mail.platformReady && !req.user.isAdmin
      return
    }
    const token = req.cookies[SESSION_COOKIE]
    if (!token) return
    req.user = await userForToken(db, token)
    if (!req.user) return
    req.sessionToken = token
    // Confirming your email is required once the site can send email. Platform admins are exempt: their rights
    // were granted on the server, and the one setting up email mustn't be locked out by it.
    req.user.mustVerify = !req.user.emailVerified && mail.platformReady && !req.user.isAdmin
  })

  const appHost = env.appUrl ? new URL(env.appUrl).host : null
  // Requests that change things (and live connections) must come from this site. Session cookies are
  // SameSite=Lax as well; this is a second lock on the door.
  app.addHook('onRequest', async (req) => {
    const unsafe = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS'
    const upgrade = req.headers.upgrade?.toLowerCase() === 'websocket'
    const origin = req.headers.origin
    if (!(unsafe || upgrade) || !origin) return
    // Requests with a token (not a cookie), and the OAuth endpoints apps call, can't be forged by another site.
    if (req.apiToken || /^\/oauth\/(register|token|revoke)(\?|$)/.test(req.url)) return
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      throw new HttpError(403, 'Bad origin.')
    }
    // req.host is the Host header, or X-Forwarded-Host from a trusted proxy (never a client's own claim).
    if (host !== req.host && host !== appHost) throw new HttpError(403, 'Requests must come from this site.')
  })

  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return
    req.log.info(`${req.method} ${redactUrl(req.url)} → ${reply.statusCode} (${Math.round(reply.elapsedTime)} ms)`)
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      // A refusal caused by something unexpected (e.g. a command that tripped over bad data): worth a look.
      if (err.cause) req.log.warn({ err: loggable(err.cause) }, err.message)
      return reply.status(err.status).send({ ...err.details, error: err.message, ...(err.code ? { code: err.code } : {}) })
    }
    const { statusCode: status, message } = err as { statusCode?: number; message?: string }
    if (status && status < 500) return reply.status(status).send({ error: message })
    // The database refused the data itself (SQLSTATE class 22, e.g. a character text can't hold): the request's fault.
    if (dbErrorCode(err)?.startsWith('22')) return reply.status(400).send({ error: 'That contains something that can’t be saved.' })
    req.log.error({ err: loggable(err) }, 'request failed')
    return reply.status(500).send({ error: 'Something went wrong on our side. Please try again.' })
  })

  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(googleAuthRoutes, { prefix: '/api/auth/google' })
  await app.register(boardRoutes, { prefix: '/api' })
  await app.register(cardRoutes, { prefix: '/api' })
  await app.register(inboxRoutes, { prefix: '/api' })
  await app.register(pushRoutes, { prefix: '/api' })
  await app.register(presetRoutes, { prefix: '/api' })
  await app.register(fieldRoutes, { prefix: '/api' })
  await app.register(linkRoutes, { prefix: '/api' })
  await app.register(sharingRoutes, { prefix: '/api' })
  await app.register(workspaceRoutes, { prefix: '/api' })
  await app.register(planningRoutes, { prefix: '/api' })
  await app.register(integrationRoutes, { prefix: '/api' })
  await app.register(calendarRoutes, { prefix: '/api' })
  await app.register(mcpRoutes, { prefix: '/api' })
  await app.register(oauthRoutes)
  await app.register(openApiRoutes)
  await app.register(adminRoutes, { prefix: '/api/admin' })
  await app.register(emailRoutes, { prefix: '/api' })
  await app.register(commentRoutes, { prefix: '/api' })
  await app.register(timeRoutes, { prefix: '/api' })
  await app.register(fileRoutes, { prefix: '/api' })
  await app.register(uploadRoutes, { prefix: '/api' })
  app.get('/api/health', async () => ({ ok: true }))

  // Every answer: no guessing a file's type, no address leaking to other sites, no other site putting the app in a
  // frame, and (over HTTPS) browsers told to keep using HTTPS. A route that set its own (a file, a preview) keeps it.
  app.addHook('onSend', async (req, reply) => {
    const set = (name: string, value: string) => !reply.hasHeader(name) && reply.header(name, value)
    set('x-content-type-options', 'nosniff')
    set('referrer-policy', 'same-origin')
    set('x-frame-options', 'SAMEORIGIN')
    if (req.protocol === 'https') set('strict-transport-security', 'max-age=15552000')
  })

  if (env.webDist) {
    const root = path.resolve(env.webDist)
    const policy = shellPolicy(path.join(root, 'index.html'))
    await app.register(fastifyStatic, {
      root,
      wildcard: false,
      // The app's page says what it may load: its own files and nothing else.
      setHeaders: (res, file) => {
        if (policy && path.basename(file) === 'index.html') res.header('content-security-policy', policy)
      },
    })
    // Where a phone sends what was shared to Kanbanto (the manifest's share_target): the app, which shows its add page.
    app.get('/share', (_req, reply) => reply.sendFile('index.html'))
    // The web app's pages (it routes with #/… addresses). Only for reading: anything else is a 404.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')
        ? reply.status(404).send({ error: 'Not found.' })
        : reply.sendFile('index.html'),
    )
  }
  if (pagesDir) servePages(app, pagesDir)
  return app
}

/**
 * The content-security policy for the web app's page: scripts from this site only (plus the one small script written
 * into the page, by its hash), pictures from anywhere over HTTPS (attached files may live in a bucket), and no
 * framing by other sites. Null when the page can't be read (then no policy is sent).
 */
export function shellPolicy(indexFile: string): string | null {
  let html: string
  try {
    html = readFileSync(indexFile, 'utf8')
  } catch {
    return null
  }
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
  )
  return [
    "default-src 'self'",
    `script-src 'self' ${inline.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ')
}
