import { and, eq } from 'drizzle-orm'
import type { SessionUser } from '../auth/sessions'
import type { Db, Tx } from '../db'
import { boardMembers, boards, workspaceMembers, type Role, type WorkspaceRole } from '../db/schema'
import { HttpError } from '../http'

export type BoardRow = typeof boards.$inferSelect

/** What someone can do on a board, and why: added to it, through its workspace, or with its public link. */
export interface Access {
  role: Role
  via: 'member' | 'workspace' | 'public'
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 }
export const atLeast = (role: Role, needed: Role) => RANK[role] >= RANK[needed]
export const higherRole = (a: Role, b: Role) => (RANK[a] >= RANK[b] ? a : b)

/**
 * The rules:
 * - Owners always have access. A private board: nobody else.
 * - Otherwise its members, with their role; and when it's shared with its workspace, everyone in the workspace, with
 *   the board's workspace role. Someone who is both gets the higher of the two.
 * - With the public link on, anyone (even signed out) can view it.
 * Platform admins get no special access, and neither do workspace admins: people's boards are their own.
 */
export function accessFor(board: BoardRow, memberRole: Role | null, inWorkspace: boolean): Access | null {
  if (memberRole === 'owner') return { role: 'owner', via: 'member' }
  if (board.visibility === 'private') return null
  const viaWorkspace = inWorkspace && board.visibility === 'workspace' && board.workspaceId ? board.workspaceRole : null
  if (memberRole && (!viaWorkspace || atLeast(memberRole, viaWorkspace))) return { role: memberRole, via: 'member' }
  if (viaWorkspace) return { role: viaWorkspace, via: 'workspace' }
  if (board.publicLink) return { role: 'viewer', via: 'public' }
  return null
}

export async function memberRole(tx: Db | Tx, boardId: string, userId: string | undefined): Promise<Role | null> {
  if (!userId) return null
  const [m] = await tx
    .select({ role: boardMembers.role })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
  return m?.role ?? null
}

export async function workspaceRole(tx: Db | Tx, workspaceId: string | null, userId: string | undefined): Promise<WorkspaceRole | null> {
  if (!userId || !workspaceId) return null
  const [m] = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
  return m?.role ?? null
}

/** What `userId` (or a signed-out visitor) can do on `board`. */
export async function accessOf(tx: Db | Tx, board: BoardRow, userId: string | undefined): Promise<Access | null> {
  const inWorkspace = board.visibility === 'workspace' && !!(await workspaceRole(tx, board.workspaceId, userId))
  return accessFor(board, await memberRole(tx, board.id, userId), inWorkspace)
}

/**
 * Loads a board and checks the person may do at least `needed` on it.
 * Signed out and no access: 401 (so the app can offer to sign in). Signed in and no access: 404, the same as a
 * board that doesn't exist, so private boards can't be discovered. Enough to view but not to edit: 403.
 */
export async function requireAccess(
  tx: Db | Tx,
  user: SessionUser | null,
  boardId: string,
  needed: Role,
  /**
   * write: a change even a viewer may make (comments). archived: allowed on an archived board too (restoring or
   * deleting it); anything else that changes an archived board is refused.
   */
  opts: { write?: boolean; archived?: boolean } = {},
) {
  if (user?.mustVerify) throw new HttpError(403, 'Confirm your email address first: check your inbox for the link.', 'verify-email')
  const [board] = await tx.select().from(boards).where(eq(boards.id, boardId))
  const access = board ? await accessOf(tx, board, user?.id) : null
  if (!board || !access) {
    if (!user) throw new HttpError(401, 'Sign in to open this board.')
    throw new HttpError(404, 'This board doesn’t exist, or you don’t have access to it.')
  }
  if (!atLeast(access.role, needed))
    throw new HttpError(403, needed === 'owner' ? 'Only the board’s owners can do that.' : 'You can view this board, but not change it.')
  if (board.archivedAt && (needed !== 'viewer' || opts.write) && !opts.archived)
    throw new HttpError(403, 'This board is archived. Restore it to make changes.', 'archived')
  return { board, access }
}
