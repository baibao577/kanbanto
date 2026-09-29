import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ConnectedAppView, OAuthRequestView } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { and, eq, gt, isNull, lt, notExists, or, sql } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { TokenAccess } from './auth/apiTokens'
import { sessionUser, type SessionUser } from './auth/sessions'
import type { Db } from './db'
import { oauthClients, oauthCodes, oauthGrants, users } from './db/schema'
import { env } from './env'
import { HttpError, parse, siteUrl } from './http'
import { requireUser } from './routes/auth'
import { loadSettings } from './settings'

/**
 * Apps that connect to people's accounts with sign-in: OAuth 2.1 as the MCP spec describes it, so Claude (on the web
 * and Desktop) and ChatGPT can use Kanbanto's MCP tools. Discovery documents, dynamic client registration, a consent
 * page (in the web app, #/authorize), the authorization code flow with PKCE, rotating refresh tokens, and revoking.
 *
 * Tokens from here only work for MCP (/api/mcp). Platform admins choose which apps may connect: none, known AI apps
 * (below), or any app; each person still approves each app, and can disconnect it in Account settings.
 */

export type OAuthMode = 'off' | 'known' | 'any'

/**
 * Known AI apps, by where they send people back after sign-in: Claude (web and Desktop), ChatGPT, VS Code, and apps on
 * the person's own computer (loopback addresses, or the cursor:// and vscode:// schemes of desktop apps).
 */
const KNOWN_ORIGINS = ['https://claude.ai', 'https://claude.com', 'https://chatgpt.com', 'https://chat.openai.com', 'https://vscode.dev']
const KNOWN_SCHEMES = ['cursor:', 'vscode:', 'vscode-insiders:']
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

const ACCESS_PREFIX = 'kbo_'
const REFRESH_PREFIX = 'kbr_'
const ACCESS_SECONDS = 60 * 60
const REFRESH_DAYS = 60
const CODE_MINUTES = 5
const DAY_MS = 24 * 60 * 60 * 1000
const SCOPES = { read: 'kanbanto:read', write: 'kanbanto:write' } as const

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const random = (prefix = '') => `${prefix}${randomBytes(32).toString('base64url')}`
const isLoopback = (u: URL) => u.protocol === 'http:' && LOOPBACK.includes(u.hostname)

/** Where an app may send people back to: https, a loopback address (apps on the computer), or a desktop app's scheme. */
function redirectAllowed(uri: string, mode: OAuthMode): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.hash || u.username || u.password) return false
  if (mode === 'known') return KNOWN_ORIGINS.includes(u.origin) || isLoopback(u) || KNOWN_SCHEMES.includes(u.protocol)
  return u.protocol === 'https:' || isLoopback(u) || !['http:', 'javascript:', 'data:', 'file:'].includes(u.protocol)
}

/** What people see as where they'll be sent back to: the site's host, or "an app on your computer". */
const redirectLabel = (uri: string) => {
  const u = new URL(uri)
  return isLoopback(u) ? 'an app on your computer' : u.protocol === 'https:' ? u.host : `the ${u.protocol.slice(0, -1)} app`
}

/** The MCP endpoint's address, the "resource" tokens are for. */
export const mcpResource = (req: FastifyRequest) => `${siteUrl(req)}/api/mcp`
/** Where apps find out how to sign in (sent with a 401 from /api/mcp). */
export const resourceMetadataUrl = (req: FastifyRequest) => `${siteUrl(req)}/.well-known/oauth-protected-resource/api/mcp`

/**
 * The person an OAuth access token belongs to, for /api/mcp. Refused (401) when apps can't connect on this site, or
 * the token is unknown or expired (the app then refreshes it), or the account is turned off.
 */
export async function userForOAuthToken(db: Db, token: string): Promise<{ user: SessionUser; token: TokenAccess }> {
  if ((await loadSettings(db)).oauthApps === 'off') throw new HttpError(401, 'Apps can’t connect with sign-in on this site.')
  const [row] = await db
    .select({ g: oauthGrants, u: users, app: oauthClients.name })
    .from(oauthGrants)
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.accessHash, sha256(token)), gt(oauthGrants.accessExpiresAt, new Date()), isNull(users.disabledAt)))
  if (!row) throw new HttpError(401, 'That access token doesn’t work: it may have expired or been disconnected.')
  if (!row.g.lastUsedAt || Date.now() - row.g.lastUsedAt.getTime() > 60_000)
    await db.update(oauthGrants).set({ lastUsedAt: new Date() }).where(eq(oauthGrants.id, row.g.id))
  return { user: sessionUser(row.u), token: { id: row.g.id, scope: row.g.scope, app: row.app } }
}
export const isOAuthToken = (token: string) => token.startsWith(ACCESS_PREFIX)

