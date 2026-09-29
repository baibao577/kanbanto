import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import { emailTokens } from '../db/schema'

/** verify: confirm an address · reset: forgot password (emailed) · admin-reset: a reset link a platform admin passes on */
type Purpose = 'verify' | 'reset' | 'admin-reset'
const LIFETIME_MS: Record<Purpose, number> = { verify: 24 * 3600_000, reset: 3600_000, 'admin-reset': 24 * 3600_000 }

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** A new one-time link token for `userId` (only its hash is stored). */
export async function createEmailToken(db: Db | Tx, userId: string, purpose: Purpose, email: string) {
  const token = randomBytes(32).toString('base64url')
  await db.insert(emailTokens).values({ id: hash(token), userId, purpose, email, expiresAt: new Date(Date.now() + LIFETIME_MS[purpose]) })
  return token
}

/** Uses up a token: returns it if it's valid (right purpose, not expired, not used), else null. */
export async function useEmailToken(db: Db | Tx, token: string, purpose: Purpose | Purpose[]) {
  const [row] = await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailTokens.id, hash(token)),
        typeof purpose === 'string' ? eq(emailTokens.purpose, purpose) : inArray(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, new Date()),
      ),
    )
    .returning()
  return row ?? null
}

/** When the last token of this kind was made for this person (to limit how often emails are sent). */
export async function lastEmailToken(db: Db | Tx, userId: string, purpose: Purpose) {
  const [row] = await db
    .select({ createdAt: emailTokens.createdAt })
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)))
    .orderBy(desc(emailTokens.createdAt))
    .limit(1)
  return row?.createdAt ?? null
}
