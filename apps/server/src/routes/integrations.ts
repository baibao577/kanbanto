import { WEBHOOK_EVENTS, type ApiTokenView, type WebhookDeliveryDetail, type WebhookEventName, type WebhookView } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { MAX_TOKENS, newApiToken } from '../auth/apiTokens'
import { requireAccess } from '../boards/access'
import { decrypt, encrypt } from '../crypto'
import { apiTokens, webhookDeliveries, webhooks } from '../db/schema'
import { HttpError, parse } from '../http'
import { loadSettings } from '../settings'
import { checkWebhookUrl, newWebhookSecret } from '../webhooks'
import { requireUser } from './auth'

const MAX_WEBHOOKS = 10
const DAY = 24 * 60 * 60 * 1000

const tokenView = (t: typeof apiTokens.$inferSelect): ApiTokenView => ({
  id: t.id,
  name: t.name,
  scope: t.scope,
  hint: t.hint,
  createdAt: t.createdAt.toISOString(),
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  expiresAt: t.expiresAt?.toISOString() ?? null,
})

/** Which events a webhook gets: at least one. All of them is stored as null (and then includes events added later). */
const Events = z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Pick at least one kind of event to send.')
const eventsToStore = (events?: WebhookEventName[]) => (!events || WEBHOOK_EVENTS.every((e) => events.includes(e)) ? null : [...new Set(events)])

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  // ── Your API tokens (Account settings; never reachable with a token) ─────────

  app.get('/account/tokens', async (req) => {
    const me = requireUser(req.user)
    const rows = await app.db.select().from(apiTokens).where(eq(apiTokens.userId, me.id)).orderBy(desc(apiTokens.createdAt))
    return { enabled: (await loadSettings(app.db)).apiTokens, tokens: rows.map(tokenView) }
  })

  /** Makes a token. The answer is the only time the token itself is shown. */
  app.post('/account/tokens', async (req) => {
    const me = requireUser(req.user)
    if (!(await loadSettings(app.db)).apiTokens)
      throw new HttpError(403, 'API tokens are turned off on this site. A platform admin can turn them on.')
    const body = parse(
      z.object({
        name: z.string().trim().min(1, 'Give the token a name, so you know what it’s for.').max(100),
        scope: z.enum(['read', 'write']),
        expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
      }),
      req.body,
    )
    const [{ n }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(apiTokens)
      .where(eq(apiTokens.userId, me.id))
    if (n >= MAX_TOKENS) throw new HttpError(400, `You have ${MAX_TOKENS} tokens already. Delete one you don’t use first.`)
    const { token, hash, hint } = newApiToken()
    const [row] = await app.db
      .insert(apiTokens)
      .values({
        id: newId(),
        userId: me.id,
        name: body.name,
        tokenHash: hash,
        hint,
        scope: body.scope,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * DAY) : null,
      })
      .returning()
    return { token, ...tokenView(row) }
  })

  app.delete('/account/tokens/:tokenId', async (req) => {
    const me = requireUser(req.user)
    const { tokenId } = parse(z.object({ tokenId: z.uuid() }), req.params)
    await app.db.delete(apiTokens).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, me.id)))
    return { ok: true }
  })

  // ── A board's webhooks (its owners) ───────────────────────────────────────────

  const BoardParams = z.object({ id: z.string().min(1).max(100) })
  const HookParams = BoardParams.extend({ hookId: z.uuid() })

  /** The board (for an owner) and, with `hookId`, one of its webhooks. */
  const ownHook = async (req: { user: Parameters<typeof requireUser>[0]; params: unknown }) => {
    const { id, hookId } = parse(HookParams, req.params)
    const { board } = await requireAccess(app.db, requireUser(req.user), id, 'owner')
    const [hook] = await app.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, hookId), eq(webhooks.boardId, id)))
    if (!hook) throw new HttpError(404, 'That webhook no longer exists.')
    return { board, hook }
  }
  const modeFor = async () => {
    const mode = (await loadSettings(app.db)).webhooks
    if (mode === 'off') throw new HttpError(403, 'Webhooks are turned off on this site. A platform admin can turn them on.')
    return mode
  }

  app.get('/boards/:id/webhooks', async (req) => {
    const { id } = parse(BoardParams, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'owner')
    const hooks = await app.db.select().from(webhooks).where(eq(webhooks.boardId, id)).orderBy(webhooks.createdAt)
    const recent = hooks.length
      ? await app.db
          .select()
          .from(webhookDeliveries)
          .where(
            inArray(
              webhookDeliveries.webhookId,
              hooks.map((h) => h.id),
            ),
          )
          .orderBy(desc(webhookDeliveries.createdAt))
          .limit(hooks.length * 10)
      : []
    const list: WebhookView[] = hooks.map((h) => ({
      id: h.id,
      url: h.url,
      active: h.active,
      events: (h.events ?? [...WEBHOOK_EVENTS]) as WebhookEventName[],
      createdAt: h.createdAt.toISOString(),
      lastDeliveryAt: h.lastDeliveryAt?.toISOString() ?? null,
      lastStatus: h.lastStatus,
      lastError: h.lastError,
      recent: recent
        .filter((d) => d.webhookId === h.id)
        .slice(0, 5)
        .map((d) => ({
          id: d.id,
          event: d.event,
          status: d.status,
          attempts: d.attempts,
          responseStatus: d.responseStatus,
          error: d.lastError,
          createdAt: d.createdAt.toISOString(),
        })),
    }))
    return { mode: (await loadSettings(app.db)).webhooks, webhooks: list }
  })

  /** Adds a webhook. Its signing secret is in the answer (and can be shown again later by the board's owners). */
  app.post('/boards/:id/webhooks', async (req) => {
    const { id } = parse(BoardParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'owner')
    const mode = await modeFor()
    const { url, events } = parse(
      z.object({ url: z.string().trim().min(1, 'Enter the address to send changes to.').max(2000), events: Events.optional() }),
      req.body,
    )
    checkWebhookUrl(url, mode)
    const [{ n }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhooks)
      .where(eq(webhooks.boardId, id))
    if (n >= MAX_WEBHOOKS) throw new HttpError(400, `A board can have up to ${MAX_WEBHOOKS} webhooks.`)
    const secret = newWebhookSecret()
    const hookId = newId()
    await app.db
      .insert(webhooks)
      .values({ id: hookId, boardId: id, url, events: eventsToStore(events), secretEncrypted: encrypt(secret), createdBy: me.id })
    return { id: hookId, secret }
  })

  /** Pauses or resumes a webhook, or changes its address. */
  app.patch('/boards/:id/webhooks/:hookId', async (req) => {
    const { hook } = await ownHook(req)
    const body = parse(
      z
        .object({ active: z.boolean(), url: z.string().trim().min(1).max(2000), events: Events })
        .partial()
        .strict(),
      req.body,
    )
    if (body.url !== undefined) checkWebhookUrl(body.url, await modeFor())
    const { events, ...rest } = body
    const set = { ...rest, ...(events && { events: eventsToStore(events) }) }
    if (Object.keys(set).length) await app.db.update(webhooks).set(set).where(eq(webhooks.id, hook.id))
    return { ok: true }
  })

  app.get('/boards/:id/webhooks/:hookId/secret', async (req) => {
    const { hook } = await ownHook(req)
    return { secret: decrypt(hook.secretEncrypted) }
  })

  /** A webhook's delivery log (the last 50, or only the failed ones), in full. */
  app.get('/boards/:id/webhooks/:hookId/deliveries', async (req) => {
    const { hook } = await ownHook(req)
    const { failed } = parse(z.object({ failed: z.enum(['0', '1']).optional() }), req.query)
    const rows = await app.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.webhookId, hook.id), failed === '1' ? inArray(webhookDeliveries.status, ['failed', 'pending']) : undefined))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50)
    const deliveries: WebhookDeliveryDetail[] = rows.map((d) => ({
      id: d.id,
      event: d.event,
      status: d.status,
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      error: d.lastError,
      createdAt: d.createdAt.toISOString(),
      payload: d.payload,
      response: d.responseBody,
      sentAt: d.sentAt?.toISOString() ?? null,
    }))
    return { deliveries }
  })

  /** Sends a delivery again, now (as a new delivery). */
  app.post('/boards/:id/webhooks/:hookId/deliveries/:deliveryId/resend', async (req) => {
    const { hook } = await ownHook(req)
    const { deliveryId } = parse(z.object({ deliveryId: z.uuid() }), req.params)
    const [d] = await app.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, hook.id)))
    if (!d) throw new HttpError(404, 'There’s no such delivery.')
    return app.webhooks.resend(d, hook)
  })

  /** A new signing secret: the old one stops working at once. */
  app.post('/boards/:id/webhooks/:hookId/secret', async (req) => {
    const { hook } = await ownHook(req)
    const secret = newWebhookSecret()
    await app.db
      .update(webhooks)
      .set({ secretEncrypted: encrypt(secret) })
      .where(eq(webhooks.id, hook.id))
    return { secret }
  })

  /** Sends a test delivery now, and says how it went. */
  app.post('/boards/:id/webhooks/:hookId/test', async (req) => {
    const { board, hook } = await ownHook(req)
    await modeFor()
    return app.webhooks.ping(hook, { id: board.id, name: board.name })
  })

  app.delete('/boards/:id/webhooks/:hookId', async (req) => {
    const { hook } = await ownHook(req)
    await app.db.delete(webhooks).where(eq(webhooks.id, hook.id))
    return { ok: true }
  })
}
