import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import { attachments, boardMembers, boards, tasks, workspaceInvites, workspaceMembers, workspaces, type WorkspaceRole } from '../db/schema'
import { HttpError } from '../http'
import { memberRole, workspaceRole, type BoardRow } from './access'

/**
 * Workspaces: a group of people, and a place for boards. A board in a workspace can be shared with everyone in it
 * (the board's "workspace" visibility); otherwise it works like any board. Admins manage the people; they get no
 * special access to boards.
 */

/** Checks `userId` is in the workspace (as an admin, if `admin`), and returns their role. */
export async function requireWorkspace(tx: Db | Tx, workspaceId: string, userId: string, admin = false) {
  const [w] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  const role = w ? await workspaceRole(tx, workspaceId, userId) : null
  if (!w || !role) throw new HttpError(404, 'This workspace doesn’t exist, or you’re not in it.')
  if (admin && role !== 'admin') throw new HttpError(403, 'Only the workspace’s admins can do that.')
  return { workspace: w, role }
}

export async function adminCount(tx: Db | Tx, workspaceId: string) {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'admin')))
  return n
}

/** Adds someone to a workspace; someone already in it keeps their role. Returns false if they were already in. */
export async function addToWorkspace(tx: Db | Tx, workspaceId: string, userId: string, role: WorkspaceRole = 'member') {
  const now = new Date()
  const added = await tx
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role, createdAt: now, updatedAt: now, version: 1 })
    .onConflictDoNothing()
    .returning({ userId: workspaceMembers.userId })
  return added.length > 0
}

/** An active workspace invite by its token, with its workspace. */
export async function findWorkspaceInvite(tx: Db | Tx, token: string) {
  const [row] = await tx
    .select({ invite: workspaceInvites, workspace: workspaces })
    .from(workspaceInvites)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId))
    .where(and(eq(workspaceInvites.token, token.trim()), isNull(workspaceInvites.revokedAt)))
  return row ?? null
}

/** Joins a workspace through an invite. An email invite only works for the address it was sent to, and only once. */
export async function joinWorkspace(
  tx: Tx,
  user: { id: string; email: string },
  found: NonNullable<Awaited<ReturnType<typeof findWorkspaceInvite>>>,
) {
  const { invite, workspace } = found
  if (invite.kind === 'email') {
    if (invite.email !== user.email)
      throw new HttpError(403, `This invite was sent to ${invite.email}. Sign in with that email address to accept it.`)
    await tx.update(workspaceInvites).set({ revokedAt: new Date() }).where(eq(workspaceInvites.id, invite.id))
  }
  await addToWorkspace(tx, workspace.id, user.id)
  return workspace.id
}

/**
 * Someone leaves a workspace, or an admin removes them. Its boards shared with the workspace close to them, unless
 * they were added to one. Boards they own there stay in the workspace: where they're the only owner, `heir` (an
 * admin) becomes the owner; they stop being an owner of all of them. Their cards on boards they can't open any more
 * are unassigned. The last admin can't leave while others are in it. Returns the boards whose people changed.
 */
export async function leaveWorkspace(tx: Tx, workspaceId: string, userId: string, heir: string | null): Promise<string[]> {
  const role = await workspaceRole(tx, workspaceId, userId)
  if (!role) throw new HttpError(404, 'That person isn’t in this workspace.')
  if (role === 'admin' && (await adminCount(tx, workspaceId)) < 2) {
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
    throw new HttpError(
      400,
      n > 1
        ? 'A workspace needs at least one admin. Make someone else an admin first.'
        : 'You’re the only one in this workspace. Delete it instead (move its boards out first).',
    )
  }
  const successor = heir && heir !== userId ? heir : await firstAdmin(tx, workspaceId, userId)
  const here = await tx.select().from(boards).where(eq(boards.workspaceId, workspaceId))
  const now = new Date()
  for (const b of here) {
    if ((await memberRole(tx, b.id, userId)) !== 'owner') continue
    const [{ others }] = await tx
      .select({ others: sql<number>`count(*)::int` })
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, b.id), eq(boardMembers.role, 'owner'), ne(boardMembers.userId, userId)))
    if (!others && successor)
      await tx
        .insert(boardMembers)
        .values({ boardId: b.id, userId: successor, role: 'owner', createdAt: now, updatedAt: now, version: 1 })
        .onConflictDoUpdate({
          target: [boardMembers.boardId, boardMembers.userId],
          set: { role: 'owner', updatedAt: now, version: sql`${boardMembers.version} + 1` },
        })
    await tx.delete(boardMembers).where(and(eq(boardMembers.boardId, b.id), eq(boardMembers.userId, userId)))
  }
  await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
  // Boards here they can't open any more (no longer added to them): their cards there are unassigned.
  const stillOn = new Set(
    (
      await tx
        .select({ boardId: boardMembers.boardId })
        .from(boardMembers)
        .where(
          and(
            eq(boardMembers.userId, userId),
            inArray(
              boardMembers.boardId,
              here.map((b) => b.id),
            ),
          ),
        )
    ).map((r) => r.boardId),
  )
  const closed = here.filter((b) => !stillOn.has(b.id)).map((b) => b.id)
  if (closed.length)
    await tx
      .update(tasks)
      .set({ assigneeId: null, updatedAt: now, version: sql`${tasks.version} + 1` })
      .where(and(inArray(tasks.boardId, closed), eq(tasks.assigneeId, userId)))
  return here.map((b) => b.id)
}

/** The workspace's longest-standing admin, other than `except`. */
async function firstAdmin(tx: Db | Tx, workspaceId: string, except: string) {
  const [row] = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'admin'), ne(workspaceMembers.userId, except)))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1)
  return row?.userId ?? null
}

/**
 * Moves a board to a workspace, or (null) to its owner's Personal space. Only its owners can, and only into a
 * workspace they're in; taking a board out of a workspace also needs that workspace's admin, so nobody walks off with
 * a team's board. Shared with the old workspace, it's shared with the new one (or, in Personal, with the people added
 * to it). Its files count against where it now is.
 */
export async function moveBoard(tx: Tx, board: BoardRow, userId: string, to: string | null) {
  const from = board.workspaceId
  if (from === to) return board.visibility
  if (from && (await workspaceRole(tx, from, userId)) !== 'admin')
    throw new HttpError(403, 'Only the workspace’s admins can move its boards somewhere else.')
  if (to && !(await workspaceRole(tx, to, userId))) throw new HttpError(403, 'You can only move boards into a workspace you’re in.')
  const visibility = !to && board.visibility === 'workspace' ? 'invited' : board.visibility
  await tx.update(boards).set({ workspaceId: to, visibility }).where(eq(boards.id, board.id))
  // Files in the site's storage now count against the new workspace (or, in Personal, the board's owner).
  const [owner] = await tx
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.role, 'owner')))
    .orderBy(asc(boardMembers.createdAt))
    .limit(1)
  await tx
    .update(attachments)
    .set({ workspaceId: to, ownerId: to ? null : (owner?.userId ?? null) })
    .where(and(eq(attachments.boardId, board.id), eq(attachments.ownStorage, false)))
  await tx
    .update(attachments)
    .set({ workspaceId: to })
    .where(and(eq(attachments.boardId, board.id), eq(attachments.ownStorage, true)))
  return visibility
}
