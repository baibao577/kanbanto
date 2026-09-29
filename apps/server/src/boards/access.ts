import { and, eq } from 'drizzle-orm'
import type { SessionUser } from '../auth/sessions'
import type { Tx } from '../db'
import { boardMembers, boards, type Role } from '../db/schema'
import { HttpError } from '../http'

export type BoardRow = typeof boards.$inferSelect

/** What someone can do on a board, and why. */
export interface Access {
  role: Role
  /** member: invited · public: a public board, viewing only. */
  via: 'member' | 'public'
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 }
export const atLeast = (role: Role, needed: Role) => RANK[role] >= RANK[needed]
export const higherRole = (a: Role, b: Role) => (RANK[a] >= RANK[b] ? a : b)

/**
 * The rules:
 * - Owners always have access. Other members only while the board isn't private.
 * - Anyone (even signed out) can view a public board.
 * Platform admins get no special access: people's boards are their own. (`user` is here for future rules.)
 */
export function accessFor(_user: SessionUser | null, board: BoardRow, memberRole: Role | null): Access | null {
  if (memberRole === 'owner') return { role: 'owner', via: 'member' }
  if (memberRole && board.visibility !== 'private') return { role: memberRole, via: 'member' }
  if (board.visibility === 'public') return { role: 'viewer', via: 'public' }
  return null
}

export async function memberRole(tx: Tx, boardId: string, userId: string | undefined): Promise<Role | null> {
  if (!userId) return null
  const [m] = await tx
    .select({ role: boardMembers.role })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
  return m?.role ?? null
}

/**
 * Loads a board and checks the person may do at least `needed` on it.
 * Signed out and no access: 401 (so the app can offer to sign in). Signed in and no access: 404, the same as a
 * board that doesn't exist, so private boards can't be discovered. Enough to view but not to edit: 403.
 */
export async function requireAccess(tx: Tx, user: SessionUser | null, boardId: string, needed: Role) {
  if (user?.mustVerify) throw new HttpError(403, 'Confirm your email address first: check your inbox for the link.', 'verify-email')
  const [board] = await tx.select().from(boards).where(eq(boards.id, boardId))
  const access = board ? accessFor(user, board, await memberRole(tx, boardId, user?.id)) : null
  if (!board || !access) {
    if (!user) throw new HttpError(401, 'Sign in to open this board.')
    throw new HttpError(404, 'This board doesn’t exist, or you don’t have access to it.')
  }
  if (!atLeast(access.role, needed))
    throw new HttpError(403, needed === 'owner' ? 'Only the board’s owners can do that.' : 'You can view this board, but not change it.')
  return { board, access }
}
