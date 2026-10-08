import type { AccountStorage, AttachmentView, PlatformStorage } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { SessionUser } from '../auth/sessions'
import { requireAccess } from '../boards/access'
import { logLine } from '../boards/activityLog'
import { encryptionReady } from '../crypto'
import type { Db, Tx } from '../db'
import { attachments, attachmentThumbs, boards, siteSettings, storageBackends, tasks, users } from '../db/schema'
import { serial } from '../serial'
import { HttpError, parse } from '../http'
import {
  activeBackend,
  boardOwner,
  bucketView,
  BucketInput,
  disk,
  forgetEmptyBuckets,
  quotaUsed,
  retireBucket,
  s3For,
  saveBucket,
  saveBucketKeys,
  storagePlaces,
  storageSettings,
  storeOf,
} from '../storage/service'
import { moveStatus, startMove, stopMove, stopMoves } from '../storage/move'
import { contentDisposition, DiskStore, S3Store, StorageError } from '../storage/stores'
import { requireUser } from './auth'
import { thumbUrl, uncover } from './covers'

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
const BucketParams = z.object({ backendId: z.uuid() })
const Keys = z.object({
  accessKeyId: z.string().trim().min(1, 'Enter the access key ID.').max(200),
  secret: z.string().trim().min(1, 'Paste the secret access key.').max(300),
})
const Move = z.object({ place: z.string().min(1).max(40) })

const MB = 1024 * 1024
/** Uploads bigger than this are refused before being read, whatever the settings say. */
const HARD_MAX = 200 * MB
const TRASH_DAYS = 30
/** Files someone has uploaded for comments they haven't posted yet: at most this many, and this many times the largest file. */
const MAX_DRAFTS = 10
const MAX_DRAFT_FILES_OF_SPACE = 3
/** Pictures shown in the app; everything else downloads (so nothing uploaded can run as a web page). */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
/**
 * Files that run when double-clicked, refused by name. Kanbanto never runs files (they download, sandboxed), and
 * computers warn about downloaded programs; this just stops the obvious ones being passed around by accident.
 * (A zipped program isn't caught: that's for a virus scanner.)
 */
