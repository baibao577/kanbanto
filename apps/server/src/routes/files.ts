import type { AccountStorage, AttachmentView, PlatformStorage } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { SessionUser } from '../auth/sessions'
import { requireAccess } from '../boards/access'
import { encryptionReady } from '../crypto'
import type { Db, Tx } from '../db'
import { attachments, siteSettings, storageBackends, users } from '../db/schema'
import { HttpError, parse } from '../http'
import {
  activeBackend,
  boardOwner,
  bucketView,
  BucketInput,
  disk,
  quotaUsed,
  retireBucket,
  s3For,
  saveBucket,
  storageSettings,
  storeOf,
} from '../storage/service'
import { contentDisposition, DiskStore, S3Store, StorageError } from '../storage/stores'
import { requireUser } from './auth'

const Params = z.object({ id: z.string().min(1).max(100) })
const TaskParams = Params.extend({ taskId: z.string().min(1).max(100) })
const AttParams = Params.extend({ attId: z.uuid() })
const Bucket = z.object({
  endpoint: z.string().min(1).max(300),
  region: z.string().max(50).optional(),
  bucket: z.string().trim().min(1, 'Enter the bucket name.').max(100),
  accessKeyId: z.string().trim().min(1, 'Enter the access key ID.').max(200),
  secret: z.string().max(300).optional(),
})

