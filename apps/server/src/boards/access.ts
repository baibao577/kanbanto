import { and, eq, sql } from 'drizzle-orm'
import type { SessionUser } from '../auth/sessions'
import type { Db, Tx } from '../db'
import { boardMembers, boards, users, workspaceMembers, type Role, type WorkspaceRole } from '../db/schema'
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
 * Whether a person may change this board's cards as things are now: an editor or an owner of a board that isn't
 * archived, whose account is on. (Asked outside a request: by a live connection that has been open a while.)
 */
export async function mayEdit(tx: Db | Tx, boardId: string, userId: string): Promise<boolean> {
  const [board] = await tx.select().from(boards).where(eq(boards.id, boardId))
  if (!board || board.archivedAt) return false
  const [u] = await tx.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  if (!u || u.disabledAt) return false
  const access = await accessOf(tx, board, userId)
  return !!access && access.via !== 'public' && atLeast(access.role, 'editor')
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

/**
 * The boards `userId` can open (theirs, ones they were added to, ones shared with a workspace they're in), with each
 * board's change number: what background work needs to see what's new, without the counts the boards page shows.
 */
export async function openBoards(db: Db | Tx, userId: string): Promise<{ id: string; name: string; seq: number; archivedAt: Date | null }[]> {
  const rows = await db.execute<{
    id: string
    name: string
    seq: string | number
    archived_at: Date | null
    visibility: BoardRow['visibility']
    workspace_id: string | null
    workspace_role: BoardRow['workspaceRole']
    role: Role | null
    in_workspace: boolean
  }>(sql`
      select b.id, b.name, b.seq, b.archived_at, b.visibility, b.workspace_id, b.workspace_role, m.role, (w.user_id is not null) as in_workspace
      from boards b
      left join board_members m on m.board_id = b.id and m.user_id = ${userId}
      left join workspace_members w on w.workspace_id = b.workspace_id and w.user_id = ${userId}
      where m.role is not null or (b.visibility = 'workspace' and w.user_id is not null)
      order by b.name, b.id`)
  return [...rows].flatMap((r) => {
    const board = { id: r.id, visibility: r.visibility, publicLink: false, workspaceId: r.workspace_id, workspaceRole: r.workspace_role } as BoardRow
    if (!accessFor(board, r.role, r.in_workspace)) return []
    return [{ id: r.id, name: r.name, seq: Number(r.seq), archivedAt: r.archived_at ? new Date(r.archived_at) : null }]
  })
}
