import { newId } from '@kanbanto/model/ids'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { accessFor, memberRole, requireAccess } from '../boards/access'
import { activeInvites, findInvite, joinWithInvite, newCode, newLinkToken, type InviteKind } from '../boards/invites'
import type { Tx } from '../db'
import { boardInvites, boardMembers, boards, ROLES, tasks, users, VISIBILITIES } from '../db/schema'
import { env } from '../env'
import { HttpError, parse, siteUrl } from '../http'
import { WHY_NOT_SENT } from '../mail/mailer'
import { emails } from '../mail/templates'
import { requireUser } from './auth'

const Params = z.object({ id: z.string().min(1).max(100) })
const MemberParams = Params.extend({ userId: z.uuid() })
const KindParams = Params.extend({ kind: z.enum(['link', 'code']) })
const inviteRole = z.enum(['editor', 'viewer'])
const ROLE_TEXT = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' } as const

// Guessing codes: a handful of tries per minute per address.
const LIMIT = { config: { rateLimit: { max: env.test ? 1000 : 20, timeWindow: '1 minute' } } }
// Inviting by email tells whether an address has an account (and its name): a limited number per person.
const INVITE_LIMIT = {
  config: {
    rateLimit: {
      max: env.test ? 1000 : 30,
      timeWindow: '1 hour',
      keyGenerator: (req: FastifyRequest) => (req.user ? `user:${req.user.id}` : req.ip),
    },
  },
}

async function ownerCount(tx: Tx, boardId: string) {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.role, 'owner')))
  return n
}