export async function tidyOAuth(db: Db) {
  const now = new Date()
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now))
  await db.delete(oauthGrants).where(lt(oauthGrants.refreshExpiresAt, now))
  // Apps that registered but nobody connected (or everyone disconnected) for a month.
  await db.delete(oauthClients).where(
    and(
      lt(oauthClients.createdAt, new Date(now.getTime() - 30 * DAY_MS)),
      notExists(
        db
          .select({ one: sql`1` })
          .from(oauthGrants)
          .where(eq(oauthGrants.clientId, oauthClients.id)),
      ),
    ),
  )
}

/** An OAuth error, in the shape OAuth clients expect ({ error, error_description }). */
const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply.status(status).header('cache-control', 'no-store').send({ error, error_description: description })

/** The parameters of a sign-in request (from /oauth/authorize, carried to the consent page and back). */
const AuthorizeParams = z.object({
  response_type: z.string(),
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().min(43).max(128).optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().max(500).optional(),
  state: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
})
type AuthorizeParams = z.infer<typeof AuthorizeParams>

export const oauthRoutes: FastifyPluginAsync = async (app) => {
  const mode = async () => (await loadSettings(app.db)).oauthApps

  // Token requests are form-encoded (OAuth); they're small.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  )

  /** Checks a sign-in request against its app. Throws a readable reason (shown on the page, never sent to the app). */
  const check = async (req: FastifyRequest, p: AuthorizeParams) => {
    const m = await mode()
    if (m === 'off') throw new HttpError(403, 'Apps can’t connect with sign-in on this site.')
    const [client] = await app.db.select().from(oauthClients).where(eq(oauthClients.id, p.client_id))
    if (!client) throw new HttpError(400, 'This app isn’t registered here. Try connecting it again.')
    const redirect = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined)
    if (!redirect || !client.redirectUris.includes(redirect))
      throw new HttpError(400, 'This app asked to send you back to an address it didn’t register.')
    if (!redirectAllowed(redirect, m)) throw new HttpError(403, 'This site only lets known AI apps connect (Claude, ChatGPT, apps on your computer).')
    if (p.response_type !== 'code') throw new HttpError(400, 'This app asked for an unsupported kind of sign-in.')
    if (!p.code_challenge || p.code_challenge_method !== 'S256') throw new HttpError(400, 'This app didn’t use PKCE, which is required.')
    if (p.resource && p.resource.replace(/\/$/, '') !== mcpResource(req))
      throw new HttpError(400, 'This app asked for access to something other than this site’s MCP tools.')
    const asked = (p.scope ?? '').split(/\s+/).filter(Boolean)
    // Nothing asked for, or change access: up to "read and change"; only reading: only read.
    const scope: 'read' | 'write' = asked.length && !asked.includes(SCOPES.write) && asked.includes(SCOPES.read) ? 'read' : 'write'
    return { client, redirect, scope }
  }

  const sendBack = (redirect: string, params: Record<string, string | undefined>) => {
    const u = new URL(redirect)
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
    return u.toString()
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  const protectedResource = async (req: FastifyRequest, reply: FastifyReply) => {
    if ((await mode()) === 'off') return reply.status(404).send({ error: 'Not found.' })
    return {
      resource: mcpResource(req),
      authorization_servers: [siteUrl(req)],
      scopes_supported: Object.values(SCOPES),
      bearer_methods_supported: ['header'],
      resource_name: 'Kanbanto',
    }
  }
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/api/mcp', protectedResource)

  const authServer = async (req: FastifyRequest, reply: FastifyReply) => {
    if ((await mode()) === 'off') return reply.status(404).send({ error: 'Not found.' })
    const site = siteUrl(req)
    return {
      issuer: site,
      authorization_endpoint: `${site}/oauth/authorize`,
      token_endpoint: `${site}/oauth/token`,
      registration_endpoint: `${site}/oauth/register`,
      revocation_endpoint: `${site}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: Object.values(SCOPES),
    }
  }
  app.get('/.well-known/oauth-authorization-server', authServer)
  app.get('/.well-known/openid-configuration', authServer)

  // ── Registration (RFC 7591) ─────────────────────────────────────────────────

  app.post('/oauth/register', { config: { rateLimit: { max: env.test ? 1000 : 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = await mode()
    if (m === 'off') return oauthError(reply, 403, 'access_denied', 'Apps can’t connect with sign-in on this site.')
    const body = z
      .object({
        redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
        client_name: z.string().trim().max(100).optional(),
        token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
      })
      .safeParse(req.body)
    if (!body.success) return oauthError(reply, 400, 'invalid_client_metadata', 'Send redirect_uris (and optionally client_name).')
    const bad = body.data.redirect_uris.find((u) => !redirectAllowed(u, m))
    if (bad)
      return oauthError(
        reply,
        400,
        'invalid_redirect_uri',
        m === 'known'
          ? `This Kanbanto only lets known AI apps connect (Claude, ChatGPT, apps on your computer): ${bad}`
          : `Not an allowed redirect address: ${bad}`,
      )
    const method = body.data.token_endpoint_auth_method ?? 'none'
    const secret = method === 'none' ? undefined : random('kbs_')
    const id = random().slice(0, 32)
    // (Its name is shown on the consent page: no control characters.)
    const name = [...(body.data.client_name ?? '')].filter((c) => c.charCodeAt(0) >= 32).join('') || 'An app'
    await app.db.insert(oauthClients).values({ id, name, redirectUris: body.data.redirect_uris, secretHash: secret ? sha256(secret) : null })
    return reply.status(201).send({
      client_id: id,
      client_name: name,
      redirect_uris: body.data.redirect_uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
    })
  })

  // ── Sign-in and consent ─────────────────────────────────────────────────────

  /**
   * Where the app sends people. A request that can't be checked (unknown app, unregistered address) gets a page saying
   * so; a good one goes on to the consent page in the web app, which signs them in first if needed.
   */
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>
    const p = AuthorizeParams.safeParse(q)
    try {
      if (!p.success) throw new HttpError(400, 'This sign-in link is incomplete.')
      await check(req, p.data)
    } catch (e) {
      const message = e instanceof HttpError ? e.message : 'This sign-in link doesn’t work.'
      return reply
        .status(400)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Kanbanto</title><p style="font:16px system-ui;margin:3rem auto;max-width:32rem">${message.replace(/[<>&]/g, '')}</p>`,
        )
    }
    return reply.redirect(`/#/authorize?${new URLSearchParams(q).toString()}`)
  })

  /** For the consent page: which app, where it sends you back, and what it asks for. */
  app.get('/api/oauth/request', async (req): Promise<OAuthRequestView> => {
    requireUser(req.user)
    if (req.apiToken) throw new HttpError(403, 'Sign in on the website to approve apps.')
    const { client, redirect, scope } = await check(req, parse(AuthorizeParams, req.query))
    return { app: client.name, sendsBackTo: redirectLabel(redirect), maxScope: scope }
  })

  /** Allowed: a one-time code for the app, and where to send the person back to. */
  app.post('/api/oauth/approve', async (req) => {
    const me = requireUser(req.user)
    if (req.apiToken) throw new HttpError(403, 'Sign in on the website to approve apps.')
    const body = parse(AuthorizeParams.extend({ choice: z.enum(['read', 'write']) }), req.body)
    const { client, redirect, scope } = await check(req, body)
    const code = random()
    await app.db.insert(oauthCodes).values({
      codeHash: sha256(code),
      clientId: client.id,
      userId: me.id,
      redirectUri: redirect,
      codeChallenge: body.code_challenge!,
      scope: scope === 'read' ? 'read' : body.choice,
      expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
    })
    return { redirect: sendBack(redirect, { code, state: body.state, iss: siteUrl(req) }) }
  })

  app.post('/api/oauth/deny', async (req) => {
    requireUser(req.user)
    const body = parse(AuthorizeParams, req.body)
    const { redirect } = await check(req, body)
    return { redirect: sendBack(redirect, { error: 'access_denied', state: body.state, iss: siteUrl(req) }) }
  })

  // ── Tokens ──────────────────────────────────────────────────────────────────

  /** The app making a token request: its client_id, and its secret if it has one (in the body or HTTP Basic). */
  const clientOf = async (req: FastifyRequest, body: Record<string, string>) => {
    let id = body.client_id
    let secret = body.client_secret
    const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1]
    if (basic) {
      const [u, p] = Buffer.from(basic, 'base64').toString().split(':')
      id = decodeURIComponent(u ?? '')
      secret = decodeURIComponent(p ?? '')
    }
    if (!id) return null
    const [client] = await app.db.select().from(oauthClients).where(eq(oauthClients.id, id))
    if (!client) return null
    if (client.secretHash) {
      const a = Buffer.from(sha256(secret ?? ''))
      if (!secret || !timingSafeEqual(a, Buffer.from(client.secretHash))) return null
    }
    return client
  }

  const tokens = (scope: 'read' | 'write') => {
    const access = random(ACCESS_PREFIX)
    const refresh = random(REFRESH_PREFIX)
    return {
      access,
      refresh,
      row: {
        scope,
        accessHash: sha256(access),
        accessExpiresAt: new Date(Date.now() + ACCESS_SECONDS * 1000),
        refreshHash: sha256(refresh),
        refreshExpiresAt: new Date(Date.now() + REFRESH_DAYS * DAY_MS),
      },
      answer: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: SCOPES[scope] },
    }
  }

  app.post('/oauth/token', { config: { rateLimit: { max: env.test ? 1000 : 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    if ((await mode()) === 'off') return oauthError(reply, 400, 'unauthorized_client', 'Apps can’t connect with sign-in on this site.')
    const body = (req.body ?? {}) as Record<string, string>
    const client = await clientOf(req, body)
    if (!client) return oauthError(reply, 401, 'invalid_client', 'Unknown app, or wrong client secret.')
    if (body.resource && body.resource.replace(/\/$/, '') !== mcpResource(req))
      return oauthError(reply, 400, 'invalid_target', 'Tokens here are only for this site’s MCP tools.')

    if (body.grant_type === 'authorization_code') {
      const issued = await app.db.transaction(async (tx) => {
        // One use only: the code is gone whatever happens next.
        const [code] = await tx
          .delete(oauthCodes)
          .where(eq(oauthCodes.codeHash, sha256(body.code ?? '')))
          .returning()
        if (!code || code.clientId !== client.id || code.expiresAt < new Date()) return 'That code doesn’t work (used, expired, or for another app).'
        if (body.redirect_uri && body.redirect_uri !== code.redirectUri) return 'redirect_uri doesn’t match the one the code was made for.'
        const challenge = createHash('sha256')
          .update(body.code_verifier ?? '')
          .digest('base64url')
        if (!body.code_verifier || challenge !== code.codeChallenge) return 'The PKCE code_verifier doesn’t match.'
        const t = tokens(code.scope)
        await tx.insert(oauthGrants).values({ id: newId(), clientId: client.id, userId: code.userId, ...t.row })
        return t.answer
      })
      if (typeof issued === 'string') return oauthError(reply, 400, 'invalid_grant', issued)
      return reply.header('cache-control', 'no-store').send(issued)
    }

    if (body.grant_type === 'refresh_token') {
      const [grant] = await app.db
        .select({ g: oauthGrants, disabled: users.disabledAt })
        .from(oauthGrants)
        .innerJoin(users, eq(users.id, oauthGrants.userId))
        .where(and(eq(oauthGrants.refreshHash, sha256(body.refresh_token ?? '')), eq(oauthGrants.clientId, client.id)))
      if (!grant || grant.g.refreshExpiresAt < new Date() || grant.disabled)
        return oauthError(reply, 400, 'invalid_grant', 'That refresh token doesn’t work: connect the app again.')
      // A new pair each time: the old refresh token stops working.
      const t = tokens(grant.g.scope)
      await app.db.update(oauthGrants).set(t.row).where(eq(oauthGrants.id, grant.g.id))
      return reply.header('cache-control', 'no-store').send(t.answer)
    }
    return oauthError(reply, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.')
  })

  /** Disconnects: an access or refresh token ends its whole approval. Always 200, as RFC 7009 asks. */
  app.post('/oauth/revoke', async (req, reply) => {
    const token = ((req.body ?? {}) as Record<string, string>).token ?? ''
    const h = sha256(token)
    await app.db.delete(oauthGrants).where(or(eq(oauthGrants.accessHash, h), eq(oauthGrants.refreshHash, h)))
    return reply.status(200).send()
  })

  // ── Your connected apps (Account settings) ──────────────────────────────────

  app.get('/api/account/apps', async (req) => {
    const me = requireUser(req.user)
    const rows = await app.db
      .select({ g: oauthGrants, name: oauthClients.name, uris: oauthClients.redirectUris })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(eq(oauthGrants.userId, me.id))
    // One line per app (reconnecting makes a new approval).
    const byApp = new Map<string, ConnectedAppView>()
    for (const r of rows) {
      const prev = byApp.get(r.g.clientId)
      const view: ConnectedAppView = {
        clientId: r.g.clientId,
        name: r.name,
        sendsBackTo: redirectLabel(r.uris[0]),
        scope: prev?.scope === 'write' ? 'write' : r.g.scope,
        connectedAt: prev && prev.connectedAt < r.g.createdAt.toISOString() ? prev.connectedAt : r.g.createdAt.toISOString(),
        lastUsedAt: [prev?.lastUsedAt, r.g.lastUsedAt?.toISOString()].filter(Boolean).sort().at(-1) ?? null,
      }
      byApp.set(r.g.clientId, view)
    }
    return { mode: await mode(), apps: [...byApp.values()] }
  })

  app.delete('/api/account/apps/:clientId', async (req) => {
    const me = requireUser(req.user)
    const { clientId } = parse(z.object({ clientId: z.string().min(1).max(200) }), req.params)
    await app.db.delete(oauthGrants).where(and(eq(oauthGrants.userId, me.id), eq(oauthGrants.clientId, clientId)))
    return { ok: true }
  })
}
