import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import type { Db, Tx } from '../db'
import { attachments, attachmentThumbs } from '../db/schema'
import { env } from '../env'
import { HttpError, parse } from '../http'
import { PICTURE_TYPES } from '../pictures'
import { storeOf } from '../storage/service'
import { requireUser } from './auth'
import { IMAGE_TYPES, pictureSize, pictureType } from './files'

// A card's cover: one of its pictures, shown across the top of the card on the Board.
//
// The Board never draws an original (a phone's photo is megabytes, and a list of them would be fetched again every
// few minutes): it draws a small copy, which the browser of whoever chose the cover made (the server never opens a
// picture) and which is kept here for that file. A small copy is written once and never changed, so browsers keep
// it; it is shown to whoever may open the file itself. Which file is a card's cover is on the card (`Task.cover`),
// set by `BoardEngine.setCover` and by nothing else.

/** How big a small copy can be. The app makes one 640 pixels wide, which is a fifth of this for most pictures. */
export const THUMB_MAX = 300 * 1024
/** …and in pixels: twice what the app makes one, each way. */
const THUMB_WIDE_MAX = 1280
const THUMB_TALL_MAX = 2560
/** The biggest original the server passes on to be shrunk (a browser has to hold all of it, unpacked). */
const ORIGINAL_MAX = 40 * 1024 * 1024

const LIMIT = { config: { rateLimit: { max: env.test ? 1000 : 60, timeWindow: '1 minute' } } }
const TOO_BIG = `A cover’s small copy can be up to ${THUMB_MAX / 1024} KB.`

const Params = z.object({ id: z.string().min(1).max(100) })
const AttParams = Params.extend({ attId: z.uuid() })
const TaskParams = Params.extend({ taskId: z.string().min(1).max(100) })

/** Where a file's small copy is. */
export const thumbUrl = (attachmentId: string) => `/api/attachments/${attachmentId}/thumb`

/** A picture among a board's files that a cover can be made of: not in the trash, and not a comment's that isn't posted yet. */
async function pictureOf(db: Db | Tx, boardId: string, attId: string) {
  const [a] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attId), eq(attachments.boardId, boardId), isNull(attachments.deletedAt), eq(attachments.draft, false)))
  if (!a) throw new HttpError(404, 'That file no longer exists.')
  if (!IMAGE_TYPES.has(a.mime)) throw new HttpError(415, 'Only a picture can be a cover.')
  return a
}

/**
 * These files of a card are going (to the trash, or with their comment): if one of them is its cover, the card has
 * none from now on. Says whether it was, so that bringing the file back can make it the cover again. (The file's own
 * line in the log says what happened: this adds none.)
 */
export async function uncover(app: FastifyInstance, boardId: string, taskId: string, attIds: string[], by: { userId: string; via?: string | null }) {
  if (!attIds.length) return false
  const { data } = await app.engine.snapshot(boardId)
  const cover = data.tasks[taskId]?.cover
  if (!cover || !attIds.includes(cover)) return false
  await app.engine.setCover(boardId, taskId, null, { ...by, said: false })
  return true
}

