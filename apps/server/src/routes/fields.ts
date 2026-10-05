import type { FieldLibraryView } from '@kanbanto/model/api'
import { COLORS, type ColorName } from '@kanbanto/model/colors'
import { FIELD_TYPES, LINK_SCOPES, TEXT_FORMATS } from '@kanbanto/model/fields'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import {
  boardFieldsView,
  createField,
  deleteField,
  fieldUsage,
  listLibrary,
  mergeFields,
  mergePreview,
  setBoardFields,
  updateField,
  type Library,
} from '../boards/fields'
import { requireWorkspace } from '../boards/workspaces'
import { parse } from '../http'
import { requireUser } from './auth'

const BoardParams = z.object({ id: z.string().min(1).max(100) })
const FieldParams = z.object({ fieldId: z.uuid() })
const Option = z.object({
  id: z.string().max(100).optional(),
  name: z.string().max(200),
  color: z.enum(COLORS.map((c) => c.id) as [ColorName, ...ColorName[]]),
  archived: z.boolean().optional(),
})
const Settings = z
  .object({
    format: z.enum(TEXT_FORMATS),
    unit: z.string().max(40),
    decimals: z.number().int().min(0).max(6).nullable(),
    sum: z.boolean(),
    options: z.array(Option).max(200),
    linkTo: z.enum(LINK_SCOPES),
    board: z.string().min(1).max(100),
    many: z.boolean(),
    back: z.string().max(200),
  })
  .partial()
const Create = Settings.extend({ name: z.string().max(200), type: z.enum(FIELD_TYPES) }).strict()
const Change = Settings.extend({ name: z.string().max(200).optional(), archived: z.boolean().optional() }).strict()

/**
 * Custom fields (see boards/fields.ts): a workspace's library (everyone in it reads; its admins change it), your own
 * library for your Personal boards, and which fields a board uses (its owners).
 */
export const fieldRoutes: FastifyPluginAsync = async (app) => {
  /** The same routes for both kinds of library. `space` says whose it is, and checks the person may read or change it. */
  const library = (base: string, space: (req: FastifyRequest, change: boolean) => Promise<{ lib: Library; canManage: boolean }>) => {
    const view = async (lib: Library, canManage: boolean): Promise<FieldLibraryView> => ({ fields: await listLibrary(app.db, lib), canManage })

    app.get(base, async (req) => {
      const { lib, canManage } = await space(req, false)
      return view(lib, canManage)
    })

    /** Adds a field. Its type is chosen once: it can't be changed later. */
    app.post(base, async (req) => {
      const { lib } = await space(req, true)
      const id = await createField(app, lib, parse(Create, req.body), requireUser(req.user).id)
      return { id, ...(await view(lib, true)) }
    })

    /**
     * Changes a field: its name, what its type lets you set, its options (the whole list, in order), or `archived`
     * (hidden on every board, its values kept). An archived option left out of the list is deleted for good.
     */
    app.patch(`${base}/:fieldId`, async (req) => {
      const { lib } = await space(req, true)
      const { fieldId } = parse(FieldParams, req.params)
      await updateField(app, lib, fieldId, parse(Change, req.body), requireUser(req.user).id)
      return view(lib, true)
    })

    /** What deleting it for good would take away. */
    app.get(`${base}/:fieldId/usage`, async (req) => {
      const { lib } = await space(req, true)
      return fieldUsage(app.db, lib, parse(FieldParams, req.params).fieldId)
    })

    /** What merging it into another field of the library (`into`) would do, in numbers: nothing is changed. */
    app.get(`${base}/:fieldId/merge`, async (req) => {
      const { lib } = await space(req, true)
      const { into } = parse(z.object({ into: z.uuid() }), req.query)
      return mergePreview(app.db, lib, parse(FieldParams, req.params).fieldId, into)
    })

    /**
     * Merges it into another field of the same kind (`into`): its values become that field's on every card, boards
     * that used it use the other one, and it's gone. It can't be undone.
     */
    app.post(`${base}/:fieldId/merge`, async (req) => {
      const { lib } = await space(req, true)
      const { into } = parse(z.object({ into: z.uuid() }).strict(), req.body)
      const done = await mergeFields(app, lib, parse(FieldParams, req.params).fieldId, into, requireUser(req.user), req.apiToken?.app)
      return { ...done, ...(await view(lib, true)) }
    })

    /** Deletes an archived field for good, with its values on every card. */
    app.delete(`${base}/:fieldId`, async (req) => {
      const { lib } = await space(req, true)
      await deleteField(app, lib, parse(FieldParams, req.params).fieldId)
      return view(lib, true)
    })
  }

  library('/workspaces/:id/fields', async (req, change) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const { role } = await requireWorkspace(app.db, id, requireUser(req.user).id, change)
    return { lib: { workspaceId: id }, canManage: role === 'admin' }
  })
  library('/fields', async (req) => ({ lib: { ownerId: requireUser(req.user).id }, canManage: true }))

  /** A board's fields; its owners also get the fields they could add. */
  app.get('/boards/:id/fields', async (req) => {
    const { id } = parse(BoardParams, req.params)
    const { board, access } = await requireAccess(app.db, req.user, id, 'viewer')
    return boardFieldsView(app, board, access, req.user?.id)
  })

  /** Sets the board's fields: which, in what order, and which show on the card front (its owners). */
  app.put('/boards/:id/fields', async (req) => {
    const { id } = parse(BoardParams, req.params)
    const me = requireUser(req.user)
    const { board, access } = await requireAccess(app.db, me, id, 'owner')
    const { fields } = parse(
      z.object({ fields: z.array(z.object({ id: z.uuid(), front: z.boolean().optional(), total: z.boolean().optional() })).max(100) }).strict(),
      req.body,
    )
    await setBoardFields(app, board, me, fields, req.apiToken?.app)
    return boardFieldsView(app, board, access, me.id)
  })
}
