import type { InvitationResult, WorkspaceDetail, WorkspaceSummary } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import { newLinkToken } from '../boards/invites'
import { announceSharingChange, announceWorkspaceChange } from '../boards/announce'
import { moveBoardFields } from '../boards/fields'
import { factOf, unlinkBoard } from '../boards/links'
import { addToWorkspace, adminCount, leaveWorkspace, moveBoard, requireWorkspace } from '../boards/workspaces'
import { boards, users, WORKSPACE_ROLES, workspaceInvites, workspaceMembers, workspaces } from '../db/schema'
import { env } from '../env'
import { notOnInbox } from '../boards/inbox'
import { HttpError, parse, siteUrl } from '../http'
import { WHY_NOT_SENT } from '../mail/mailer'
import { emails } from '../mail/templates'
import { seedPlan } from '../planning/store'
import { requireUser } from './auth'
import { notifyAdded } from './comments'

const Params = z.object({ id: z.uuid() })
const MemberParams = Params.extend({ userId: z.uuid() })
const Name = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the workspace a name.')
    .max(100)
    .refine((n) => !n.includes('\u0000'), 'Names can’t contain NUL characters.'),
})
// Inviting by email tells whether an address has an account: a limited number per person (shared with boards').
const INVITE_LIMIT = {
  config: {
    rateLimit: {
      max: env.test ? 1000 : 30,
      timeWindow: '1 hour',
      keyGenerator: (req: FastifyRequest) => (req.user ? `user:${req.user.id}` : req.ip),
    },
  },
}

