import { eq } from 'drizzle-orm'
import { reencryptFromDevKey } from './crypto'
import type { Db } from './db'
import { emailSenders, storageBackends } from './db/schema'

/**
 * Every encrypted secret in the database, re-encrypted with the real master key if it was saved with the public
 * development key (installs that ran on the old default). Runs at startup; cheap, since there are only a few.
 */
export async function moveSecretsOffDevKey(db: Db) {
  const senders = await db.select({ id: emailSenders.id, value: emailSenders.apiKeyEncrypted }).from(emailSenders)
  const buckets = await db.select({ id: storageBackends.id, value: storageBackends.secretEncrypted }).from(storageBackends)
  const s = reencryptFromDevKey(senders)
  const b = reencryptFromDevKey(buckets)
  await db.transaction(async (tx) => {
    for (const m of s.moved) await tx.update(emailSenders).set({ apiKeyEncrypted: m.value }).where(eq(emailSenders.id, m.id))
    for (const m of b.moved) await tx.update(storageBackends).set({ secretEncrypted: m.value }).where(eq(storageBackends.id, m.id))
  })
  return { moved: s.moved.length + b.moved.length, unreadable: s.unreadable + b.unreadable }
}
