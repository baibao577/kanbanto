import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db, Tx } from './db'
import { accountPictures, users } from './db/schema'

/** How big a profile picture can be. The app shrinks one to 256 × 256 before sending it, which is a tenth of this. */
export const PICTURE_MAX = 256 * 1024
/** …and in pixels a side: four times what the app sends. */
export const PICTURE_SIDE_MAX = 1024
/** The kinds a profile picture can be (what a browser's canvas writes). */
export const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** Where a person's picture is, from `users.picture`: what's sent beside their name. Null: they have none. */
export const pictureUrl = (key: string | null | undefined) => (key ? `/api/pictures/${key}` : null)

/** Gives `userId` this picture in place of the one they had. Its key is new, so the old link stops working. */
export async function savePicture(tx: Tx, userId: string, mime: string, bytes: Buffer) {
  const key = randomBytes(16).toString('base64url')
  await tx.delete(accountPictures).where(eq(accountPictures.userId, userId))
  await tx.insert(accountPictures).values({ key, userId, mime, bytes })
  await tx.update(users).set({ picture: key, updatedAt: new Date() }).where(eq(users.id, userId))
  return key
}

export async function removePicture(tx: Tx, userId: string) {
  await tx.delete(accountPictures).where(eq(accountPictures.userId, userId))
  await tx.update(users).set({ picture: null, updatedAt: new Date() }).where(eq(users.id, userId))
}

export async function readPicture(db: Db | Tx, key: string) {
  const [row] = await db
    .select({ mime: accountPictures.mime, bytes: accountPictures.bytes })
    .from(accountPictures)
    .where(eq(accountPictures.key, key))
  return row ?? null
}