const MB = 1024 * 1024
/** Uploads bigger than this are refused before being read, whatever the settings say. */
const HARD_MAX = 200 * MB
const TRASH_DAYS = 30
/** Files someone has uploaded for comments they haven't posted yet: at most this many, and this many times the largest file. */
const MAX_DRAFTS = 10
const MAX_DRAFT_FILES_OF_SPACE = 3
/** Pictures shown in the app; everything else downloads (so nothing uploaded can run as a web page). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const BLOCKED = /\.(exe|bat|cmd|com|scr|msi|msp|vbs|ps1|jar)$/i

const cleanName = (raw: string) =>
  raw
    // Control characters and path separators have no place in a file name.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim()
    .slice(0, 200) || 'file'
const mimeOf = (raw: string | undefined) => (raw && /^[\w.+-]+\/[\w.+-]+$/.test(raw) ? raw.toLowerCase() : 'application/octet-stream')
const formatMb = (bytes: number) => `${Math.round((bytes / MB) * 10) / 10} MB`

type AttRow = typeof attachments.$inferSelect

export async function views(db: Db | Tx, where: ReturnType<typeof and>): Promise<AttachmentView[]> {
  const rows = await db
    .select({ a: attachments, uploader: users.name })
    .from(attachments)
    .leftJoin(users, eq(users.id, attachments.uploaderId))
    .where(where)
    .orderBy(attachments.createdAt)
  return rows.map(({ a, uploader }) => ({
    id: a.id,
    taskId: a.taskId,
    name: a.name,
    size: a.size,
    mime: a.mime,
    uploader,
    createdAt: a.createdAt.toISOString(),
    url: `/api/attachments/${a.id}`,
    image: IMAGE_TYPES.has(a.mime),
    commentId: a.commentId,
  }))
}

/** Attachment counts per task, for the badges on cards (the card's own files; comment files belong to comments). */
export async function attachmentCounts(db: Db | Tx, boardId: string) {
  const rows = await db
    .select({ taskId: attachments.taskId, n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(and(eq(attachments.boardId, boardId), isNull(attachments.deletedAt), isNull(attachments.commentId), eq(attachments.draft, false)))
    .groupBy(attachments.taskId)
  return Object.fromEntries(rows.map((r) => [r.taskId, r.n]))
}

async function removeObject(db: Db | Tx, a: AttRow) {
  try {
    await (await storeOf(db, a)).delete(a.storageKey)
  } catch {
    // Storage gone or unreachable: nothing more to do.
  }
}

/** Deletes a board's files from storage (before the board itself is deleted). */
export async function deleteBoardFiles(db: Db, boardId: string) {
  const rows = await db.select().from(attachments).where(eq(attachments.boardId, boardId))
  for (const a of rows) await removeObject(db, a)
}

/**
 * Housekeeping, every few hours: files of deleted cards go to the trash (and come back if the card is restored),
 * and files in the trash for 30 days are removed for good.
 */
export async function tidyFiles(app: FastifyInstance) {
  await app.db.execute(sql`
    update ${attachments} a set deleted_at = now(), orphaned = true
    where a.deleted_at is null and not exists (select 1 from tasks t where t.board_id = a.board_id and t.id = a.task_id)`)
  // Files uploaded for a comment that was never posted: removed for good (they were never visible).
  const drafts = await app.db
    .select()
    .from(attachments)
    .where(and(eq(attachments.draft, true), lt(attachments.createdAt, new Date(Date.now() - 86_400_000))))
  for (const a of drafts) {
    await removeObject(app.db, a)
    await app.db.delete(attachments).where(eq(attachments.id, a.id))
  }
  const old = await app.db
    .select()
    .from(attachments)
    .where(and(isNotNull(attachments.deletedAt), lt(attachments.deletedAt, new Date(Date.now() - TRASH_DAYS * 86_400_000))))
  for (const a of old) {
    await removeObject(app.db, a)
    await app.db.delete(attachments).where(eq(attachments.id, a.id))
  }
}

/**
 * Attaches draft uploads (by this person, for this card) to a comment. Drafts don't count against the board owner's
 * space until they're posted, so this is where that's checked. Returns how many were attached.
 */
export async function attachDrafts(db: Db | Tx, c: { boardId: string; taskId: string; uploaderId: string; commentId: string }, ids: string[]) {
  if (!ids.length) return 0
  const mine = and(
    inArray(attachments.id, ids),
    eq(attachments.boardId, c.boardId),
    eq(attachments.taskId, c.taskId),
    eq(attachments.uploaderId, c.uploaderId),
    eq(attachments.draft, true),
    isNull(attachments.deletedAt),
  )
  const drafts = await db
    .select({ size: attachments.size, ownerId: attachments.ownerId, ownStorage: attachments.ownStorage })
    .from(attachments)
    .where(mine)
  const counted = drafts.filter((d) => !d.ownStorage && d.ownerId)
  if (counted.length) {
    const { quotaMb } = await storageSettings(db)
    const adding = counted.reduce((n, d) => n + d.size, 0)
    if ((await quotaUsed(db, counted[0].ownerId!)) + adding > quotaMb * MB)
      throw new HttpError(413, `The board’s owner is out of file space (${quotaMb} MB), so these files can’t be added. Ask them to free some up.`)
  }
  const rows = await db.update(attachments).set({ commentId: c.commentId, draft: false }).where(mine).returning({ id: attachments.id })
  return rows.length
}

/** A deleted comment's files go to the trash. */
export async function trashCommentFiles(db: Db | Tx, commentId: string) {
  await db
    .update(attachments)
    .set({ deletedAt: new Date() })
    .where(and(eq(attachments.commentId, commentId), isNull(attachments.deletedAt)))
}

export const fileRoutes: FastifyPluginAsync = async (app) => {
  // Uploads arrive as raw bytes (not JSON), within this plugin only.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: HARD_MAX }, (_req, body, done) => done(null, body))

  // ── Attachments ─────────────────────────────────────────────────────────

  app.get('/boards/:id/tasks/:taskId/attachments', async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    await requireAccess(app.db, req.user, id, 'viewer')
    // A card restored with undo gets back the files that went to the trash with it.
    const { data } = await app.engine.snapshot(id)
    if (data.tasks[taskId])
      await app.db
        .update(attachments)
        .set({ deletedAt: null, orphaned: false })
        .where(and(eq(attachments.boardId, id), eq(attachments.taskId, taskId), eq(attachments.orphaned, true)))
    // The card's files and the files in its comments (for referencing them with #); not unposted drafts.
    return {
      attachments: await views(
        app.db,
        and(eq(attachments.boardId, id), eq(attachments.taskId, taskId), isNull(attachments.deletedAt), eq(attachments.draft, false)),
      ),
    }
  })

  /**
   * Uploads a file to a card (editors and owners), or — with `x-attach-to: comment` — for a comment being written
   * (anyone who can comment, viewers included; it's a draft until the comment is posted). The body is the file's bytes, sent as application/octet-stream
   * (so nothing tries to parse it, whatever the file is); its name and type are in `x-file-name` and `x-file-type`.
   * It goes to the board owner's own storage if they connected one, else the site's storage within their quota.
   */
  /** Who may upload here (checked before the file is read, and again after). */
  const uploader = async (req: FastifyRequest) => {
    const { id, taskId } = parse(TaskParams, req.params)
    const me = requireUser(req.user)
    const forComment = req.headers['x-attach-to'] === 'comment'
    const { access } = await requireAccess(app.db, me, id, forComment ? 'viewer' : 'editor')
    if (forComment && access.via !== 'member') throw new HttpError(403, 'Join this board to comment on it.')
    return { id, taskId, me, forComment }
  }

  app.post(
    '/boards/:id/tasks/:taskId/attachments',
    {
      // Everything that can be checked before reading the file is, so nobody can make the server hold a big
      // upload in memory for nothing: who's asking, the declared size, and room for drafts.
      onRequest: async (req) => {
        const { me, forComment } = await uploader(req)
        const { maxFileMb } = await storageSettings(app.db)
        const size = Number(req.headers['content-length'])
        if (!Number.isFinite(size) || size <= 0) throw new HttpError(411, 'Uploads need their size (a Content-Length header).')
        if (size > maxFileMb * MB) throw new HttpError(413, `Files can be up to ${maxFileMb} MB.`)
        if (forComment) {
          const [waiting] = await app.db
            .select({ n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::bigint` })
            .from(attachments)
            .where(and(eq(attachments.uploaderId, me.id), eq(attachments.draft, true), isNull(attachments.deletedAt)))
          if (waiting.n >= MAX_DRAFTS || Number(waiting.bytes) + size > MAX_DRAFT_FILES_OF_SPACE * maxFileMb * MB)
            throw new HttpError(429, 'You have files waiting in comments you haven’t posted. Post those comments or remove the files first.')
        }
      },
    },
    async (req) => {
      const { id, taskId, me, forComment } = await uploader(req)
      const body = req.body
      if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Choose a file to upload.')
      const { maxFileMb, quotaMb } = await storageSettings(app.db)
      if (body.length > maxFileMb * MB) throw new HttpError(413, `Files can be up to ${maxFileMb} MB.`)
      const name = cleanName(decodeURIComponent(String(req.headers['x-file-name'] ?? 'file')))
      if (BLOCKED.test(name)) throw new HttpError(400, 'Programs and scripts can’t be attached.')
      const { data } = await app.engine.snapshot(id)
      if (!data.tasks[taskId]) throw new HttpError(404, 'That task no longer exists.')

      const owner = await boardOwner(app.db, id)
      const own = owner ? await activeBackend(app.db, owner) : null
      if (!own && owner) {
        const used = await quotaUsed(app.db, owner)
        if (used + body.length > quotaMb * MB) {
          const mine = owner === me.id
          throw new HttpError(
            413,
            mine
              ? `This would go over your ${quotaMb} MB of file space (${formatMb(used)} used). Delete some files, or connect your own storage in Account settings.`
              : `The board’s owner is out of file space (${quotaMb} MB). Ask them to free some up or connect their own storage.`,
          )
        }
      }
      const platform = own ? null : await activeBackend(app.db, null)
      const backendRow = own ?? platform
      const attId = newId()
      const storageKey = `boards/${id}/${attId}/${name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'file'}`
      const mime = mimeOf(req.headers['x-file-type'] as string | undefined)
      try {
        await (backendRow ? s3For(backendRow) : disk).put(storageKey, body, mime)
      } catch (e) {
        if (backendRow)
          await app.db
            .update(storageBackends)
            .set({ lastError: e instanceof Error ? e.message : 'Upload failed' })
            .where(eq(storageBackends.id, backendRow.id))
        req.log.warn({ err: e instanceof Error ? e.message : e }, 'upload failed')
        throw new HttpError(502, `The file couldn’t be saved${e instanceof StorageError ? `: ${e.message}` : '.'}`)
      }
      await app.db.insert(attachments).values({
        id: attId,
        boardId: id,
        taskId,
        uploaderId: me.id,
        ownerId: owner,
        backend: backendRow ? 's3' : 'disk',
        backendId: backendRow?.id ?? null,
        ownStorage: !!own,
        storageKey,
        name,
        size: body.length,
        mime,
        draft: forComment,
      })
      const [attachment] = await views(app.db, and(eq(attachments.id, attId)))
      // A comment's files are announced with the comment.
      if (!forComment) app.hub.broadcast(id, { type: 'attachment', taskId, action: 'added', attachmentId: attId, attachment })
      return { attachment }
    },
  )

  /** Opens (pictures) or downloads (everything else) a file, for anyone who can view its board. */
  app.get('/attachments/:attId', async (req, reply) => {
    const { attId } = parse(z.object({ attId: z.uuid() }), req.params)
    const [a] = await app.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attId), isNull(attachments.deletedAt)))
    // A file for a comment that isn't posted yet is only its uploader's.
    if (!a || (a.draft && a.uploaderId !== req.user?.id)) throw new HttpError(404, 'That file no longer exists.')
    await requireAccess(app.db, req.user, a.boardId, 'viewer')
    const inline = IMAGE_TYPES.has(a.mime)
    const type = inline ? a.mime : 'application/octet-stream'
    const store = await storeOf(app.db, a)
    if (store instanceof S3Store) return reply.redirect(await store.signedUrl(a.storageKey, { name: a.name, mime: type, inline }), 302)
    const file = await (store as DiskStore).open(a.storageKey)
    if (!file) throw new HttpError(404, 'That file is missing from storage.')
    return reply
      .header('content-type', type)
      .header('content-length', file.size)
      .header('content-disposition', contentDisposition(a.name, inline))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; img-src 'self'; sandbox")
      .header('cache-control', 'private, max-age=300')
      .send(file.stream)
  })

  /** Moves a file to the trash (editors and owners). */
  app.delete('/boards/:id/attachments/:attId', async (req) => {
    const { id, attId } = parse(AttParams, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'editor')
    const [a] = await app.db
      .update(attachments)
      .set({ deletedAt: new Date() })
      .where(and(eq(attachments.id, attId), eq(attachments.boardId, id), isNull(attachments.deletedAt)))
      .returning()
    if (!a) throw new HttpError(404, 'That file no longer exists.')
    app.hub.broadcast(id, { type: 'attachment', taskId: a.taskId, action: 'deleted', attachmentId: attId })
    return { ok: true }
  })

  /** Takes a file back out of the trash (undo). */
  app.post('/boards/:id/attachments/:attId/restore', async (req) => {
    const { id, attId } = parse(AttParams, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'editor')
    const [a] = await app.db
      .update(attachments)
      .set({ deletedAt: null, orphaned: false })
      .where(and(eq(attachments.id, attId), eq(attachments.boardId, id), isNotNull(attachments.deletedAt)))
      .returning()
    if (!a) throw new HttpError(404, 'That file can’t be restored any more.')
    const [attachment] = await views(app.db, and(eq(attachments.id, attId)))
    app.hub.broadcast(id, { type: 'attachment', taskId: a.taskId, action: 'added', attachmentId: attId, attachment })
    return { attachment }
  })

  // ── Storage settings ────────────────────────────────────────────────────

  const admin = (user: SessionUser | null) => {
    const me = requireUser(user)
    if (!me.isAdmin) throw new HttpError(403, 'Only platform admins can do that.')
    return me
  }

  app.get('/admin/storage', async (req): Promise<PlatformStorage> => {
    admin(req.user)
    const [u] = await app.db.execute<{ bytes: string; files: number }>(
      sql`select coalesce(sum(size), 0)::bigint as bytes, count(*)::int as files from ${attachments} where deleted_at is null`,
    )
    const [{ n }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(storageBackends)
      .where(and(isNotNull(storageBackends.userId), isNull(storageBackends.retiredAt)))
    return {
      encryptionReady: encryptionReady(),
      bucket: bucketView(await activeBackend(app.db, null)),
      settings: await storageSettings(app.db),
      usage: { bytes: Number(u.bytes), files: u.files, ownStorage: n },
    }
  })

  app.put('/admin/storage/bucket', async (req) => {
    const me = admin(req.user)
    return bucketView(await saveBucket(app.db, me.id, null, BucketInput.parse(parse(Bucket, req.body), null)))
  })

  app.delete('/admin/storage/bucket', async (req) => {
    admin(req.user)
    await retireBucket(app.db, null)
    return { ok: true }
  })

  app.patch('/admin/storage/settings', async (req) => {
    admin(req.user)
    const b = parse(z.object({ quotaMb: z.number().int().min(0).max(1_000_000), maxFileMb: z.number().int().min(1).max(200) }).partial(), req.body)
    const set = {
      ...(b.quotaMb !== undefined && { storageQuotaMb: b.quotaMb }),
      ...(b.maxFileMb !== undefined && { maxFileMb: b.maxFileMb }),
    }
    await app.db
      .insert(siteSettings)
      .values({ id: 1, ...set })
      .onConflictDoUpdate({ target: siteSettings.id, set })
    return { ok: true }
  })

  app.get('/account/storage', async (req): Promise<AccountStorage> => {
    const me = requireUser(req.user)
    const { quotaMb, maxFileMb } = await storageSettings(app.db)
    return {
      encryptionReady: encryptionReady(),
      bucket: bucketView(await activeBackend(app.db, me.id)),
      used: await quotaUsed(app.db, me.id),
      quota: quotaMb * MB,
      maxFile: maxFileMb * MB,
    }
  })

  app.put('/account/storage/bucket', async (req) => {
    const me = requireUser(req.user)
    return bucketView(await saveBucket(app.db, me.id, me.id, BucketInput.parse(parse(Bucket, req.body), me.id)))
  })

  app.delete('/account/storage/bucket', async (req) => {
    const me = requireUser(req.user)
    await retireBucket(app.db, me.id)
    return { ok: true }
  })
}
