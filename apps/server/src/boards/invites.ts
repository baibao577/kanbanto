import { randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import { boardInvites, boardMembers, boards, type Role } from '../db/schema'
import { HttpError } from '../http'
import { higherRole } from './access'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I

export const newLinkToken = () => randomBytes(18).toString('base64url')
export const newCode = () => [...randomBytes(8)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
/** Codes are shown as ABCD-EFGH; people may type them with spaces, dashes or in lowercase. */
export const normalizeCode = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, '')
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

/** An active invite by its link token or access code, with its board. */
export async function findInvite(db: Tx, tokenOrCode: string) {
  const candidates = [tokenOrCode.trim(), normalizeCode(tokenOrCode)]
  for (const token of candidates) {
    if (!token) continue
    const [row] = await db
      .select({ invite: boardInvites, board: boards })
      .from(boardInvites)
      .innerJoin(boards, eq(boards.id, boardInvites.boardId))
      .where(and(eq(boardInvites.token, token), isNull(boardInvites.revokedAt)))
    if (row) return row
  }
  return null
}

/**
 * Adds someone to a board through an invite. Someone already on the board keeps the higher of their
 * role and the invite's. Private boards can't be joined (their invites wait until sharing is back on).
 * An email invite only works for the address it was sent to, and only once.
 */
export async function joinWithInvite(tx: Tx, user: { id: string; email: string }, tokenOrCode: string): Promise<{ boardId: string; role: Role }> {
  const userId = user.id
  const found = await findInvite(tx, tokenOrCode)
  if (!found) throw new HttpError(404, 'That invite doesn’t work any more. Ask for a new link or code.')
  const { invite, board } = found
  if (board.visibility === 'private') throw new HttpError(403, 'This board is private right now, so it can’t be joined.')
  if (invite.kind === 'email') {
    if (invite.email !== user.email)
      throw new HttpError(403, `This invite was sent to ${invite.email}. Sign in with that email address to accept it.`)
    await tx.update(boardInvites).set({ revokedAt: new Date() }).where(eq(boardInvites.id, invite.id))
  }
  const [existing] = await tx
    .select()
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, userId)))
  const now = new Date()
  if (!existing) {
    await tx.insert(boardMembers).values({ boardId: board.id, userId, role: invite.role, createdAt: now, updatedAt: now, version: 1 })
    return { boardId: board.id, role: invite.role }
  }
  const role = higherRole(existing.role, invite.role)
  if (role !== existing.role)
    await tx
      .update(boardMembers)
      .set({ role, updatedAt: now, version: sql`${boardMembers.version} + 1` })
      .where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, userId)))
  return { boardId: board.id, role }
}

export type InviteKind = 'link' | 'code'

/** The board's share link and access code, and the email invites not accepted yet. */
export async function activeInvites(db: Db | Tx, boardId: string) {
  const rows = await db
    .select()
    .from(boardInvites)
    .where(and(eq(boardInvites.boardId, boardId), isNull(boardInvites.revokedAt)))
  const link = rows.find((r) => r.kind === 'link')
  const code = rows.find((r) => r.kind === 'code')
  return {
    link: link ? { token: link.token, role: link.role } : null,
    code: code ? { code: formatCode(code.token), role: code.role } : null,
    pending: rows.filter((r) => r.kind === 'email').map((r) => ({ id: r.id, email: r.email!, role: r.role, createdAt: r.createdAt.toISOString() })),
  }
}
