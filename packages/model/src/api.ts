import type { Change } from './records'
import type { BoardData } from './types'

/**
 * What the server's API sends back, shared by the server and the web app so both agree on the shapes.
 */

export type Role = 'owner' | 'editor' | 'viewer'
export type Visibility = 'private' | 'invited' | 'public'

export interface PublicUser {
  id: string
  email: string
  name: string
  /** Platform admin (the people running the site; granted on the server, never by signing up). */
  isAdmin: boolean
  /** Confirmed their email address, or a platform admin vouched for it (required once the site can send email). */
  emailVerified: boolean
  /** Gets the daily email summary of @mentions. */
  mentionEmails: boolean
}

/** GET /api/auth/me */
export interface Me {
  user: PublicUser | null
  openSignup: boolean
  /** The site can send email: password reset works, and new accounts must confirm their email. */
  emailEnabled: boolean
}

export type SmtpSecurity = 'tls' | 'starttls' | 'none'

/** An SMTP server's settings, as the browser sees them (never the password). */
export interface SmtpSettings {
  host: string
  port: number
  /** tls: encrypted from the start (usually 465) · starttls: upgrades after connecting (usually 587) · none: internal relays */
  security: SmtpSecurity
  /** Null: the server doesn't ask for a sign-in. */
  username: string | null
  allowSelfSigned: boolean
}

/** How email is sent, as the browser sees it (never the key or password). */
export interface EmailSender {
  provider: 'resend' | 'smtp'
  /** re_…a1b2, or the SMTP server's address (smtp.example.com:587) */
  keyHint: string
  from: string
  working: boolean
  /** Why the last email failed, while it keeps failing. */
  lastError: string | null
  /** Resend's shared test domain: it can only email the Resend account's own address. */
  testingOnly: boolean
  smtp: SmtpSettings | null
  /** Set on the server (SMTP_URL), so it can't be changed in the console. */
  fromServer: boolean
  updatedAt: string
}

/** PUT /api/admin/email/sender (people's own: Resend only). Leave out the key or password to keep the saved one. */
export type SaveEmailSender =
  | { provider: 'resend'; apiKey?: string; from: string }
  | ({ provider: 'smtp'; password?: string; from: string } & Omit<SmtpSettings, 'username'> & { username?: string })

/** GET /api/admin/email */
export interface PlatformEmail {
  encryptionReady: boolean
  sender: EmailSender | null
  /** Limits are null when there's no limit. */
  settings: {
    dailyBudget: number | null
    monthlyBudget: number | null
    userAllowance: number | null
    brandName: string
    brandColor: string
    footer: string
  }
  /** Emails sent with the platform's key. */
  usage: { today: number; month: number }
  /** People who use their own email key. */
  ownKeys: number
  /** Accounts that haven't confirmed their email (they're asked to once the site can send email). */
  unconfirmed: number
}

/** GET /api/account/email */
export interface AccountEmail {
  encryptionReady: boolean
  platformReady: boolean
  sender: EmailSender | null
  /** Invite emails sent with the site's key this month (limit null: no limit). */
  allowance: { used: number; limit: number | null }
}

/** POST /api/boards/:id/invitations */
export interface InvitationResult {
  /** added: they had an account and are on the board now · invited: an email invite waits for them */
  outcome: 'added' | 'invited'
  name?: string
  emailed: boolean
  /** Why no email went out. */
  why: string | null
  /** When no email went out for an invite: its token, for a link to send them yourself. */
  token?: string
}

export const EMAIL_KIND_LABELS = {
  verify: 'Confirm your email',
  reset: 'Reset password',
  invite: 'Board invite',
  digest: 'Daily mentions',
  test: 'Test email',
  notice: 'Account notice',
} as const

/** What you can do on a board, and why: as a member, or as anyone (public boards). */
export interface BoardAccess {
  role: Role
  via: 'member' | 'public'
  visibility: Visibility
}

/** Comments and attachments per task (for the badges on cards). */
export interface TaskCounts {
  comments: Record<string, number>
  attachments: Record<string, number>
}

/** GET /api/boards/:id */
export interface BoardSnapshot {
  data: BoardData
  /** The board's change counter when this was read. */
  seq: number
  access: BoardAccess
  counts: TaskCounts
  /** You can comment (members, including viewers; not anonymous visitors of public boards). */
  canComment: boolean
}

