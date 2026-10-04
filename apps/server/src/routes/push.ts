import { and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pushDevices } from '../db/schema'
import { HttpError, parse } from '../http'
import { assertPublicEndpoint } from '../storage/egress'
import { requireUser } from './auth'

const Subscription = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  label: z.string().trim().max(100).optional(),
})

/** Desktop notifications: the site's public key, your browsers (add, list, remove), and a test. */
export const pushRoutes: FastifyPluginAsync = async (app) => {
  app.get('/push/key', async (req) => {
    requireUser(req.user)
    return { publicKey: await app.push.publicKey() }
  })

  app.get('/push/devices', async (req) => {
    const me = requireUser(req.user)
    const rows = await app.db.select().from(pushDevices).where(eq(pushDevices.userId, me.id)).orderBy(desc(pushDevices.createdAt))
    return {
      devices: rows.map((d) => ({
        id: d.id,
        label: d.label,
        endpoint: d.endpoint,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
      })),
    }
  })

  app.post('/push/devices', async (req) => {
    const me = requireUser(req.user)
    const sub = parse(Subscription, req.body)
    // Push services live on the internet; anything else isn't a real subscription.
    if (!sub.endpoint.startsWith('https://')) throw new HttpError(400, 'That isn’t a push subscription.')
    try {
      assertPublicEndpoint(sub.endpoint)
    } catch {
      throw new HttpError(400, 'That isn’t a push subscription.')
    }
    await app.push.register(me.id, sub, sub.label || 'A browser')
    return { ok: true }
  })

  app.delete('/push/devices/:id', async (req) => {
    const me = requireUser(req.user)
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    await app.db.delete(pushDevices).where(and(eq(pushDevices.id, id), eq(pushDevices.userId, me.id)))
    return { ok: true }
  })

  app.post('/push/test', async (req) => {
    const me = requireUser(req.user)
    const sent = await app.push.toUser(
      me.id,
      { title: 'Desktop notifications work', body: 'Reminders and mentions will show up like this.', url: '/#/', tag: 'test' },
      60,
    )
    return { sent }
  })
}
