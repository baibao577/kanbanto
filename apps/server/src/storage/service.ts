import { newId } from '@kanbanto/model/ids'
import type { StorageBucket, StoragePlace } from '@kanbanto/model/api'
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { decrypt, encrypt, encryptionReady } from '../crypto'
import type { Db, Tx } from '../db'
import { attachments, boardMembers, storageBackends } from '../db/schema'
import { env } from '../env'
import { HttpError } from '../http'
import { loadSettings } from '../settings'
import { assertPublicEndpoint, PrivateAddressError } from './egress'
import { DiskStore, S3Store, StorageError, type S3Config } from './stores'

/**
 * Where files go and how much space people have.
 * - Each board's files count against its owner. If the owner connected their own bucket, files go there (no limit);
 *   otherwise they go to the site's storage (the server's disk, or the bucket the platform admin set up), within
 *   the per-owner quota.
 * - A board in a workspace: its files count against the workspace (which gets the same quota as a person), in the
 *   site's storage.
 * - Changing storage never breaks existing files, and doesn't move them by itself: each file remembers where it was
 *   saved, and replaced storage settings are retired, not overwritten. Saving a bucket that was used before brings its
 *   setting back; files kept elsewhere can be moved to the storage in use (move.ts).
 */

export const disk = new DiskStore(env.uploadsDir)

type BackendRow = typeof storageBackends.$inferSelect

/** Whose storage settings: a person's own buckets, or (null) the platform's. */
const ownedBy = (owner: string | null) => (owner ? eq(storageBackends.userId, owner) : isNull(storageBackends.userId))

export async function activeBackend(db: Db | Tx, userId: string | null) {
  const [row] = await db
    .select()
    .from(storageBackends)
    .where(and(ownedBy(userId), isNull(storageBackends.retiredAt)))
  return row ?? null
}

/** Someone's own storage may only be on the public internet; the platform's (set by its admins) may be anywhere. */
const restricted = (owner: string | null) => owner !== null && !env.allowPrivateBuckets

export const s3For = (row: BackendRow) =>
  new S3Store(
    { endpoint: row.endpoint, region: row.region, bucket: row.bucket, accessKeyId: row.accessKeyId, secret: decrypt(row.secretEncrypted) },
    { publicOnly: restricted(row.userId) },
  )

export const bucketView = (row: BackendRow | null): StorageBucket | null =>
  row && {
    id: row.id,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.accessKeyId,
    keyHint: row.keyHint,
    lastError: row.lastError,
    updatedAt: row.updatedAt.toISOString(),
  }

export async function storageSettings(db: Db | Tx) {
  const s = await loadSettings(db)
  return { quotaMb: s.storageQuotaMb, maxFileMb: s.maxFileMb }
}

/** The board's owner (the first one, if there are several): its files count against them. */
export async function boardOwner(db: Db | Tx, boardId: string) {
  const [row] = await db
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.role, 'owner')))
    .orderBy(asc(boardMembers.createdAt))
    .limit(1)
  return row?.userId ?? null
}

/** Whose space a board's files count against: its workspace's, or its owner's. */
export type Payer = { workspaceId: string } | { ownerId: string }

/**
 * Bytes a person (their Personal boards) or a workspace uses in the site's storage. Files in the trash don't count,
 * and neither do files waiting in comments nobody has posted yet (they count when posted; each person may only have
 * a few waiting).
 */
export async function quotaUsed(db: Db | Tx, payer: Payer) {
  const whose = 'workspaceId' in payer ? eq(attachments.workspaceId, payer.workspaceId) : eq(attachments.ownerId, payer.ownerId)
  const [{ n }] = await db
    .select({ n: sql<number>`coalesce(sum(${attachments.size}), 0)::bigint` })
    .from(attachments)
    .where(and(whose, eq(attachments.ownStorage, false), isNull(attachments.deletedAt), eq(attachments.draft, false)))
  return Number(n)
}

/** The store a saved file lives in. */
export async function storeOf(db: Db | Tx, att: { backend: 'disk' | 's3'; backendId: string | null }) {
  if (att.backend === 'disk') return disk
  const [row] = att.backendId ? await db.select().from(storageBackends).where(eq(storageBackends.id, att.backendId)) : []
  if (!row) throw new HttpError(410, 'This file’s storage has been removed.')
  return s3For(row)
}

