import type { BoardTemplate, CardTemplate } from '@kanbanto/model/templates'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import {
  boardTemplatesOf,
  cardTemplatesOf,
  changeBoardTemplate,
  removeCardTemplate,
  renameCardTemplate,
  saveBoardTemplate,
  saveCardTemplate,
} from '../boards/templates'
import { requireWorkspace } from '../boards/workspaces'
import { parse } from '../http'
import { requireUser } from './auth'

const Params = z.object({ id: z.string().min(1).max(100) })
const TemplateParams = Params.extend({ templateId: z.uuid() })
const Name = z.string().max(300)

/**
 * Templates (see model templates.ts). A board's card templates are read by everyone who can open it and saved,
 * renamed and removed by the people who can edit it. A board template is saved by a board's owners, where the
 * board lives (its workspace's, or their own), and listed for whoever is making a board there.
 */
export const templateRoutes: FastifyPluginAsync = async (app) => {
  app.get('/boards/:id/templates', async (req): Promise<{ templates: CardTemplate[] }> => {
    const { id } = parse(Params, req.params)
    const { access } = await requireAccess(app.db, req.user, id, 'viewer')
    // (Templates are for making cards: someone looking through the board's public link makes none, and isn't handed them.)
    return { templates: access.via === 'public' ? [] : await cardTemplatesOf(app.db, id) }
  })

  /** Saves a card (with its subtasks) as a template: a new one, or over one that is there (`replace`). */
  app.post('/boards/:id/templates', async (req): Promise<{ template: CardTemplate }> => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    const body = parse(z.object({ taskId: z.string().min(1).max(100), name: Name.optional(), replace: z.uuid().optional() }), req.body)
    return { template: await saveCardTemplate(app, id, me, body, req.apiToken?.app) }
  })

  app.patch('/boards/:id/templates/:templateId', async (req) => {
    const { id, templateId } = parse(TemplateParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    const { name } = parse(z.object({ name: Name }), req.body)
    await renameCardTemplate(app, id, me, templateId, name, req.apiToken?.app)
    return { ok: true }
  })

  app.delete('/boards/:id/templates/:templateId', async (req) => {
    const { id, templateId } = parse(TemplateParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    await removeCardTemplate(app, id, me, templateId, req.apiToken?.app)
    return { ok: true }
  })

  /** Saves the board's shape as a board template (owners): a new one, or over one of the same place (`replace`). */
  app.post('/boards/:id/template', async (req): Promise<{ template: BoardTemplate }> => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { board } = await requireAccess(app.db, me, id, 'owner')
    const body = parse(z.object({ name: Name.optional(), replace: z.uuid().optional() }), req.body ?? {})
    return { template: await saveBoardTemplate(app, { id, workspaceId: board.workspaceId }, me, body, req.apiToken?.app) }
  })

  /** The board templates to start a board from: a workspace's (`?workspace=<id>`, for its members), or your own. */
  app.get('/board-templates', async (req): Promise<{ templates: BoardTemplate[] }> => {
    const me = requireUser(req.user)
    const { workspace } = parse(z.object({ workspace: z.uuid().optional() }), req.query)
    if (workspace) await requireWorkspace(app.db, workspace, me.id)
    return { templates: await boardTemplatesOf(app.db, workspace ? { workspaceId: workspace } : { ownerId: me.id }, me) }
  })

  app.patch('/board-templates/:id', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const me = requireUser(req.user)
    const { name } = parse(z.object({ name: Name }), req.body)
    await changeBoardTemplate(app.db, me, id, name)
    return { ok: true }
  })

  app.delete('/board-templates/:id', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const me = requireUser(req.user)
    await changeBoardTemplate(app.db, me, id)
    return { ok: true }
  })
}