export const coverRoutes: FastifyPluginAsync = async (app) => {
  // A small copy arrives as its bytes (not JSON), within this plugin only, and only as one of the kinds it can be.
  app.addContentTypeParser([...PICTURE_TYPES], { parseAs: 'buffer', bodyLimit: THUMB_MAX }, (_req, body, done) => done(null, body))

  /**
   * A picture's small copy, as its bytes: what the Board draws when the picture is a card's cover. Made by the
   * browser, for editors. Who's asking and how big it says it is are checked before any of it is read, and what it
   * is goes by its first bytes. Written once: a second one for the same file changes nothing.
   */
  app.put(
    '/boards/:id/attachments/:attId/thumb',
    {
      ...LIMIT,
      onRequest: async (req) => {
        const { id } = parse(AttParams, req.params)
        await requireAccess(app.db, requireUser(req.user), id, 'editor')
        const size = Number(req.headers['content-length'])
        if (!Number.isFinite(size) || size <= 0) throw new HttpError(411, 'Uploads need their size (a Content-Length header).')
        if (size > THUMB_MAX) throw new HttpError(413, TOO_BIG)
      },
    },
    async (req) => {
      const { id, attId } = parse(AttParams, req.params)
      const bytes = req.body
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(400, 'Send the small picture itself: a PNG, JPEG or WebP.')
      const mime = pictureType(bytes)
      if (!mime || !PICTURE_TYPES.has(mime)) throw new HttpError(415, 'That isn’t a picture that can be used here. Use a PNG, JPEG or WebP.')
      // (The app makes it 640 by 1,280 at the most. One that says it is far bigger would be drawn by every browser with the board open.)
      const size = pictureSize(bytes, mime)
      if (!size) throw new HttpError(415, 'That picture can’t be read: it doesn’t say how big it is.')
      if (size.width > THUMB_WIDE_MAX || size.height > THUMB_TALL_MAX) throw new HttpError(413, 'That small picture has too many pixels to be one.')
      const a = await pictureOf(app.db, id, attId)
      await app.db.insert(attachmentThumbs).values({ attachmentId: a.id, mime, bytes }).onConflictDoNothing()
      return { thumb: thumbUrl(a.id) }
    },
  )

  /**
   * A picture's small copy, for anyone who can open the picture itself (the board's people, and visitors when the
   * board has its public link). What's at this address never changes, so a browser keeps it, for that person only.
   */
  app.get('/attachments/:attId/thumb', async (req, reply) => {
    const { attId } = parse(z.object({ attId: z.uuid() }), req.params)
    const [a] = await app.db
      .select({ boardId: attachments.boardId, draft: attachments.draft, uploaderId: attachments.uploaderId })
      .from(attachments)
      .where(and(eq(attachments.id, attId), isNull(attachments.deletedAt)))
    if (!a || (a.draft && a.uploaderId !== req.user?.id)) throw new HttpError(404, 'That file no longer exists.')
    await requireAccess(app.db, req.user, a.boardId, 'viewer')
    const [small] = await app.db.select().from(attachmentThumbs).where(eq(attachmentThumbs.attachmentId, attId))
    if (!small) throw new HttpError(404, 'This picture has no small copy.')
    return reply
      .header('content-type', small.mime)
      .header('content-disposition', 'inline')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(small.bytes)
  })

  /**
   * A picture as it was attached, through the server: for the browser that is about to make its small copy. (The
   * file's own address hands a file in S3-compatible storage out as a link to that storage, which a page may show
   * but isn't allowed to read.) Editors only, and never kept by the browser.
   */
  app.get('/boards/:id/attachments/:attId/original', LIMIT, async (req, reply) => {
    const { id, attId } = parse(AttParams, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'editor')
    const a = await pictureOf(app.db, id, attId)
    if (a.size > ORIGINAL_MAX) throw new HttpError(413, 'This picture is too big to make a cover from.')
    const file = await (await storeOf(app.db, a)).open(a.storageKey)
    if (!file) throw new HttpError(404, 'That file is missing from storage.')
    return reply
      .header('content-type', a.mime)
      .header('content-length', file.size ?? a.size)
      .header('content-disposition', 'inline')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; img-src 'self'; sandbox")
      .header('cache-control', 'no-store')
      .send(file.stream)
  })

  /**
   * Makes one of a card's pictures its cover (editors). The picture needs its small copy first: without one this
   * answers 409 with the code `needs-thumb`.
   */
  app.put('/boards/:id/tasks/:taskId/cover', LIMIT, async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    const { attachmentId } = parse(z.object({ attachmentId: z.uuid() }).strict(), req.body)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    await pictureOf(app.db, id, attachmentId)
    return app.engine.setCover(id, taskId, attachmentId, { userId: me.id, via: req.apiToken?.app })
  })

  /** Takes a card's cover away (editors). The picture stays among its files. */
  app.delete('/boards/:id/tasks/:taskId/cover', LIMIT, async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    return app.engine.setCover(id, taskId, null, { userId: me.id, via: req.apiToken?.app })
  })
}