export const BucketInput = {
  /** Checks a bucket setting for `owner` (null = the platform). */
  parse(b: { endpoint: string; region?: string; bucket: string; accessKeyId: string; secret?: string }, owner: string | null) {
    let endpoint: URL
    try {
      endpoint = new URL(b.endpoint.trim())
    } catch {
      throw new HttpError(400, 'Enter the storage’s endpoint address, like https://<account>.r2.cloudflarestorage.com.')
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new HttpError(400, 'The endpoint address must start with https://.')
    if (restricted(owner)) {
      if (endpoint.protocol !== 'https:') throw new HttpError(400, 'The endpoint address must start with https://.')
      try {
        assertPublicEndpoint(endpoint.origin)
      } catch (e) {
        if (e instanceof PrivateAddressError)
          throw new HttpError(400, `That address can’t be used: ${e.message}. Your own storage must be on the public internet.`)
        throw e
      }
    }
    return {
      endpoint: endpoint.origin,
      region: b.region?.trim() || 'auto',
      bucket: b.bucket.trim(),
      accessKeyId: b.accessKeyId.trim(),
      secret: b.secret?.trim(),
    }
  },
}

/** A saved secret, or '' if it can't be read any more (the encryption key changed). */
function savedSecret(row: BackendRow) {
  try {
    return decrypt(row.secretEncrypted)
  } catch {
    return ''
  }
}

/** Checks a bucket works with these keys (writes and removes a small file). */
async function testBucket(config: S3Config, owner: string | null) {
  try {
    await new S3Store(config, { publicOnly: restricted(owner) }).check()
  } catch (e) {
    throw new HttpError(400, `The storage test failed: ${e instanceof StorageError ? e.message : 'unknown error'}`)
  }
}

const keyValues = (meId: string, accessKeyId: string, secret: string) => ({
  accessKeyId,
  secretEncrypted: encrypt(secret),
  keyHint: `…${secret.slice(-4)}`,
  lastError: null,
  updatedBy: meId,
  updatedAt: new Date(),
})

const NO_KEY = 'Keys can’t be saved until the server has an encryption key. Restart Kanbanto to make one.'

/**
 * Tests a bucket, then saves it for `owner` (null = the platform) as where new files go. The secret is encrypted.
 * A bucket this owner has used before (the one in use, or one retired earlier) keeps its setting, with the keys given
 * now: the files already in it open with them too, so switching back and forth never leaves old keys behind. Any
 * other bucket in use is retired (its files keep opening from it).
 */
export async function saveBucket(db: Db, meId: string, owner: string | null, input: ReturnType<typeof BucketInput.parse>) {
  if (!encryptionReady()) throw new HttpError(503, NO_KEY)
  const current = await activeBackend(db, owner)
  const known = await db
    .select()
    .from(storageBackends)
    .where(and(ownedBy(owner), eq(storageBackends.endpoint, input.endpoint), eq(storageBackends.bucket, input.bucket)))
    .orderBy(desc(storageBackends.updatedAt))
  const keep = known.find((r) => !r.retiredAt) ?? known[0]
  const sameKey = known.find((r) => r.accessKeyId === input.accessKeyId)
  const secret = input.secret || (sameKey ? savedSecret(sameKey) : '')
  if (!secret) throw new HttpError(400, 'Paste the secret access key.')
  await testBucket({ ...input, secret }, owner)
  const values = {
    kind: 's3' as const,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    ...keyValues(meId, input.accessKeyId, secret),
  }
  return db.transaction(async (tx) => {
    if (current && current.id !== keep?.id) await tx.update(storageBackends).set({ retiredAt: new Date() }).where(eq(storageBackends.id, current.id))
    if (!keep) {
      const [row] = await tx
        .insert(storageBackends)
        .values({ id: newId(), userId: owner, ...values })
        .returning()
      return row
    }
    // Left from before a bucket's setting was brought back: the same bucket saved more than once. One is enough.
    const twins = known.filter((r) => r.id !== keep.id).map((r) => r.id)
    if (twins.length) {
      await tx.update(attachments).set({ backendId: keep.id }).where(inArray(attachments.backendId, twins))
      await tx.delete(storageBackends).where(inArray(storageBackends.id, twins))
    }
    const [row] = await tx
      .update(storageBackends)
      .set({ ...values, retiredAt: null })
      .where(eq(storageBackends.id, keep.id))
      .returning()
    return row
  })
}

/**
 * New keys for a bucket used earlier (after changing them at the provider), so the files still in it open again.
 * Tested first; the bucket stays retired.
 */
export async function saveBucketKeys(db: Db, meId: string, owner: string | null, backendId: string, keys: { accessKeyId: string; secret: string }) {
  if (!encryptionReady()) throw new HttpError(503, NO_KEY)
  const [found] = await db
    .select()
    .from(storageBackends)
    .where(and(eq(storageBackends.id, backendId), ownedBy(owner)))
  if (!found) throw new HttpError(404, 'That bucket is no longer here.')
  await testBucket({ endpoint: found.endpoint, region: found.region, bucket: found.bucket, ...keys }, owner)
  const [row] = await db
    .update(storageBackends)
    .set(keyValues(meId, keys.accessKeyId, keys.secret))
    .where(eq(storageBackends.id, found.id))
    .returning()
  return row
}

/** Stops using a bucket for new files (existing files keep opening from it). */
export async function retireBucket(db: Db, owner: string | null) {
  await db
    .update(storageBackends)
    .set({ retiredAt: new Date() })
    .where(and(ownedBy(owner), isNull(storageBackends.retiredAt)))
}

const counts = {
  files: sql<number>`count(*)::int`,
  bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::bigint`,
}

/**
 * Where files are kept other than where new ones go now, for the site (`owner` null: everything in the site's storage)
 * or a person (their own buckets, and with a bucket connected, their Personal boards' files in the site's storage).
 * Each place's files can be moved to the storage in use.
 */
export async function storagePlaces(db: Db | Tx, owner: string | null): Promise<StoragePlace[]> {
  const current = await activeBackend(db, owner)
  const places: StoragePlace[] = []
  if (current) {
    const [here] = await db
      .select(counts)
      .from(attachments)
      .where(placeFiles(owner, owner ? 'site' : 'disk'))
    if (here.files)
      places.push({ id: owner ? 'site' : 'disk', kind: owner ? 'site' : 'disk', bucket: null, files: here.files, bytes: Number(here.bytes) })
  }
  const earlier = await db
    .select({ row: storageBackends, ...counts })
    .from(attachments)
    .innerJoin(storageBackends, eq(storageBackends.id, attachments.backendId))
    .where(and(ownedBy(owner), isNotNull(storageBackends.retiredAt), eq(attachments.backend, 's3'), eq(attachments.ownStorage, owner !== null)))
    .groupBy(storageBackends.id)
    .orderBy(desc(storageBackends.retiredAt))
  for (const e of earlier) places.push({ id: e.row.id, kind: 'bucket', bucket: bucketView(e.row), files: e.files, bytes: Number(e.bytes) })
  return places
}

/** The files in one of `storagePlaces`: 'disk' (the site's), 'site' (a person's files in the site's storage), or a bucket's id. */
export function placeFiles(owner: string | null, placeId: string) {
  if (placeId === 'disk') return and(eq(attachments.backend, 'disk'), eq(attachments.ownStorage, false))
  // (Someone's files on the site's storage: those of boards they still own. Uploaded while they owned a board they
  // have since left, a file stays with the board.)
  if (placeId === 'site')
    return and(
      eq(attachments.ownerId, owner ?? ''),
      isNull(attachments.workspaceId),
      eq(attachments.ownStorage, false),
      owner
        ? sql`exists (select 1 from ${boardMembers} m where m.board_id = ${attachments.boardId} and m.user_id = ${owner} and m.role = 'owner')`
        : undefined,
    )
  return and(eq(attachments.backend, 's3'), eq(attachments.backendId, placeId), eq(attachments.ownStorage, owner !== null))
}

/** Forgets buckets retired a while ago that hold no files any more (their keys go with them). */
export async function forgetEmptyBuckets(db: Db | Tx) {
  await db
    .delete(storageBackends)
    .where(
      and(
        sql`${storageBackends.retiredAt} < now() - interval '1 hour'`,
        sql`not exists (select 1 from ${attachments} a where a.backend_id = ${storageBackends.id})`,
      ),
    )
}
