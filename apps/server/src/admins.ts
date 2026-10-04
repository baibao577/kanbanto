import { eq } from 'drizzle-orm'
import { hashPassword, temporaryPassword } from './auth/password'
import { endAllSessions } from './auth/sessions'
import type { Db } from './db'
import { pushDevices, users } from './db/schema'

/** Makes an account a platform admin (or not). Returns false if there's no account with that email. */
export async function setPlatformAdmin(db: Db, email: string, isAdmin: boolean): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ isAdmin, updatedAt: new Date() })
    .where(eq(users.email, email.trim().toLowerCase()))
    .returning({ id: users.id })
  return updated.length > 0
}

export async function platformAdmins(db: Db) {
  return db.select({ email: users.email, name: users.name }).from(users).where(eq(users.isAdmin, true))
}

/** Sets a temporary password (and signs the account out everywhere). Returns it, or null if there's no such account. */
export async function resetPassword(db: Db, email: string): Promise<string | null> {
  const password = temporaryPassword()
  const [u] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
    .where(eq(users.email, email.trim().toLowerCase()))
    .returning({ id: users.id })
  if (!u) return null
  await endAllSessions(db, u.id)
  // (Browsers that were getting its desktop notifications stop too.)
  await db.delete(pushDevices).where(eq(pushDevices.userId, u.id))
  return password
}
