import { createHash, randomBytes } from 'node:crypto'
import type { AttachmentView, CommentView } from '@kanbanto/model/api'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { sessionUser, type SessionUser } from '../auth/sessions'
import { users } from '../db/schema'
import { env } from '../env'
import { HttpError, parse } from '../http'
import { mentionsIn, postComment } from './comments'
import { blockedName, declaredSize, dropDraft, mayUpload, saveUpload } from './files'

/**
 * Files that arrive on a card some other way than a signed-in upload: put there by an assistant's tool (see mcp.ts),
 * or sent to an upload link. Both end in `saveUpload`, like every file.
 */

export interface Attach {
  boardId: string
  taskId: string
  me: SessionUser
  bytes: Buffer
  name: string
  /** With words: the file is posted in a comment that says this. Without: it's attached to the card. */
  comment?: string
  /** The app it came through, for the board's activity. */
  via?: string | null
}

/**
 * Attaches a file to a card (people who can edit the board), or, given a comment's words, posts that comment with the
 * file in it (anyone who can comment). The comment's file is saved first, as its sender's own draft, and attached
 * when the comment is posted, the way the app does it; if the comment can't be posted, the file is taken away again.
 */
export async function attachFile(app: FastifyInstance, a: Attach): Promise<{ file: AttachmentView; comment?: CommentView }> {
  const upload = { boardId: a.boardId, taskId: a.taskId, me: a.me, bytes: a.bytes, name: a.name, via: a.via }
  if (a.comment === undefined) return { file: await saveUpload(app, upload) }
  const words = a.comment.trim()
  if (!words || words.length > 10_000 || words.includes('\u0000')) throw new HttpError(400, 'A comment is 1 to 10,000 characters.')
  const draft = await saveUpload(app, { ...upload, forComment: true })
  try {
    const { board } = await mayUpload(app.db, a.me, a.boardId, true)
    const { data } = await app.engine.snapshot(a.boardId)
    const comment = await postComment(app, board, a.me, a.taskId, { body: words, mentions: mentionsIn(data.members, words), attachments: [draft.id] })
    return { file: comment.attachments.find((f) => f.id === draft.id) ?? draft, comment }
  } catch (e) {
    await dropDraft(app.db, draft.id)
    throw e
  }
}

// ── Upload links ──────────────────────────────────────────────────────────────

/**
 * An upload link lets whoever holds it send one file, to one card, once: for an assistant that works on a computer
 * and has a file there (a screenshot, a log), where its tools can only carry words. The link is the key, like a
 * calendar link, so it's made to be worth little: the card, the file's name and the comment are fixed when it's
 * made, it works for ten minutes, and using it says nothing back but that the file was saved. Only its hash is
 * kept. Kept in memory: Kanbanto runs as one server, and a restart just means asking for a new link.
 */
interface Ticket {
  userId: string
  boardId: string
  taskId: string
  name: string
  comment?: string
  via: string | null
  expires: number
  /** A file is arriving on it right now. */
  busy?: boolean
}

export const UPLOAD_PREFIX = 'kbu_'
export const UPLOAD_MINUTES = 10
/** Links one person may have waiting at once. */
const MAX_WAITING = 20
const tickets = new Map<string, Ticket>()
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** A new link's token, for a file `t.name` on that card. (Who may attach there is checked by the caller, and again when it's used.) */
export function newUploadLink(t: Omit<Ticket, 'expires' | 'busy'>): string {
  const now = Date.now()
  for (const [key, old] of tickets) if (old.expires <= now) tickets.delete(key)
  if ([...tickets.values()].filter((x) => x.userId === t.userId).length >= MAX_WAITING)
    throw new HttpError(429, 'You have many upload links waiting. Use them, or wait ten minutes for them to run out.')
  const token = `${UPLOAD_PREFIX}${randomBytes(32).toString('base64url')}`
  tickets.set(hash(token), { ...t, expires: now + UPLOAD_MINUTES * 60_000 })
  return token
}

/** (Tests start from nothing, and can make a link run out.) */
export const uploadLinks = {
  forget: () => tickets.clear(),
  expire: (token: string) => {
    const t = tickets.get(hash(token))
    if (t) t.expires = 0
  },
}

const MB = 1024 * 1024
/** As for any upload: refused before being read, whatever the settings say. */
const HARD_MAX = 200 * MB
const LINK_LIMIT = { config: { rateLimit: { max: env.test ? 1000 : 30, timeWindow: '1 minute' } } }

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  // Whatever is sent here is a file's bytes, whatever it says it is (a .json file isn't a request to read).
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: HARD_MAX }, (_req, body, done) => done(null, body))

  /** One answer for a link that never was, ran out, or was used: nothing to learn by trying. */
  const gone = () => new HttpError(404, 'This upload link doesn’t work: it was used, ran out, or never existed. Ask for a new one.')
  const ticketOf = (params: unknown) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(200) }), params)
    const ticket = token.startsWith(UPLOAD_PREFIX) ? tickets.get(hash(token)) : undefined
    if (!ticket || ticket.expires <= Date.now() || ticket.busy) throw gone()
    return { key: hash(token), ticket }
  }

  /**
   * Takes the file an upload link was made for (see the upload_link tool): its bytes as the body, nothing else needed.
   * No sign-in: the link is the key. The person who asked for it is looked up again, and has to still be allowed.
   */
  app.post(
    '/uploads/:token',
    {
      ...LINK_LIMIT,
      // Before a byte is read: is there such a link, and is the file within the size allowed.
      onRequest: async (req) => {
        ticketOf(req.params)
        await declaredSize(app.db, req.headers['content-length'])
      },
    },
    async (req) => {
      const { key, ticket } = ticketOf(req.params)
      ticket.busy = true
      try {
        const [row] = await app.db
          .select()
          .from(users)
          .where(and(eq(users.id, ticket.userId), isNull(users.disabledAt)))
        if (!row) throw gone()
        const { file, comment } = await attachFile(app, {
          boardId: ticket.boardId,
          taskId: ticket.taskId,
          me: sessionUser(row),
          bytes: req.body as Buffer,
          name: ticket.name,
          comment: ticket.comment,
          via: ticket.via,
        })
        tickets.delete(key)
        return { ok: true, file: { name: file.name, size: file.size }, attached_to: comment ? 'a comment' : 'the card' }
      } finally {
        // (Refused, say for being too big: the link can be tried again until it runs out.)
        ticket.busy = false
      }
    },
  )
}

/** Why a link can't be made for a file of this name (a program), said when it's asked for rather than when it's used. */
export const linkNameProblem = blockedName