export const sharingRoutes: FastifyPluginAsync = async (app) => {
  const sharingChanged = (boardId: string) => announceSharingChange(app, boardId)

  /**
   * Everything on the Share dialog, for people on the board (visitors of a public board don't see who's on it).
   * Owners see everyone's email address and the invites; others see names, and only their own address.
   */
  app.get('/boards/:id/sharing', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { board, access } = await requireAccess(app.db, me, id, 'viewer')
    if (access.via !== 'member') throw new HttpError(403, 'Only people on this board can see who’s on it.')
    const owner = access.role === 'owner'
    const rows = await app.db
      .select({ userId: users.id, name: users.name, email: users.email, role: boardMembers.role })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(eq(boardMembers.boardId, id))
    const order = { owner: 0, editor: 1, viewer: 2 }
    const members = rows
      .sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name))
      .map((m) => (owner || m.userId === me.id ? m : { userId: m.userId, name: m.name, role: m.role }))
    // Only owners see the invites (anyone holding them can join).
    const invites = owner ? await activeInvites(app.db, id) : { link: null, code: null, pending: [] }
    return { visibility: board.visibility, members, ...invites, canManage: owner }
  })

  app.patch('/boards/:id/sharing', async (req) => {
    const { id } = parse(Params, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'owner')
    const { visibility } = parse(z.object({ visibility: z.enum(VISIBILITIES) }), req.body)
    await app.db.update(boards).set({ visibility }).where(eq(boards.id, id))
    await sharingChanged(id)
    return { visibility }
  })

  /** Turns on (or changes the role of) the share link / access code. `regenerate` replaces it, so the old one stops working. */
  app.put('/boards/:id/invites/:kind', async (req) => {
    const { id, kind } = parse(KindParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'owner')
    const body = parse(z.object({ role: inviteRole, regenerate: z.boolean().optional() }), req.body)
    await app.db.transaction(async (tx) => {
      const active = and(eq(boardInvites.boardId, id), eq(boardInvites.kind, kind), isNull(boardInvites.revokedAt))
      const [current] = await tx.select().from(boardInvites).where(active)
      if (current && !body.regenerate) {
        await tx.update(boardInvites).set({ role: body.role }).where(eq(boardInvites.id, current.id))
        return
      }
      if (current) await tx.update(boardInvites).set({ revokedAt: new Date() }).where(eq(boardInvites.id, current.id))
      const token = (kind as InviteKind) === 'link' ? newLinkToken() : newCode()
      await tx.insert(boardInvites).values({ id: newId(), boardId: id, kind, token, role: body.role, createdBy: me.id })
    })
    return activeInvites(app.db, id)
  })

  app.delete('/boards/:id/invites/:kind', async (req) => {
    const { id, kind } = parse(KindParams, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'owner')
    await app.db
      .update(boardInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(boardInvites.boardId, id), eq(boardInvites.kind, kind), isNull(boardInvites.revokedAt)))
    return activeInvites(app.db, id)
  })

  /**
   * Invites someone by email. Someone with an account is added right away (and told by email) — unless the site
   * sends email and they haven't confirmed their address: then it could be someone else's account using it, so
   * they get an invite emailed to the address instead. Anyone else gets an email invite that only works for their
   * address. Invite emails use the inviter's own email key if they have one, else their allowance on the site's; if
   * no email can be sent, the answer includes the invite's token for a link to pass on.
   * Only adds: someone already on the board keeps their role (roles change in the people list, which makes sure
   * a board always keeps an owner). Limited per person, since the answer tells whether an email has an account.
   */
  app.post('/boards/:id/invitations', INVITE_LIMIT, async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { board } = await requireAccess(app.db, me, id, 'owner')
    const body = parse(
      z.object({
        email: z
          .string()
          .trim()
          .toLowerCase()
          .pipe(z.email({ message: 'Enter a valid email address.' })),
        role: z.enum(ROLES),
      }),
      req.body,
    )
    const base = siteUrl(req)
    const [u] = await app.db.select().from(users).where(eq(users.email, body.email))
    if (u?.disabledAt) throw new HttpError(400, 'That account has been turned off.')
    const inviteEmail = (url: string, kind: 'added' | 'accept' | 'signup') =>
      app.mail.queue({
        kind: 'invite',
        to: body.email,
        requestedBy: me.id,
        content: (brand) => emails.invite(brand, { inviter: me.name, board: board.name, role: body.role, url, kind, email: body.email }),
      })

    if (u && (u.emailVerifiedAt || !app.mail.platformReady)) {
      const now = new Date()
      const added = await app.db
        .insert(boardMembers)
        .values({ boardId: id, userId: u.id, role: body.role, createdAt: now, updatedAt: now, version: 1 })
        .onConflictDoNothing()
        .returning({ userId: boardMembers.userId })
      if (!added.length) {
        const role = (await memberRole(app.db, id, u.id)) ?? 'viewer'
        throw new HttpError(409, `${u.name} is already on this board (${ROLE_TEXT[role]}). Change their role in the list below.`)
      }
      await sharingChanged(id)
      const sent = await inviteEmail(`${base}/#/b/${encodeURIComponent(id)}`, 'added')
      return { outcome: 'added', name: u.name, emailed: sent.queued, why: sent.queued ? null : WHY_NOT_SENT[sent.reason] }
    }

    const role = body.role
    if (role === 'owner') throw new HttpError(400, 'People can be made owners once they’ve joined. Invite them as an editor first.')
    if (u && (await memberRole(app.db, id, u.id))) throw new HttpError(409, `${u.name} is already on this board.`)
    // One invite per address: a new one replaces the old.
    const token = newLinkToken()
    await app.db.transaction(async (tx) => {
      await tx
        .update(boardInvites)
        .set({ revokedAt: new Date() })
        .where(and(eq(boardInvites.boardId, id), eq(boardInvites.kind, 'email'), eq(boardInvites.email, body.email), isNull(boardInvites.revokedAt)))
      await tx.insert(boardInvites).values({ id: newId(), boardId: id, kind: 'email', token, email: body.email, role, createdBy: me.id })
    })
    const sent = await inviteEmail(`${base}/#/join/${token}`, u ? 'accept' : 'signup')
    if (sent.queued) return { outcome: 'invited', emailed: true, why: null }
    // The inviter gets the link to pass on, so it no longer proves the address belongs to whoever uses it.
    await app.db.update(boardInvites).set({ linkShown: true }).where(eq(boardInvites.token, token))
    return { outcome: 'invited', emailed: false, why: WHY_NOT_SENT[sent.reason], token }
  })

  /** Cancels an email invite that hasn't been accepted. */
  app.delete('/boards/:id/invitations/:inviteId', async (req) => {
    const { id, inviteId } = parse(Params.extend({ inviteId: z.uuid() }), req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'owner')
    await app.db
      .update(boardInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(boardInvites.id, inviteId), eq(boardInvites.boardId, id), eq(boardInvites.kind, 'email')))
    return { ok: true }
  })

  app.patch('/boards/:id/members/:userId', async (req) => {
    const { id, userId } = parse(MemberParams, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'owner')
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body)
    await app.db.transaction(async (tx) => {
      const current = await memberRole(tx, id, userId)
      if (!current) throw new HttpError(404, 'That person isn’t on this board.')
      if (current === 'owner' && role !== 'owner' && (await ownerCount(tx, id)) < 2)
        throw new HttpError(400, 'A board needs at least one owner. Make someone else an owner first.')
      await tx
        .update(boardMembers)
        .set({ role, updatedAt: new Date(), version: sql`${boardMembers.version} + 1` })
        .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)))
    })
    await sharingChanged(id)
    return { ok: true }
  })

  /** Removes someone from a board (owners), or leaves it (anyone, for themselves). Their cards are unassigned. */
  app.delete('/boards/:id/members/:userId', async (req) => {
    const { id, userId } = parse(MemberParams, req.params)
    const me = requireUser(req.user)
    if (userId !== me.id) await requireAccess(app.db, me, id, 'owner')
    await app.db.transaction(async (tx) => {
      const current = await memberRole(tx, id, userId)
      if (!current) throw new HttpError(404, 'That person isn’t on this board.')
      if (current === 'owner' && (await ownerCount(tx, id)) < 2)
        throw new HttpError(400, 'A board needs at least one owner. Make someone else an owner first.')
      await tx.delete(boardMembers).where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)))
      await tx
        .update(tasks)
        .set({ assigneeId: null, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
        .where(and(eq(tasks.boardId, id), eq(tasks.assigneeId, userId)))
    })
    await sharingChanged(id)
    return { ok: true }
  })

  /** What an invite is for (the join page shows it before you accept). Works signed out. */
  app.get('/invites/:token', LIMIT, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(200) }), req.params)
    const found = await findInvite(app.db, token)
    if (!found) throw new HttpError(404, 'That invite doesn’t work any more. Ask for a new link or code.')
    const { invite, board } = found
    return {
      board: { id: board.id, name: board.name, background: board.background },
      role: invite.role,
      private: board.visibility === 'private',
      /** Email invites work only for this address. */
      email: invite.email,
    }
  })

  /**
   * Joins a board with a share link token or an access code. Accepting an email invite for your own address that was
   * emailed to you (not shown to the inviter) also confirms your address, so it works before you've confirmed it.
   */
  app.post('/join', LIMIT, async (req) => {
    const me = requireUser(req.user, { allowUnverified: true })
    const { invite } = parse(z.object({ invite: z.string().trim().min(1, 'Enter a code.').max(200) }), req.body)
    const joined = await app.db.transaction(async (tx) => {
      if (me.mustVerify) {
        const found = await findInvite(tx, invite)
        const proves = found?.invite.kind === 'email' && found.invite.email === me.email && !found.invite.linkShown
        if (!proves) throw new HttpError(403, 'Confirm your email address first: check your inbox for the link.', 'verify-email')
        await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, me.id))
      }
      return joinWithInvite(tx, me, invite)
    })
    await sharingChanged(joined.boardId)
    return joined
  })
}

/**
 * People, visibility or invites changed: every cached and open copy of the board is refreshed (so new people
 * can be assigned right away), and anyone who lost access is disconnected.
 */
export async function announceSharingChange(app: FastifyInstance, boardId: string) {
  await app.engine.touch(boardId)
  const [board] = await app.db.select().from(boards).where(eq(boards.id, boardId))
  if (!board) return
  await app.hub.recheck(boardId, async (userId) => {
    if (!userId) return board.visibility === 'public'
    const [u] = await app.db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
    if (!u || u.disabledAt) return false
    return !!accessFor(null, board, await memberRole(app.db, boardId, userId))
  })
}
