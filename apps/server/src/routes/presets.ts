import type { BoardPreset } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import type { PresetSettings } from '@kanbanto/model/prefs'
import { PresetSettingsSchema } from '@kanbanto/model/schema'
import { and, asc, count, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import { boardPresets, users } from '../db/schema'
import { HttpError, parse } from '../http'
import { requireUser } from './auth'

const Params = z.object({ id: z.string().min(1).max(100) })
const PresetParams = Params.extend({ presetId: z.uuid() })
const Name = z.string().trim().min(1).max(60)
/** Plenty for any board; stops a script from filling one up. */
const MAX_PRESETS = 50

/** A board's presets: named filters and display settings everyone on it can pick; editors save and change them. */
export const presetRoutes: FastifyPluginAsync = async (app) => {
  const list = async (boardId: string): Promise<BoardPreset[]> => {
    const rows = await app.db
      .select({ p: boardPresets, by: users.name })
      .from(boardPresets)
      .leftJoin(users, eq(users.id, boardPresets.updatedBy))
      .where(eq(boardPresets.boardId, boardId))
      .orderBy(asc(boardPresets.createdAt))
    return rows.map(({ p, by }) => ({
      id: p.id,
      name: p.name,
      settings: p.settings as PresetSettings,
      by: by ?? null,
      updatedAt: p.updatedAt.toISOString(),
    }))
  }

  app.get('/boards/:id/presets', async (req) => {
    const { id } = parse(Params, req.params)
    await requireAccess(app.db, req.user, id, 'viewer')
    return { presets: await list(id) }
  })

  app.post('/boards/:id/presets', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    const body = parse(z.object({ name: Name, settings: PresetSettingsSchema }).strict(), req.body)
    const [{ n }] = await app.db.select({ n: count() }).from(boardPresets).where(eq(boardPresets.boardId, id))
    if (n >= MAX_PRESETS) throw new HttpError(400, `A board can have up to ${MAX_PRESETS} presets. Delete one first.`)
    const presetId = newId()
    await app.db.insert(boardPresets).values({ id: presetId, boardId: id, name: body.name, settings: body.settings, updatedBy: me.id })
    return { id: presetId, presets: await list(id) }
  })

  app.patch('/boards/:id/presets/:presetId', async (req) => {
    const { id, presetId } = parse(PresetParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    const body = parse(z.object({ name: Name, settings: PresetSettingsSchema }).partial().strict(), req.body)
    const done = await app.db
      .update(boardPresets)
      .set({ ...body, updatedBy: me.id, updatedAt: new Date() })
      .where(and(eq(boardPresets.id, presetId), eq(boardPresets.boardId, id)))
      .returning({ id: boardPresets.id })
    if (!done.length) throw new HttpError(404, 'That preset is gone.')
    return { presets: await list(id) }
  })

  app.delete('/boards/:id/presets/:presetId', async (req) => {
    const { id, presetId } = parse(PresetParams, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'editor')
    await app.db.delete(boardPresets).where(and(eq(boardPresets.id, presetId), eq(boardPresets.boardId, id)))
    return { presets: await list(id) }
  })
}
