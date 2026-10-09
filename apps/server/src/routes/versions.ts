import type { DescriptionVersion, DescriptionVersions } from '@kanbanto/model/api'
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import { descriptionVersions, users } from '../db/schema'
import { HttpError, parse } from '../http'
import { pictureUrl } from '../pictures'
import { requireUser } from './auth'

const Params = z.object({ id: z.string().min(1).max(100), taskId: z.string().min(1).max(100) })

/**
 * Earlier versions of a card's description (see boards/versions.ts): the list, newest first, and one version's
 * text. For the board's people, like a card's History: not visitors with the public link. Bringing one back is an
 * ordinary change to the card (its description set to that text), made by whoever can edit it.
 */
export const versionRoutes: FastifyPluginAsync = async (app) => {
  const open = async (req: { user?: unknown; params: unknown }) => {
    const { id, taskId } = parse(Params, req.params)
    const me = requireUser(req.user as Parameters<typeof requireUser>[0])
    const { access } = await requireAccess(app.db, me, id, 'viewer')
    if (access.via === 'public') throw new HttpError(403, 'Join this board to see earlier versions.')
    return { id, taskId }
  }
  const who = (r: { by: string | null; name: string | null; picture: string | null }) =>
    r.by ? { id: r.by, name: r.name ?? 'Someone', picture: pictureUrl(r.picture) } : null

  app.get('/boards/:id/tasks/:taskId/versions', async (req): Promise<DescriptionVersions> => {
    const { id, taskId } = await open(req)
    const rows = await app.db
      .select({ v: descriptionVersions, name: users.name, picture: users.picture })
      .from(descriptionVersions)
      .leftJoin(users, eq(users.id, descriptionVersions.by))
      .where(and(eq(descriptionVersions.boardId, id), eq(descriptionVersions.taskId, taskId)))
      .orderBy(desc(descriptionVersions.at))
    return {
      versions: rows.map(({ v, name, picture }) => ({
        id: v.id,
        at: v.at.toISOString(),
        by: who({ by: v.by, name, picture }),
        via: v.via,
        length: v.text.length,
      })),
    }
  })

  app.get('/boards/:id/tasks/:taskId/versions/:versionId', async (req): Promise<{ version: DescriptionVersion & { text: string } }> => {
    const { id, taskId } = await open(req)
    const { versionId } = parse(z.object({ versionId: z.uuid() }), { versionId: (req.params as { versionId?: string }).versionId })
    const [row] = await app.db
      .select({ v: descriptionVersions, name: users.name, picture: users.picture })
      .from(descriptionVersions)
      .leftJoin(users, eq(users.id, descriptionVersions.by))
      .where(and(eq(descriptionVersions.id, versionId), eq(descriptionVersions.boardId, id), eq(descriptionVersions.taskId, taskId)))
    if (!row) throw new HttpError(404, 'That version is no longer kept.')
    const { v, name, picture } = row
    return { version: { id: v.id, at: v.at.toISOString(), by: who({ by: v.by, name, picture }), via: v.via, length: v.text.length, text: v.text } }
  })
}
