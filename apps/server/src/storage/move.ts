import { randomUUID } from 'node:crypto'
import type { StorageMove } from '@kanbanto/model/api'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { attachments, storageBackends } from '../db/schema'
import { loggable } from '../errors'
import { HttpError } from '../http'
import { activeBackend, disk, placeFiles, quotaUsed, s3For, storagePlaces, storageSettings, storeOf } from './service'
import { S3Store, StorageError } from './stores'

/**
 * Moving files to the storage in use: from the server's disk, the site's storage, or a bucket used earlier.
 * - One move at a time for the site (`owner` null) and for each person. Progress is kept in memory only.
 * - Each file is copied, then its record is switched, then the old copy is removed. Stopping part-way (or a restart)
 *   loses nothing: what's left is still listed as kept elsewhere, and can be moved again.
 * - Two settings can be one and the same bucket (its address changed, or its server has two names). Then nothing is
 *   copied and, above all, nothing is removed: "the old copy" would be the only one. See `sameBucket`.
 * - A person's files go to their own bucket, except on boards now in a workspace (always the site's storage). Files
 *   coming into the site's storage must fit in the space of whoever they count against.
 */

type Job = StorageMove & { stop: boolean }
const jobs = new Map<string, Job>()
const keyOf = (owner: string | null) => owner ?? 'site'
const view = ({ stop: _stop, ...status }: Job): StorageMove => status

const MB = 1024 * 1024
/** Keys or a bucket that stopped working fail every file the same way: no point trying thousands. */
const MAX_FAILS_IN_A_ROW = 5

export function moveStatus(owner: string | null) {
  const job = jobs.get(keyOf(owner))
  return job ? view(job) : null
}

export function stopMove(owner: string | null) {
  const job = jobs.get(keyOf(owner))
  if (job) job.stop = true
}

/** When the server stops: moves end after the file they're on. */
export function stopMoves() {
  for (const job of jobs.values()) job.stop = true
}

/** Starts moving a place's files (one of `storagePlaces`) to the storage in use. Returns at once; the move goes on. */
export async function startMove(app: FastifyInstance, owner: string | null, placeId: string): Promise<StorageMove> {
  const key = keyOf(owner)
  const before = jobs.get(key)
  if (before?.running) throw new HttpError(409, 'Files are already being moved. Wait for that to finish.')
  const job: Job = { running: true, total: 0, moved: 0, failed: 0, noSpace: 0, lastError: null, stop: false }
  jobs.set(key, job)
  let ids: string[]
  try {
    if (!(await storagePlaces(app.db, owner)).some((p) => p.id === placeId)) throw new HttpError(404, 'There are no files to move from there.')
    const rows = await app.db.select({ id: attachments.id }).from(attachments).where(placeFiles(owner, placeId)).orderBy(attachments.createdAt)
    ids = rows.map((r) => r.id)
  } catch (e) {
    if (before) jobs.set(key, before)
    else jobs.delete(key)
    throw e
  }
  job.total = ids.length
  void run(app, owner, placeId, ids, job)
    .catch((e) => {
      job.lastError = 'Something went wrong while moving files.'
      app.log.error({ err: loggable(e) }, 'moving files')
    })
    .finally(() => {
      job.running = false
    })
  return view(job)
}

/**
 * Whether two bucket settings reach one and the same bucket. The same address and name, plainly; and otherwise it's
 * tried: a mark written through one is looked for through the other. (Saving a bucket again under another address,
 * an inside name and then the public one, makes two settings of one bucket: moving "from the old one" used to copy
 * each file onto itself and then delete it as the old copy.) When it can't be told, because the old address doesn't
 * answer, it counts as two: the file can't be read from there either, so nothing is moved or removed.
 */
async function sameBucket(source: S3Store, dest: S3Store): Promise<boolean> {
  if (source.base === dest.base) return true
  const mark = `.kanbanto-same-${randomUUID()}`
  try {
    await dest.put(mark, Buffer.from('?'), 'text/plain')
    return !!(await source.get(mark))
  } catch {
    return false
  } finally {
    await dest.delete(mark).catch(() => {})
  }
}

async function run(app: FastifyInstance, owner: string | null, placeId: string, ids: string[], job: Job) {
  const db = app.db
  /** Asked once for each pair of settings in a move, not for every file. */
  const sameAs = new Map<string, Promise<boolean>>()
  const oneBucket = (source: S3Store, dest: S3Store) => {
    const pair = `${source.base} ${dest.base}`
    if (!sameAs.has(pair)) sameAs.set(pair, sameBucket(source, dest))
    return sameAs.get(pair)!
  }
  const own = owner ? await activeBackend(db, owner) : null
  const platform = await activeBackend(db, null)
  const { quotaMb } = await storageSettings(db)
  let failsInARow = 0
  for (const id of ids) {
    if (job.stop || failsInARow >= MAX_FAILS_IN_A_ROW) break
    const [a] = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), placeFiles(owner, placeId)))
    // Removed, or moved by someone else (the site's admin and a board's owner can both move a file), since this began.
    if (!a) {
      job.total--
      continue
    }
    const toOwn = !!own && !a.workspaceId
    const target = toOwn ? own : platform
    const leavesOwn = a.ownStorage && !toOwn
    if (leavesOwn && !a.deletedAt && !a.draft) {
      const payer = a.workspaceId ? { workspaceId: a.workspaceId } : a.ownerId ? { ownerId: a.ownerId } : null
      if (payer && (await quotaUsed(db, payer)) + a.size > quotaMb * MB) {
        job.noSpace++
        continue
      }
    }
    // Whose storage a problem is about: the source's until the file is read, then the target's.
    let blame = a.backendId
    try {
      const source = await storeOf(db, a)
      const dest = target ? s3For(target) : disk
      // The same bucket under two settings: the file is already there, only its record changes.
      const same = source instanceof S3Store && dest instanceof S3Store && (await oneBucket(source, dest))
      if (!same) {
        const bytes = await source.get(a.storageKey)
        if (!bytes) {
          job.failed++
          job.lastError = 'A file isn’t in its storage any more.'
          continue
        }
        blame = target?.id ?? null
        await dest.put(a.storageKey, bytes, a.mime)
      }
      const [moved] = await db
        .update(attachments)
        .set({
          backend: target ? 's3' : 'disk',
          backendId: target?.id ?? null,
          ownStorage: toOwn,
          // In the site's storage, a workspace board's files count against the workspace, not a person.
          ownerId: leavesOwn && a.workspaceId ? null : a.ownerId,
        })
        .where(
          and(
            eq(attachments.id, a.id),
            eq(attachments.backend, a.backend),
            a.backendId ? eq(attachments.backendId, a.backendId) : isNull(attachments.backendId),
            eq(attachments.ownStorage, a.ownStorage),
          ),
        )
        .returning({ id: attachments.id })
      // Only one copy stays: the old one once the record points at the new, or the new one if the file went meanwhile.
      if (!same) await (moved ? source : dest).delete(a.storageKey).catch(() => {})
      if (moved) job.moved++
      else job.total--
      failsInARow = 0
    } catch (e) {
      job.failed++
      failsInARow++
      job.lastError = e instanceof StorageError || e instanceof HttpError ? e.message : 'Something went wrong while moving a file.'
      if (e instanceof StorageError && blame) await db.update(storageBackends).set({ lastError: e.message }).where(eq(storageBackends.id, blame))
      app.log.warn({ err: loggable(e), attachment: a.id }, 'moving a file')
    }
  }
}