export interface CommentView {
  id: string
  taskId: string
  author: { id: string; name: string } | null
  body: string
  /** People @mentioned in it. */
  mentions: string[]
  /** Files attached to the comment. */
  attachments: AttachmentView[]
  createdAt: string
  editedAt: string | null
}

export interface NotificationView {
  id: string
  kind: 'mention'
  actor: string
  board: { id: string; name: string }
  task: { id: string; title: string }
  /** The start of the comment. */
  excerpt: string
  createdAt: string
  read: boolean
}

export interface AttachmentView {
  id: string
  taskId: string
  name: string
  size: number
  mime: string
  uploader: string | null
  createdAt: string
  /** Where it opens (or downloads). */
  url: string
  /** Shown as a picture. */
  image: boolean
  /** The comment it's attached to (null: attached to the card). */
  commentId: string | null
}

/** An S3-compatible bucket, as the browser sees it (never the secret). */
export interface StorageBucket {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  /** …a1b2 of the secret. */
  keyHint: string
  lastError: string | null
  updatedAt: string
}

/** GET /api/admin/storage */
export interface PlatformStorage {
  encryptionReady: boolean
  /** null: the server's disk. */
  bucket: StorageBucket | null
  settings: { quotaMb: number; maxFileMb: number }
  usage: { bytes: number; files: number; ownStorage: number }
}

/** GET /api/account/storage */
export interface AccountStorage {
  encryptionReady: boolean
  bucket: StorageBucket | null
  /** Space used on boards you own, in the site's storage. */
  used: number
  quota: number
  maxFile: number
}

/** POST /api/boards/:id/mutations */
export interface MutationResult {
  seq: number
  changes: Change[]
}

/** GET /api/boards (one per board) */
export interface BoardSummary {
  id: string
  name: string
  background: string | null
  visibility: Visibility
  /** Your role on it. */
  role: Role
  taskCount: number
  doneCount: number
  createdAt: string
  updatedAt: string
}

export interface SharingMember {
  userId: string
  name: string
  /** Owners see everyone's; others only their own. */
  email?: string
  role: Role
}

/** GET /api/boards/:id/sharing */
export interface Sharing {
  visibility: Visibility
  members: SharingMember[]
  /** Only owners see the link and code. */
  link: { token: string; role: 'editor' | 'viewer' } | null
  code: { code: string; role: 'editor' | 'viewer' } | null
  /** Email invites not accepted yet (owners only). */
  pending: { id: string; email: string; role: 'editor' | 'viewer'; createdAt: string }[]
  canManage: boolean
}

/** GET /api/invites/:token */
export interface InvitePreview {
  board: { id: string; name: string; background: string | null }
  role: 'editor' | 'viewer'
  private: boolean
  /** Email invites only work for this address (null for share links and codes). */
  email: string | null
}

/** GET /api/admin/stats */
export interface PlatformStats {
  users: number
  activeUsers: number
  /** Signed up in the last 7 days. */
  newUsers: number
  boards: number
  tasks: number
}

/** GET /api/admin/users */
export interface AdminUser {
  id: string
  email: string
  name: string
  isAdmin: boolean
  emailVerified: boolean
  disabled: boolean
  createdAt: string
  /** Boards they own. */
  boards: number
}

/** What the server sends over a board's live connection. */
export type LiveMessage =
  /** Sent on connect: the board's change counter, so the client knows if it missed anything. */
  | { type: 'hello'; seq: number }
  /** Changes someone made (the mutation id lets the sender recognize its own). */
  | { type: 'changes'; seq: number; changes: Change[]; mutationId?: string }
  /** Something outside the board data changed (people, sharing): fetch the board again. */
  | { type: 'reload' }
  /** You can no longer open this board (removed, or it became private). */
  | { type: 'access-lost' }
  /** Your session ended (password changed elsewhere, account turned off): sign in again. */
  | { type: 'signed-out' }
  | { type: 'deleted' }
  | { type: 'comment'; taskId: string; action: 'added' | 'edited' | 'deleted'; commentId: string; comment?: CommentView }
  | { type: 'attachment'; taskId: string; action: 'added' | 'deleted'; attachmentId: string; attachment?: AttachmentView }
