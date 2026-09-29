import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm'
import type { Db } from '../db'
import { apiTokens, users } from '../db/schema'
import { HttpError } from '../http'
import { loadSettings } from '../settings'
import { sessionUser, type SessionUser } from './sessions'

/**
 * Personal API tokens: `Authorization: Bearer kbt_…` acts as the token's person, with their access to boards. Only
 * the token's SHA-256 is stored, and the token is shown once. A `read` token can only look.
 */

export type TokenScope = 'read' | 'write'
export const TOKEN_PREFIX = 'kbt_'
/** Tokens a person may have at once. */
export const MAX_TOKENS = 20

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export function newApiToken() {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`
  return { token, hash: hash(token), hint: `${token.slice(0, 6)}…${token.slice(-4)}` }
}

/** What a request made with an API token may do. */
export interface TokenAccess {
  id: string
  scope: TokenScope
  /** What changes made with it are marked with: the app's name ("Claude"), or "API" for an API token. */
  app: string
}

/**
 * The person an API token belongs to. Refused (401) when tokens are turned off on this site, or the token is unknown,
 * expired, or its account is turned off.
 */
export async function userForApiToken(db: Db, token: string): Promise<{ user: SessionUser; token: TokenAccess }> {
  if (!token.startsWith(TOKEN_PREFIX)) throw new HttpError(401, 'That isn’t a Kanbanto API token.')
  if (!(await loadSettings(db)).apiTokens) throw new HttpError(401, 'API tokens are turned off on this site. A platform admin can turn them on.')
  const [row] = await db
    .select({ t: apiTokens, u: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, hash(token)), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())), isNull(users.disabledAt)))
  if (!row) throw new HttpError(401, 'That API token doesn’t work: it may have expired or been deleted.')
  // "Last used" to the minute is enough, and saves a write on every request.
  if (!row.t.lastUsedAt || Date.now() - row.t.lastUsedAt.getTime() > 60_000)
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.t.id))
  return { user: sessionUser(row.u), token: { id: row.t.id, scope: row.t.scope, app: 'API' } }
}

/**
 * What API tokens can reach: boards (and their comments and files), workspaces, notifications, joining, the MCP
 * endpoint, and who you are. Never your account, its tokens, or the Platform console.
 */
export const TOKEN_ROUTES = /^\/api\/(boards|workspaces|notifications|attachments|join|mcp)(\/|\?|$)|^\/api\/auth\/me(\?|$)/

export async function deleteExpiredTokens(db: Db) {
  await db.delete(apiTokens).where(lt(apiTokens.expiresAt, new Date()))
}
