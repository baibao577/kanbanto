import type { PresetSettings } from './prefs'
import type { Change } from './records'
import type { CardDate, CardMomentKind, CardSort, CardState } from './search'
import type { BoardData, Category, Priority } from './types'
import type { ColorName } from './colors'
import type { PlanData } from './planning'
import type { PlanChange } from './planningCommands'

/**
 * What the server's API sends back, shared by the server and the web app so both agree on the shapes.
 */

export type Role = 'owner' | 'editor' | 'viewer'
/** Who can open a board: its owners only · the people added to it · those and everyone in its workspace. */
export type Visibility = 'private' | 'invited' | 'workspace'
export type WorkspaceRole = 'admin' | 'member'

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
  /** Gets reminders by email as well as under the bell. */
  reminderEmails: boolean
  /** Their time zone (IANA), for when "morning" is; null until their browser says. */
  timeZone: string | null
  /** Desktop notifications (on computers where they're turned on) for reminders, and for @mentions. */
  pushReminders: boolean
  pushMentions: boolean
  /** Their Inbox: the board where tasks go when an app (like Claude) adds one without saying where. */
  inboxBoardId: string | null
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
  /** The server prints emails instead of sending them (MAIL_TRANSPORT=log, for development). */
  printedOnly: boolean
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

/** POST /api/boards/:id/invitations, POST /api/workspaces/:id/invitations */
export interface InvitationResult {
  /** added: they had an account and are on the board (or in the workspace) now · invited: an email invite waits */
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

/**
 * What you can do on a board, and why: added to it (member), through its workspace, or as anyone (its public link).
 */
export interface BoardAccess {
  role: Role
  via: 'member' | 'workspace' | 'public'
  visibility: Visibility
  publicLink: boolean
  /** The workspace it's in (null: its owner's Personal space). */
  workspace: { id: string; name: string } | null
  /** Archived by an owner: read-only until restored. */
  archivedAt: string | null
}

/** Comments and attachments per task (for the badges on cards), and each task's latest comment (for card age). */
export interface TaskCounts {
  comments: Record<string, number>
  attachments: Record<string, number>
  lastComment: Record<string, string>
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

/** Under the bell: someone @mentioned you in a comment, or added you to a board or a workspace. */
export type NotificationView =
  | {
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
  | {
      id: string
      kind: 'reminder'
      board: { id: string; name: string }
      task: { id: string; title: string }
      /** Who set it (null: they've gone, or it was themselves). */
      actor: string | null
      createdAt: string
      read: boolean
    }
  | {
      id: string
      kind: 'added'
      actor: string
      /** One of the two: what you were added to. */
      board: { id: string; name: string } | null
      workspace: { id: string; name: string } | null
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
  id: string
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  /** …a1b2 of the secret. */
  keyHint: string
  lastError: string | null
  updatedAt: string
}

/**
 * Somewhere that still holds files, other than where new files go now: the server's disk, the site's storage (as a
 * person with their own bucket sees it), or a bucket used earlier. Its files can be moved to the storage in use.
 */
export interface StoragePlace {
  /** 'disk', 'site', or the earlier bucket's id. */
  id: string
  kind: 'disk' | 'site' | 'bucket'
  /** The earlier bucket (kind 'bucket'): its keys can be replaced, and it can be used again. */
  bucket: StorageBucket | null
  files: number
  bytes: number
}

/** Files being moved to the storage in use (or the last move, until the server restarts). */
export interface StorageMove {
  running: boolean
  total: number
  moved: number
  /** Couldn't be read or written; they stay where they were. */
  failed: number
  /** Didn't fit in the owner's (or workspace's) space; they stay where they were. */
  noSpace: number
  lastError: string | null
}

/** GET /api/admin/storage */
export interface PlatformStorage {
  encryptionReady: boolean
  /** null: the server's disk. */
  bucket: StorageBucket | null
  elsewhere: StoragePlace[]
  move: StorageMove | null
  settings: { quotaMb: number; maxFileMb: number }
  usage: { bytes: number; files: number; ownStorage: number }
}

/** GET /api/account/storage */
export interface AccountStorage {
  encryptionReady: boolean
  bucket: StorageBucket | null
  elsewhere: StoragePlace[]
  move: StorageMove | null
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
  /** What it's for, in a sentence or two. */
  description: string | null
  background: string | null
  visibility: Visibility
  publicLink: boolean
  /** The workspace it's in (null: its owner's Personal space). */
  workspaceId: string | null
  /** Your role on it, and why: added to it, or through its workspace. */
  role: Role
  via: 'member' | 'workspace'
  taskCount: number
  doneCount: number
  createdAt: string
  updatedAt: string
  /** Archived: shown apart, under "Archived boards". */
  archivedAt: string | null
  /** When you starred it as a favourite (null: not one). Favourites show first, in the order they were starred. */
  favoritedAt: string | null
}

// ── Cards across boards (GET /api/cards) ───────────────────────────────────────
// One search over the cards on every board you can open, for the Search cards page and for apps (see search.ts).

export type { CardDate, CardMomentKind, CardSort, CardState }

export interface CardsQuery {
  /** Archived cards (the default), the ones on their boards, or both. */
  state: CardState
  /** One board; leave out for every board you can open. */
  board?: string
  /** The boards of one place: a workspace's id, `personal` (your own) or `shared` (shared with you). */
  place?: string
  /** Words in the title, the description or a comment. */
  q?: string
  /** Done (in a done list, or archived as completed) or not; leave out for both. */
  completed?: boolean
  /** Kinds of list (an archived card counts as `done` when it was completed). */
  kinds?: Category[]
  /** `me`, `none` (no one), or a person's id. */
  assignee?: string
  /** Any of these (`none`: no priority). */
  priorities?: (Priority | 'none')[]
  /** A label's name. */
  label?: string
  due?: 'overdue' | 'week' | 'none'
  /** Which of a card's dates `from`..`to` is about (any of them, by default); alone, only cards that have that date. */
  when?: CardDate
  /** Moments (ISO): from this one up to, not including, that one. */
  from?: string
  to?: string
  /** `hide`: only cards without subtasks. */
  parents?: 'hide'
  sort?: CardSort
  offset?: number
  limit?: number
}

/** A card, as a row: enough to recognise it and act on it, plus where it lives. */
export interface CardRow {
  id: string
  title: string
  board: { id: string; name: string; background: string | null }
  /** Where its board lives: a workspace's name, "Personal" or "Shared with you". */
  place: string
  /** Its parents' titles, top first. */
  path: string[]
  archived: boolean
  /** The list it shows in; archived: the list it was archived from (its name then), null if that's unknown. */
  list: string | null
  /** The kind of that list (null: archived unfinished), and its own color if it has one. */
  kind: Category | null
  listColor: ColorName | null
  done: boolean
  /** Archived as completed: it was in a done list then. null: not archived, or unknown (archived before this was kept). */
  completed: boolean | null
  assignee: string | null
  priority: Priority | null
  due: string | null
  labels: { name: string; color: ColorName }[]
  /** Subtasks under it (archived: the ones archived with it), and how many are done. */
  subtasks: number
  subtasksDone: number
  createdAt: string
  /** The last thing that happened on it: moved, edited or commented on. */
  activeAt: string
  doneAt: string | null
  archivedAt: string | null
  /** The date the search is about, and which of the above it is ("done 2 days ago"). */
  at: string
  atKind: CardMomentKind
  /** Part of the comment the words were found in, when they weren't all in the title or description. */
  snippet?: string
  /** You can restore or delete it (an editor, on a board that isn't archived). */
  canEdit: boolean
}

export interface CardsPage {
  cards: CardRow[]
  total: number
  /** Pass back as `offset` for the next page; null at the end. */
  nextOffset: number | null
  /** On the first page: the labels and people of the boards searched, to filter by. */
  labels?: string[]
  people?: { id: string; name: string }[]
}

export interface SharingMember {
  userId: string
  name: string
  /** Owners see everyone's; others only their own. */
  email?: string
  role: Role
}

/** A named set of filters and display settings on a board, shared with everyone on it (GET /api/boards/:id/presets). */
export interface BoardPreset {
  id: string
  name: string
  settings: PresetSettings
  /** Who saved it last (null: they've left). */
  by: string | null
  updatedAt: string
}

/** GET /api/boards/:id/sharing */
export interface Sharing {
  visibility: Visibility
  publicLink: boolean
  /** What everyone in the workspace can do, when it's shared with the workspace. */
  workspaceRole: 'editor' | 'viewer'
  /** The workspace it's in (null: Personal). */
  workspace: { id: string; name: string; memberCount: number } | null
  /** People added to the board. */
  members: SharingMember[]
  /** Only owners see the link and code. */
  link: { token: string; role: 'editor' | 'viewer' } | null
  code: { code: string; role: 'editor' | 'viewer' } | null
  /** Email invites not accepted yet (owners only). */
  pending: { id: string; email: string; role: 'editor' | 'viewer'; createdAt: string }[]
  /** Files on the board (on cards and in comments): anyone with the public link can open them too. */
  fileCount: number
  canManage: boolean
}

/** GET /api/invites/:token: what an invite is for, a board or a workspace. */
export type InvitePreview =
  | {
      kind: 'board'
      board: { id: string; name: string; background: string | null }
      role: 'editor' | 'viewer'
      private: boolean
      /** Email invites only work for this address (null for share links and codes). */
      email: string | null
    }
  | {
      kind: 'workspace'
      workspace: { id: string; name: string }
      /** Email invites only work for this address (null for the invite link). */
      email: string | null
    }

/** POST /api/join */
export type JoinResult = { kind: 'board'; boardId: string; role: Role } | { kind: 'workspace'; workspaceId: string }

/** GET /api/workspaces (one per workspace you're in) */
export interface WorkspaceSummary {
  id: string
  name: string
  /** Your role in it. */
  role: WorkspaceRole
  memberCount: number
}

export interface WorkspaceMember {
  userId: string
  name: string
  /** Admins see everyone's; others only their own. */
  email?: string
  role: WorkspaceRole
  /** Can change the workspace's plan (admins always can). */
  planner: boolean
}

/** GET /api/workspaces/:id/planning */
export interface PlanningView {
  plan: PlanData
  /** Goes up with every change to the plan. */
  seq: number
  /** You can change it: the workspace's admins and planners. */
  canEdit: boolean
  /** The accounts in the workspace now (someone in the plan who isn't has left). */
  memberIds: string[]
  /** The last change to each project's plan: when, and who made it. */
  activity: Record<string, { at: string; by: string | null }>
}

/** POST /api/workspaces/:id/planning/mutations */
export interface PlanningMutationResult {
  seq: number
  changes: PlanChange[]
}

/** GET /api/workspaces/:id */
export interface WorkspaceDetail extends WorkspaceSummary {
  members: WorkspaceMember[]
  /** Boards in it (all of them, including ones you can't open). */
  boardCount: number
  /** Admins only: the invite link, and email invites not accepted yet. */
  link: { token: string } | null
  pending: { id: string; email: string; createdAt: string }[]
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

// ── Integrations ──────────────────────────────────────────────────────────────

/** GET /api/account/tokens (one per token; the token itself is only shown when it's made) */
export interface ApiTokenView {
  id: string
  name: string
  /** read: can only look · write: can also change boards */
  scope: 'read' | 'write'
  /** Its start and end, to recognise it (kbt_ab…wxyz). */
  hint: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export interface WebhookDeliveryView {
  id: string
  event: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  responseStatus: number | null
  error: string | null
  createdAt: string
}

/** GET /api/boards/:id/webhooks/:hookId/deliveries: one delivery in full, for the webhook's log. */
export interface WebhookDeliveryDetail extends WebhookDeliveryView {
  /** What was sent (the JSON body). */
  payload: unknown
  /** The start of what the address answered (up to 2 KB). */
  response: string | null
  sentAt: string | null
}

/** GET /api/boards/:id/webhooks (one per webhook) */
/** What a webhook can be sent (a test `ping` always is). */
export const WEBHOOK_EVENTS = ['board.changed', 'comment.added', 'reminder.due'] as const
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number]

export interface WebhookView {
  id: string
  url: string
  active: boolean
  /** What it's sent. */
  events: WebhookEventName[]
  createdAt: string
  lastDeliveryAt: string | null
  lastStatus: number | null
  lastError: string | null
  /** The latest deliveries, newest first. */
  recent: WebhookDeliveryView[]
}

/** Where board owners may send webhooks, as set by a platform admin. */
export type WebhookMode = 'off' | 'public' | 'any'

/** Which apps may connect to people's accounts with sign-in (OAuth, for MCP), as set by a platform admin. */
export type OAuthMode = 'off' | 'known' | 'any'

/** GET /api/admin/settings */
export interface AdminSettings {
  openSignup: boolean
  apiTokens: boolean
  webhooks: WebhookMode
  oauthApps: OAuthMode
}

/** GET /api/oauth/request: what the consent page shows. */
export interface OAuthRequestView {
  /** The name the app gave itself (not verified: `sendsBackTo` is what can be trusted). */
  app: string
  /** Where you'll be sent back to: a site's host, "an app on your computer", or a desktop app. */
  sendsBackTo: string
  /** The most it asked for: read, or read and make changes. */
  maxScope: 'read' | 'write'
}

/** GET /api/account/apps (one per app) */
export interface ConnectedAppView {
  clientId: string
  name: string
  sendsBackTo: string
  scope: 'read' | 'write'
  connectedAt: string
  lastUsedAt: string | null
}