const memberCount = sql<number>`(select count(*)::int from ${workspaceMembers} m where m.workspace_id = ${workspaces.id})`

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  const detail = async (id: string, meId: string): Promise<WorkspaceDetail> => {
    const { workspace, role } = await requireWorkspace(app.db, id, meId)
    const admin = role === 'admin'
    const rows = await app.db
      .select({ userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role, planner: workspaceMembers.planner })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id))
    const members = rows
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1))
      .map((m) => (admin || m.userId === meId ? m : { userId: m.userId, name: m.name, role: m.role, planner: m.planner }))
    const [{ n }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(boards)
      .where(eq(boards.workspaceId, id))
    const invites = admin
      ? await app.db
          .select()
          .from(workspaceInvites)
          .where(and(eq(workspaceInvites.workspaceId, id), isNull(workspaceInvites.revokedAt)))
      : []
    const link = invites.find((i) => i.kind === 'link')
    return {
      id,
      name: workspace.name,
      role,
      memberCount: members.length,
      members,
      boardCount: n,
      link: link ? { token: link.token } : null,
      pending: invites.filter((i) => i.kind === 'email').map((i) => ({ id: i.id, email: i.email!, createdAt: i.createdAt.toISOString() })),
    }
  }

  /** Workspaces you're in. */
  app.get('/workspaces', async (req) => {
    const me = requireUser(req.user)
    const rows = await app.db
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role, memberCount })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, me.id))
    const list: WorkspaceSummary[] = rows.sort((a, b) => a.name.localeCompare(b.name))
    return { workspaces: list }
  })

  /** Makes a workspace, with you as its admin. */
  app.post('/workspaces', async (req) => {
    const me = requireUser(req.user)
    const { name } = parse(Name, req.body)
    const id = newId()
    await app.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ id, name, createdBy: me.id })
      await seedPlan(tx, id)
      await addToWorkspace(tx, id, me.id, 'admin')
    })
    return { id }
  })

  app.get('/workspaces/:id', async (req) => {
    const { id } = parse(Params, req.params)
    return detail(id, requireUser(req.user).id)
  })

  app.patch('/workspaces/:id', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    await requireWorkspace(app.db, id, me.id, true)
    const { name } = parse(Name, req.body)
    await app.db.update(workspaces).set({ name }).where(eq(workspaces.id, id))
    await announceWorkspaceChange(app, id)
    return detail(id, me.id)
  })

  /** Deletes an empty workspace (its boards must be moved out or deleted first, so none is lost by accident). */
  app.delete('/workspaces/:id', async (req) => {
    const { id } = parse(Params, req.params)
    await requireWorkspace(app.db, id, requireUser(req.user).id, true)
    const [{ n }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(boards)
      .where(eq(boards.workspaceId, id))
    if (n) throw new HttpError(400, `This workspace still has ${n} ${n === 1 ? 'board' : 'boards'}. Move or delete ${n === 1 ? 'it' : 'them'} first.`)
    await app.db.delete(workspaces).where(eq(workspaces.id, id))
    return { ok: true }
  })

  /** Turns on the invite link, or (`regenerate`) replaces it so the old one stops working. */
  app.put('/workspaces/:id/invites/link', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    await requireWorkspace(app.db, id, me.id, true)
    const { regenerate } = parse(z.object({ regenerate: z.boolean().optional() }), req.body ?? {})
    await app.db.transaction(async (tx) => {
      const active = and(eq(workspaceInvites.workspaceId, id), eq(workspaceInvites.kind, 'link'), isNull(workspaceInvites.revokedAt))
      const [current] = await tx.select().from(workspaceInvites).where(active)
      if (current && !regenerate) return
      if (current) await tx.update(workspaceInvites).set({ revokedAt: new Date() }).where(eq(workspaceInvites.id, current.id))
      await tx.insert(workspaceInvites).values({ id: newId(), workspaceId: id, kind: 'link', token: newLinkToken(), createdBy: me.id })
    })
    return detail(id, me.id)
  })

  app.delete('/workspaces/:id/invites/link', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    await requireWorkspace(app.db, id, me.id, true)
    await app.db
      .update(workspaceInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceInvites.workspaceId, id), eq(workspaceInvites.kind, 'link'), isNull(workspaceInvites.revokedAt)))
    return detail(id, me.id)
  })

  /**
   * Invites someone by email, like a board invite: someone with a confirmed account (or any account, if the site
   * doesn't send email) is added right away and told; anyone else gets an invite that only works for their address,
   * or, if no email can be sent, its token for a link to pass on.
   */
  app.post('/workspaces/:id/invitations', INVITE_LIMIT, async (req): Promise<InvitationResult> => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { workspace } = await requireWorkspace(app.db, id, me.id, true)
    const { email } = parse(
      z.object({
        email: z
          .string()
          .trim()
          .toLowerCase()
          .pipe(z.email({ message: 'Enter a valid email address.' })),
      }),
      req.body,
    )
    const base = siteUrl(req)
    const [u] = await app.db.select().from(users).where(eq(users.email, email))
    if (u?.disabledAt) throw new HttpError(400, 'That account has been turned off.')
    const inviteEmail = (url: string, kind: 'added' | 'accept' | 'signup') =>
      app.mail.queue({
        kind: 'invite',
        to: email,
        requestedBy: me.id,
        content: (brand) => emails.invite(brand, { inviter: me.name, board: workspace.name, role: 'editor', url, kind, email, workspace: true }),
      })

    if (u && (u.emailVerifiedAt || !app.mail.platformReady)) {
      if (!(await addToWorkspace(app.db, id, u.id))) throw new HttpError(409, `${u.name} is already in this workspace.`)
      await notifyAdded(app.db, u.id, me.id, { workspaceId: id })
      await announceWorkspaceChange(app, id)
      const sent = await inviteEmail(`${base}/#/`, 'added')
      return { outcome: 'added', name: u.name, emailed: sent.queued, why: sent.queued ? null : WHY_NOT_SENT[sent.reason] }
    }

    const token = newLinkToken()
    await app.db.transaction(async (tx) => {
      await tx
        .update(workspaceInvites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(workspaceInvites.workspaceId, id),
            eq(workspaceInvites.kind, 'email'),
            eq(workspaceInvites.email, email),
            isNull(workspaceInvites.revokedAt),
          ),
        )
      await tx.insert(workspaceInvites).values({ id: newId(), workspaceId: id, kind: 'email', token, email, createdBy: me.id })
    })
    const sent = await inviteEmail(`${base}/#/join/${token}`, u ? 'accept' : 'signup')
    // (Sent with the inviter's own email service, the link is theirs to read there: it proves nothing either.)
    if (sent.queued && sent.via === 'own-key') await app.db.update(workspaceInvites).set({ linkShown: true }).where(eq(workspaceInvites.token, token))
    if (sent.queued) return { outcome: 'invited', emailed: true, why: null }
    await app.db.update(workspaceInvites).set({ linkShown: true }).where(eq(workspaceInvites.token, token))
    return { outcome: 'invited', emailed: false, why: WHY_NOT_SENT[sent.reason], token }
  })

  app.delete('/workspaces/:id/invitations/:inviteId', async (req) => {
    const { id, inviteId } = parse(Params.extend({ inviteId: z.uuid() }), req.params)
    await requireWorkspace(app.db, id, requireUser(req.user).id, true)
    await app.db
      .update(workspaceInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, id), eq(workspaceInvites.kind, 'email')))
    return { ok: true }
  })

  /** Makes someone an admin or a member, or lets them change the plan (planner). A workspace always keeps an admin. */
  app.patch('/workspaces/:id/members/:userId', async (req) => {
    const { id, userId } = parse(MemberParams, req.params)
    const me = requireUser(req.user)
    await requireWorkspace(app.db, id, me.id, true)
    const body = parse(
      z
        .object({ role: z.enum(WORKSPACE_ROLES), planner: z.boolean() })
        .partial()
        .strict()
        .refine((b) => b.role !== undefined || b.planner !== undefined, 'Say what to change.'),
      req.body,
    )
    await app.db.transaction(async (tx) => {
      // (One change to a workspace's people at a time, so two at once can't each see the other admin still there.)
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).for('update')
      const [m] = await tx
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)))
      if (!m) throw new HttpError(404, 'That person isn’t in this workspace.')
      if (m.role === 'admin' && body.role && body.role !== 'admin' && (await adminCount(tx, id)) < 2)
        throw new HttpError(400, 'A workspace needs at least one admin. Make someone else an admin first.')
      await tx
        .update(workspaceMembers)
        .set({ ...body, updatedAt: new Date(), version: sql`${workspaceMembers.version} + 1` })
        .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)))
    })
    return detail(id, me.id)
  })

  /** Removes someone (admins), or leaves (anyone, for themselves). See leaveWorkspace for what happens to boards. */
  app.delete('/workspaces/:id/members/:userId', async (req) => {
    const { id, userId } = parse(MemberParams, req.params)
    const me = requireUser(req.user)
    await requireWorkspace(app.db, id, me.id, userId !== me.id)
    const touched = await app.db.transaction((tx) => leaveWorkspace(app.engine, tx, id, userId, userId === me.id ? null : me.id))
    for (const boardId of touched) await announceSharingChange(app, boardId)
    return { ok: true }
  })

  /**
   * Moves a board to a workspace, or (`workspaceId: null`) to its owner's Personal space. See moveBoard. If its fields
   * would change (added to the other library, or lost), the answer is a 409 listing them: send `confirm: true` to go on.
   */
  app.put('/boards/:id/workspace', async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(100) }), req.params)
    const me = requireUser(req.user)
    const { board } = await requireAccess(app.db, me, id, 'owner')
    notOnInbox(board, 'workspace')
    const { workspaceId, confirm } = parse(z.object({ workspaceId: z.uuid().nullable(), confirm: z.boolean().optional() }), req.body)
    // Its fields belong to the space it leaves: what moving them would add or lose is asked first (see moveBoardFields).
    let touched: string[] = []
    const leaving = board.workspaceId !== workspaceId
    // (As it was: where its cards' links to and from other boards have to be taken out, once it has gone.)
    const was = leaving ? await factOf(app.db, id) : undefined
    const visibility = await app.db.transaction(async (tx) => {
      const shown = await moveBoard(tx, board, me.id, workspaceId)
      if (leaving) touched = await moveBoardFields(app, tx, board, me.id, workspaceId, !!confirm)
      return shown
    })
    await announceSharingChange(app, id)
    app.engine.reloaded(touched)
    if (was) await unlinkBoard({ db: app.db, engine: app.engine }, was).catch((e) => app.log.error(e))
    return { workspaceId, visibility }
  })
}