const RUNNABLE = [
  // Windows: programs, installers, scripts, shortcuts, settings
  ...[
    'exe',
    'com',
    'scr',
    'pif',
    'msi',
    'msp',
    'appx',
    'msix',
    'appinstaller',
    'bat',
    'cmd',
    'ps1',
    'vbs',
    'vbe',
    'js',
    'jse',
    'wsf',
    'wsh',
    'hta',
    'lnk',
    'reg',
    'cpl',
    'msc',
  ],
  // Mac: installers and scripts (.app is a folder, so it arrives zipped)
  ...['pkg', 'mpkg', 'command', 'terminal', 'workflow'],
  // Linux and anywhere: shell scripts and launchers (not .bin: that's often plain data)
  ...['sh', 'bash', 'run', 'desktop'],
  // Java and Android apps
  ...['jar', 'apk', 'xapk', 'aab'],
]
const BLOCKED = new RegExp(`\\.(${RUNNABLE.join('|')})$`, 'i')

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
    // (Whether it has a small copy, not the copy itself: see routes/covers.ts.)
    .select({ a: attachments, uploader: users.name, small: attachmentThumbs.attachmentId })
    .from(attachments)
    .leftJoin(users, eq(users.id, attachments.uploaderId))
    .leftJoin(attachmentThumbs, eq(attachmentThumbs.attachmentId, attachments.id))
    .where(where)
    .orderBy(attachments.createdAt)
  return rows.map(({ a, uploader, small }) => ({
    id: a.id,
    taskId: a.taskId,
    name: a.name,
    size: a.size,
    mime: a.mime,
    uploader,
    createdAt: a.createdAt.toISOString(),
    url: `/api/attachments/${a.id}`,
    image: IMAGE_TYPES.has(a.mime),
    ...(small && { thumb: thumbUrl(a.id) }),
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
 * and files in the trash for 30 days are removed for good. Buckets used earlier that hold no files any more are
 * forgotten.
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
  await forgetEmptyBuckets(app.db)
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
    .select({ size: attachments.size, ownerId: attachments.ownerId, workspaceId: attachments.workspaceId, ownStorage: attachments.ownStorage })
    .from(attachments)
    .where(mine)
  const counted = drafts.filter((d) => !d.ownStorage && (d.workspaceId || d.ownerId))
  if (counted.length) {
    const { quotaMb } = await storageSettings(db)
    const adding = counted.reduce((n, d) => n + d.size, 0)
    const { workspaceId, ownerId } = counted[0]
    if ((await quotaUsed(db, workspaceId ? { workspaceId } : { ownerId: ownerId! })) + adding > quotaMb * MB)
      throw new HttpError(
        413,
        workspaceId
          ? `The workspace is out of file space (${quotaMb} MB), so these files can’t be added. Free some up first.`
          : `The board’s owner is out of file space (${quotaMb} MB), so these files can’t be added. Ask them to free some up.`,
      )
  }
  const rows = await db.update(attachments).set({ commentId: c.commentId, draft: false }).where(mine).returning({ id: attachments.id })
  return rows.length
}

/** A deleted comment's files go to the trash. */
export async function trashCommentFiles(db: Db | Tx, commentId: string) {
  const gone = await db
    .update(attachments)
    .set({ deletedAt: new Date() })
    .where(and(eq(attachments.commentId, commentId), isNull(attachments.deletedAt)))
    .returning({ id: attachments.id })
  return gone.map((a) => a.id)
}

/** Who may put a file here: editors and owners on a card, anyone who can comment for a comment's (not a visitor with the public link). */
export async function mayUpload(db: Db | Tx, user: SessionUser | null, boardId: string, forComment: boolean) {
  const me = requireUser(user)
  const { board, access } = await requireAccess(db, me, boardId, forComment ? 'viewer' : 'editor', { write: true })
  if (forComment && access.via === 'public') throw new HttpError(403, 'Join this board to comment on it.')
  return { board, me }
}

/** The size an upload says it has, refused when it's missing or over the largest file allowed: checked before a byte is read. */
export async function declaredSize(db: Db | Tx, header: string | string[] | undefined) {
  const { maxFileMb } = await storageSettings(db)
  const size = Number(header)
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(411, 'Uploads need their size (a Content-Length header).')
  if (size > maxFileMb * MB) throw new HttpError(413, `Files can be up to ${maxFileMb} MB.`)
  return size
}

const NO_PROGRAMS = 'Programs and scripts can’t be attached. Zip it if you need to share it.'
/** Why a file of this name can't be attached, to say before anything is sent (or null). */
export const blockedName = (name: string) => (BLOCKED.test(cleanName(name)) ? NO_PROGRAMS : null)

/** What a file is, going by the end of its name, for files that arrive without anyone saying. */
const TYPES: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  ics: 'text/calendar',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
}

/** The picture a file's first bytes say it is (the kinds shown in the app), whatever its name or its sender claims. */
export function pictureType(bytes: Buffer): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  const word = (from: number, to: number) => bytes.subarray(from, to).toString('latin1')
  if (word(0, 4) === 'GIF8') return 'image/gif'
  if (word(0, 4) === 'RIFF' && word(8, 12) === 'WEBP') return 'image/webp'
  if (word(4, 8) === 'ftyp' && /^avi[fs]$/.test(word(8, 12))) return 'image/avif'
  return null
}

/**
 * The kind to keep for a file nobody vouched for (one an assistant wrote, downloaded, or sent through an upload
 * link). A stored picture type is what makes a file show in the page instead of downloading, so it's a picture
 * only when its bytes are one; anything else goes by its name.
 */
export function typeFor(name: string, bytes: Buffer): string {
  const byName = TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()]
  return pictureType(bytes) ?? (byName && !IMAGE_TYPES.has(byName) ? byName : 'application/octet-stream')
}

/**
 * A name no other file of the card has: "report.pdf" becomes "report (2).pdf". Text points at a file by its name
 * (📎report.pdf), so two of one name would make every such mark mean the newer one. Counted: the card's files, its
 * comments' files, and the uploader's own unposted ones.
 */
