import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { changePerson } from '../boards/announce'
import { env } from '../env'
import { HttpError, parse } from '../http'
import { PICTURE_MAX, PICTURE_TYPES, pictureUrl, readPicture, removePicture, savePicture } from '../pictures'
import { publicUser, requireUser } from './auth'
import { pictureType } from './files'

const LIMIT = { config: { rateLimit: { max: env.test ? 1000 : 20, timeWindow: '1 minute' } } }
const TOO_BIG = `A profile picture can be up to ${PICTURE_MAX / 1024} KB.`

/** Profile pictures: a person sets or removes their own, and anyone with a picture's link can load it. */
export const pictureRoutes: FastifyPluginAsync = async (app) => {
  // A picture arrives as its bytes (not JSON), within this plugin only, and only as one of the kinds it can be.
  app.addContentTypeParser([...PICTURE_TYPES], { parseAs: 'buffer', bodyLimit: PICTURE_MAX }, (_req, body, done) => done(null, body))

  /**
   * Your picture, as its bytes. Who's asking and how big it says it is are checked before any of it is read, and
   * what it is goes by its first bytes, not by what the request calls it.
   */
  app.put(
    '/account/picture',
    {
      ...LIMIT,
      onRequest: async (req) => {
        requireUser(req.user)
        const size = Number(req.headers['content-length'])
        if (!Number.isFinite(size) || size <= 0) throw new HttpError(411, 'Uploads need their size (a Content-Length header).')
        if (size > PICTURE_MAX) throw new HttpError(413, TOO_BIG)
      },
    },
    async (req) => {
      const user = requireUser(req.user)
      const bytes = req.body
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(400, 'Send the picture itself: a PNG, JPEG or WebP.')
      const mime = pictureType(bytes)
      if (!mime || !PICTURE_TYPES.has(mime)) throw new HttpError(415, 'That isn’t a picture that can be used here. Use a PNG, JPEG or WebP.')
      let key = ''
      await changePerson(app, user.id, async (tx) => {
        key = await savePicture(tx, user.id, mime, bytes)
      })
      return { user: { ...publicUser(user), picture: pictureUrl(key) } }
    },
  )

  /** Back to your initials. */
  app.delete('/account/picture', LIMIT, async (req) => {
    const user = requireUser(req.user)
    if (user.picture) await changePerson(app, user.id, (tx) => removePicture(tx, user.id))
    return { user: { ...publicUser(user), picture: null } }
  })

  /**
   * A profile picture, for anyone who has its link (people looking at a board through its public link see who its
   * cards are assigned to). The link is long and random, and a new picture gets a new one, so what's at a link
   * never changes: browsers keep it.
   */
  app.get('/pictures/:key', async (req, reply) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[\w-]{16,64}$/) }), req.params)
    const picture = await readPicture(app.db, key)
    if (!picture) throw new HttpError(404, 'There’s no picture here.')
    return reply
      .header('content-type', picture.mime)
      .header('content-disposition', 'inline')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(picture.bytes)
  })
}
