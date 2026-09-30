import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import path from 'node:path'
import pretty from 'pino-pretty'
import { TOKEN_ROUTES, userForApiToken, type TokenAccess } from './auth/apiTokens'
import { SESSION_COOKIE, userForToken, type SessionUser } from './auth/sessions'
import { BoardEngine } from './boards/engine'
import type { Db } from './db'
import { env } from './env'
import { dbErrorCode, loggable } from './errors'
import { HttpError, siteUrl } from './http'
import { LiveHub } from './live'
import { Webhooks } from './webhooks'
import { Push } from './push'
import { presetRoutes } from './routes/presets'
import { pushRoutes } from './routes/push'
import { Mailer } from './mail/mailer'
import { serverSender, type Sender } from './mail/senders'
import { providerTransport, type Transport } from './mail/transport'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { boardRoutes } from './routes/boards'
import { cardRoutes } from './cards'
import { commentRoutes } from './routes/comments'
import { emailRoutes } from './routes/email'
import { fileRoutes } from './routes/files'
import { sharingRoutes } from './routes/sharing'
import { mcpRoutes } from './mcp'
import { isOAuthToken, oauthRoutes, resourceMetadataUrl, userForOAuthToken } from './oauth'
import { loadSettings } from './settings'
import { openApiRoutes } from './openapi'
import { integrationRoutes } from './routes/integrations'
import { workspaceRoutes } from './routes/workspaces'

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
  }
}

/** Share-link tokens in addresses are replaced, so logs are safe to paste into an issue. */
export const redactUrl = (url: string) => url.replace(/(\/api\/invites\/)[^/?#]+/, '$1[token]')

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
  const hub = new LiveHub()
  const mail = new Mailer(db, opts.transport ?? providerTransport, opts.serverSender !== undefined ? opts.serverSender : serverSender(env))
  app.decorate('db', db)
  app.decorate('hub', hub)
  const engine = new BoardEngine(db, hub)
  const webhooks = new Webhooks(db)
  engine.onChanged = (boardId, e) => void webhooks.boardChanged(boardId, e).catch((err) => app.log.error({ err: loggable(err) }, 'queueing webhooks'))
  app.decorate('engine', engine)
  app.decorate('mail', mail)
  app.decorate('webhooks', webhooks)
  app.decorate('push', new Push(db, () => mail.siteUrl ?? env.appUrl ?? null, app.log))
  if (opts.mailWorker) {
    await mail.start(app.log)
    webhooks.start(app.log)
  } else await mail.refresh()
  app.addHook('onClose', async () => {
    mail.stop()
    webhooks.stop()
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
      return reply.status(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) })
    }
    const { statusCode: status, message } = err as { statusCode?: number; message?: string }
    if (status && status < 500) return reply.status(status).send({ error: message })
    // The database refused the data itself (SQLSTATE class 22, e.g. a character text can't hold): the request's fault.
    if (dbErrorCode(err)?.startsWith('22')) return reply.status(400).send({ error: 'That contains something that can’t be saved.' })
    req.log.error({ err: loggable(err) }, 'request failed')
    return reply.status(500).send({ error: 'Something went wrong on our side. Please try again.' })
  })

  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(boardRoutes, { prefix: '/api' })
  await app.register(cardRoutes, { prefix: '/api' })
  await app.register(pushRoutes, { prefix: '/api' })
  await app.register(presetRoutes, { prefix: '/api' })
  await app.register(sharingRoutes, { prefix: '/api' })
  await app.register(workspaceRoutes, { prefix: '/api' })
  await app.register(integrationRoutes, { prefix: '/api' })
  await app.register(mcpRoutes, { prefix: '/api' })
  await app.register(oauthRoutes)
  await app.register(openApiRoutes)
  await app.register(adminRoutes, { prefix: '/api/admin' })
  await app.register(emailRoutes, { prefix: '/api' })
  await app.register(commentRoutes, { prefix: '/api' })
  await app.register(fileRoutes, { prefix: '/api' })
  app.get('/api/health', async () => ({ ok: true }))

  if (env.webDist) {
    await app.register(fastifyStatic, { root: path.resolve(env.webDist), wildcard: false })
    // The web app's pages (it routes with #/… addresses). Only for reading: anything else is a 404.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')
        ? reply.status(404).send({ error: 'Not found.' })
        : reply.sendFile('index.html'),
    )
  }
  return app
}