async function freeName(db: Db | Tx, at: { boardId: string; taskId: string; uploaderId: string }, name: string) {
  const rows = await db
    .select({ name: attachments.name })
    .from(attachments)
    .where(
      and(
        eq(attachments.boardId, at.boardId),
        eq(attachments.taskId, at.taskId),
        isNull(attachments.deletedAt),
        or(eq(attachments.draft, false), eq(attachments.uploaderId, at.uploaderId)),
      ),
    )
  const taken = new Set(rows.map((r) => r.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n++) {
    const next = `${stem.slice(0, 200 - ext.length - 8)} (${n})${ext}`
    if (!taken.has(next.toLowerCase())) return next
  }
}

/** A file to save, and for whom. */
export interface Upload {
  boardId: string
  taskId: string
  /** Who's sending it (nobody signed in: refused). */
  me: SessionUser | null
  bytes: Buffer
  name: string
  /** The kind its sender says it is. Left out: told from its name, and a picture only when its bytes are one. */
  type?: string
  /** For a comment being written: a draft, its uploader's only, until the comment is posted with it. */
  forComment?: boolean
  /** The app it came through ("Claude", "API"), for the board's activity. */
  via?: string | null
}

/**
 * Saves a file on a card: the one way in, for the app, an API token, an assistant's tools and an upload link. It
 * checks who may (again, at the moment of saving), the size, the name and the space left, gives it a name of its
 * own on the card, stores it (the board owner's own storage if they connected one, else the site's), and tells
 * everyone with the card open. A card's own file is a line in the board's activity; a comment's is told with its
 * comment. One at a time per board: each is counted before the next is checked against the space left. (So never
 * call this from inside another `serial('files:…')` of the same board, and do anything slow, like a download, first.)
 */
export function saveUpload(app: FastifyInstance, u: Upload): Promise<AttachmentView> {
  const { boardId: id, taskId, bytes: body } = u
  const forComment = !!u.forComment
  return serial(`files:${id}`, async () => {
    const { board, me } = await mayUpload(app.db, u.me, id, forComment)
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Choose a file to upload.')
    const { maxFileMb, quotaMb } = await storageSettings(app.db)
    if (body.length > maxFileMb * MB) throw new HttpError(413, `Files can be up to ${maxFileMb} MB.`)
    const cleaned = cleanName(u.name)
    if (BLOCKED.test(cleaned)) throw new HttpError(400, NO_PROGRAMS)
    const { data } = await app.engine.snapshot(id)
    const task = data.tasks[taskId]
    if (!task)
      throw new HttpError(404, data.archived?.[taskId] ? 'That task is archived. Restore it to add files to it.' : 'That task no longer exists.')

    const workspaceId = board.workspaceId
    const owner = workspaceId ? null : await boardOwner(app.db, id)
    const own = owner ? await activeBackend(app.db, owner) : null
    if (workspaceId) {
      const used = await quotaUsed(app.db, { workspaceId })
      if (used + body.length > quotaMb * MB)
        throw new HttpError(413, `This would go over the workspace’s ${quotaMb} MB of file space (${formatMb(used)} used). Delete some files first.`)
    } else if (!own && owner) {
      const used = await quotaUsed(app.db, { ownerId: owner })
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
    const name = await freeName(app.db, { boardId: id, taskId, uploaderId: me.id }, cleaned)
    const platform = own ? null : await activeBackend(app.db, null)
    const backendRow = own ?? platform
    const attId = newId()
    // (A name made only of dots would be a path step, not a file.)
    const leaf = name.replace(/[^\w.-]+/g, '_').slice(0, 80)
    const storageKey = `boards/${id}/${attId}/${/^\.*$/.test(leaf) ? 'file' : leaf}`
    const mime = u.type ?? typeFor(name, body)
    try {
      await (backendRow ? s3For(backendRow) : disk).put(storageKey, body, mime)
    } catch (e) {
      if (backendRow)
        await app.db
          .update(storageBackends)
          .set({ lastError: e instanceof Error ? e.message : 'Upload failed' })
          .where(eq(storageBackends.id, backendRow.id))
      app.log.warn({ err: e instanceof Error ? e.message : e }, 'upload failed')
      throw new HttpError(502, `The file couldn’t be saved${e instanceof StorageError ? `: ${e.message}` : '.'}`)
    }
    await app.db.insert(attachments).values({
      id: attId,
      boardId: id,
      taskId,
      uploaderId: me.id,
      ownerId: owner,
      workspaceId,
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
    // A comment's files are announced, and logged, with the comment.
    if (!forComment) {
      await logLine(app.db, {
        boardId: id,
        actorId: me.id,
        command: 'file.attach',
        via: u.via,
        item: { taskId, text: `attached “${name}” to “${task.title}”`, own: `attached “${name}”` },
      })
      await app.db.update(boards).set({ activityAt: new Date() }).where(eq(boards.id, id))
      app.hub.broadcast(id, { type: 'attachment', taskId, action: 'added', attachmentId: attId, attachment })
    }
    return attachment
  })
}

/**
 * Says in the board's log that a card's file was removed, or brought back (which is how it gets into the card's
 * history). Not for a file of a comment that was never posted, nor on a card that's gone.
 */
async function logFileLine(
  app: FastifyInstance,
  me: SessionUser,
  a: typeof attachments.$inferSelect,
  did: 'removed' | 'restored',
  via: string | null | undefined,
) {
  if (a.draft) return
  const [card] = await app.db
    .select({ title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.boardId, a.boardId), eq(tasks.id, a.taskId)))
  if (!card) return
  await logLine(app.db, {
    boardId: a.boardId,
    actorId: me.id,
    command: did === 'removed' ? 'file.remove' : 'file.restore',
    via,
    item: { taskId: a.taskId, text: `${did} “${a.name}” ${did === 'removed' ? 'from' : 'to'} “${card.title}”`, own: `${did} “${a.name}”` },
  })
  await app.db.update(boards).set({ activityAt: new Date() }).where(eq(boards.id, a.boardId))
}

/** A file that was saved for a comment which then couldn't be posted: removed for good (it was never visible). */
export async function dropDraft(db: Db | Tx, attId: string) {
  const [a] = await db
    .delete(attachments)
    .where(and(eq(attachments.id, attId), eq(attachments.draft, true)))
    .returning()
  if (a) await removeObject(db, a)
}

/**
 * A card's files, its own and the ones in its comments (not unposted drafts). A card restored with undo gets back
 * the files that went to the trash with it.
 */
export async function cardFiles(app: FastifyInstance, boardId: string, taskId: string): Promise<AttachmentView[]> {
  const { data } = await app.engine.snapshot(boardId)
  if (data.tasks[taskId])
    await app.db
      .update(attachments)
      .set({ deletedAt: null, orphaned: false })
      .where(and(eq(attachments.boardId, boardId), eq(attachments.taskId, taskId), eq(attachments.orphaned, true)))
  return views(
    app.db,
    and(eq(attachments.boardId, boardId), eq(attachments.taskId, taskId), isNull(attachments.deletedAt), eq(attachments.draft, false)),
  )
}

export const fileRoutes: FastifyPluginAsync = async (app) => {
  // Uploads arrive as raw bytes (not JSON), within this plugin only.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: HARD_MAX }, (_req, body, done) => done(null, body))
  // (Fastify reads text/plain as words by itself: here a text file is a file like any other.)
  app.removeContentTypeParser('text/plain')
  app.addContentTypeParser('text/plain', { parseAs: 'buffer', bodyLimit: HARD_MAX }, (_req, body, done) => done(null, body))
  // Only the upload route takes raw bytes (after its own checks of who's asking and how big): on the other routes
  // here a body that isn't JSON is refused before any of it is read, signed in or not.
  app.addHook('onRequest', async (req) => {
    const type = req.headers['content-type']
    if (!type || /^application\/json\b/i.test(type) || req.method === 'GET' || req.method === 'HEAD') return
    if (req.method === 'POST' && req.routeOptions.url === '/api/boards/:id/tasks/:taskId/attachments') return
    throw new HttpError(415, 'This expects JSON.')
  })

  // ── Attachments ─────────────────────────────────────────────────────────

  app.get('/boards/:id/tasks/:taskId/attachments', async (req) => {
    const { id, taskId } = parse(TaskParams, req.params)
    await requireAccess(app.db, req.user, id, 'viewer')
    return { attachments: await cardFiles(app, id, taskId) }
  })

  /**
   * Uploads a file to a card (editors and owners), or — with `x-attach-to: comment` — for a comment being written
   * (anyone who can comment, viewers included; it's a draft until the comment is posted). The body is the file's bytes, sent as application/octet-stream
   * (so nothing tries to parse it, whatever the file is); its name and type are in `x-file-name` and `x-file-type`.
   * It goes to the board owner's own storage if they connected one, else the site's storage within their quota (or,
   * for a board in a workspace, the site's storage within the workspace's).
   */
  app.post(
    '/boards/:id/tasks/:taskId/attachments',
    {
      // Everything that can be checked before reading the file is, so nobody can make the server hold a big
      // upload in memory for nothing: who's asking, the declared size, and room for drafts.
      onRequest: async (req) => {
        const { id } = parse(TaskParams, req.params)
        const forComment = req.headers['x-attach-to'] === 'comment'
        const { me } = await mayUpload(app.db, req.user, id, forComment)
        const size = await declaredSize(app.db, req.headers['content-length'])
        if (forComment) {
          const { maxFileMb } = await storageSettings(app.db)
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
      const { id, taskId } = parse(TaskParams, req.params)
      let given: string
      try {
        given = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'))
      } catch {
        throw new HttpError(400, 'That file name can’t be read.')
      }
      const attachment = await saveUpload(app, {
        boardId: id,
        taskId,
        me: req.user,
        bytes: req.body as Buffer,
        name: given,
        // (As the sender says, as it always was here: a browser knows what it's sending.)
        type: mimeOf(req.headers['x-file-type'] as string | undefined),
        forComment: req.headers['x-attach-to'] === 'comment',
        via: req.apiToken?.app,
      })
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
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'editor')
    const [a] = await app.db
      .update(attachments)
      .set({ deletedAt: new Date() })
      .where(and(eq(attachments.id, attId), eq(attachments.boardId, id), isNull(attachments.deletedAt)))
      .returning()
    if (!a) throw new HttpError(404, 'That file no longer exists.')
    await logFileLine(app, me, a, 'removed', req.apiToken?.app)
    // (A card's cover goes with its file. The answer says so: bringing the file back can make it the cover again.)
    const wasCover = !a.draft && (await uncover(app, id, a.taskId, [attId], { userId: me.id, via: req.apiToken?.app }))
    app.hub.broadcast(id, { type: 'attachment', taskId: a.taskId, action: 'deleted', attachmentId: attId })
    return { ok: true, ...(wasCover && { wasCover }) }
  })

  /** Takes a file back out of the trash (undo). */
  app.post('/boards/:id/attachments/:attId/restore', (req) =>
    serial(`files:${(req.params as { id: string }).id}`, async () => {
      const { id, attId } = parse(AttParams, req.params)
      const me = requireUser(req.user)
      await requireAccess(app.db, me, id, 'editor')
      // A file coming back takes its space again, so there has to be room for it (as for a new upload).
      const [was] = await app.db
        .select()
        .from(attachments)
        .where(and(eq(attachments.id, attId), eq(attachments.boardId, id), isNotNull(attachments.deletedAt)))
      if (was && !was.ownStorage && !was.draft && (was.workspaceId || was.ownerId)) {
        const { quotaMb } = await storageSettings(app.db)
        const used = await quotaUsed(app.db, was.workspaceId ? { workspaceId: was.workspaceId } : { ownerId: was.ownerId! })
        if (used + was.size > quotaMb * MB)
          throw new HttpError(
            413,
            `There’s no room to bring it back: ${formatMb(used)} of ${quotaMb} MB of file space is used. Delete some files first.`,
          )
      }
      const [a] = await app.db
        .update(attachments)
        .set({ deletedAt: null, orphaned: false })
        .where(and(eq(attachments.id, attId), eq(attachments.boardId, id), isNotNull(attachments.deletedAt)))
        .returning()
      if (!a) throw new HttpError(404, 'That file can’t be restored any more.')
      await logFileLine(app, me, a, 'restored', req.apiToken?.app)
      const [attachment] = await views(app.db, and(eq(attachments.id, attId)))
      app.hub.broadcast(id, { type: 'attachment', taskId: a.taskId, action: 'added', attachmentId: attId, attachment })
      return { attachment }
    }),
  )

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
      elsewhere: await storagePlaces(app.db, null),
      move: moveStatus(null),
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

  // New keys for a bucket used earlier, and moving files kept elsewhere to the storage in use.
  app.put('/admin/storage/buckets/:backendId/keys', async (req) => {
    const me = admin(req.user)
    const { backendId } = parse(BucketParams, req.params)
    return bucketView(await saveBucketKeys(app.db, me.id, null, backendId, parse(Keys, req.body)))
  })

  app.post('/admin/storage/move', async (req) => {
    admin(req.user)
    return startMove(app, null, parse(Move, req.body).place)
  })

  app.delete('/admin/storage/move', async (req) => {
    admin(req.user)
    stopMove(null)
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
      elsewhere: await storagePlaces(app.db, me.id),
      move: moveStatus(me.id),
      used: await quotaUsed(app.db, { ownerId: me.id }),
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

  app.put('/account/storage/buckets/:backendId/keys', async (req) => {
    const me = requireUser(req.user)
    const { backendId } = parse(BucketParams, req.params)
    return bucketView(await saveBucketKeys(app.db, me.id, me.id, backendId, parse(Keys, req.body)))
  })

  app.post('/account/storage/move', async (req) => {
    const me = requireUser(req.user)
    return startMove(app, me.id, parse(Move, req.body).place)
  })

  app.delete('/account/storage/move', async (req) => {
    const me = requireUser(req.user)
    stopMove(me.id)
    return { ok: true }
  })

  app.addHook('onClose', async () => stopMoves())
}
