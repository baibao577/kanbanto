import { newId } from '@kanbanto/model/ids'
import type { StorageBucket } from '@kanbanto/model/api'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
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
 * - Changing storage never moves or breaks existing files: each file remembers where it was saved, and replaced
 *   storage settings are retired, not overwritten.
 */

export const disk = new DiskStore(env.uploadsDir)

type BackendRow = typeof storageBackends.$inferSelect

export async function activeBackend(db: Db | Tx, userId: string | null) {
  const [row] = await db
    .select()
    .from(storageBackends)
    .where(and(userId ? eq(storageBackends.userId, userId) : isNull(storageBackends.userId), isNull(storageBackends.retiredAt)))
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

/**
 * Tests a bucket (writes and removes a small file), then saves it for `owner` (null = the platform). The secret is
 * encrypted. A different bucket retires the old setting (its files keep opening from it); new keys for the same
 * bucket just replace the keys.
 */
export async function saveBucket(db: Db, meId: string, owner: string | null, input: ReturnType<typeof BucketInput.parse>) {
  if (!encryptionReady()) throw new HttpError(503, 'Keys can’t be saved until the server has an encryption key. Restart Kanbanto to make one.')
  const current = await activeBackend(db, owner)
  const sameBucket = current && current.endpoint === input.endpoint && current.bucket === input.bucket
  const secret = input.secret || (sameBucket && current.accessKeyId === input.accessKeyId ? decrypt(current.secretEncrypted) : '')
  if (!secret) throw new HttpError(400, 'Paste the secret access key.')
  const config: S3Config = { ...input, secret }
  try {
    await new S3Store(config, { publicOnly: restricted(owner) }).check()
  } catch (e) {
    throw new HttpError(400, `The storage test failed: ${e instanceof StorageError ? e.message : 'unknown error'}`)
  }
  const values = {
    kind: 's3' as const,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretEncrypted: encrypt(secret),
    keyHint: `…${secret.slice(-4)}`,
    lastError: null,
    updatedBy: meId,
    updatedAt: new Date(),
  }
  return db.transaction(async (tx) => {
    if (current && sameBucket) {
      const [row] = await tx.update(storageBackends).set(values).where(eq(storageBackends.id, current.id)).returning()
      return row
    }
    if (current) await tx.update(storageBackends).set({ retiredAt: new Date() }).where(eq(storageBackends.id, current.id))
    const [row] = await tx
      .insert(storageBackends)
      .values({ id: newId(), userId: owner, ...values })
      .returning()
    return row
  })
}

/** Stops using a bucket for new files (existing files keep opening from it). */
export async function retireBucket(db: Db, owner: string | null) {
  await db
    .update(storageBackends)
    .set({ retiredAt: new Date() })
    .where(and(owner ? eq(storageBackends.userId, owner) : isNull(storageBackends.userId), isNull(storageBackends.retiredAt)))
}
