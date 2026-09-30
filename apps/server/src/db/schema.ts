import { PRIORITIES, type Reminder } from '@kanbanto/model/types'
import { SETTING_DEFAULTS } from './defaults'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
/** createdAt / updatedAt / version, the same meta every board record carries in the model. */
const meta = {
  createdAt: at('created_at').notNull(),
  updatedAt: at('updated_at').notNull(),
  version: integer('version').notNull(),
}

// ── People and sign-in ─────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  /** Stored lowercased, so sign-in doesn't depend on how the address was typed. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  /**
   * When they proved they own the address (a link in an email), or a platform admin vouched for them. Required
   * once the platform can send email.
   */
  emailVerifiedAt: at('email_verified_at'),
  /** The morning summary email: due today, overdue, today's reminders, unseen mentions (they can turn it off). */
  mentionEmails: boolean('mention_emails').notNull().default(true),
  /** Their time zone (IANA, e.g. Asia/Bangkok), from their browser: when "morning" is. Null: not known yet (UTC). */
  timeZone: text('time_zone'),
  /** Desktop notifications (on computers where they turned them on) for reminders, and for @mentions. */
  pushReminders: boolean('push_reminders').notNull().default(true),
  pushMentions: boolean('push_mentions').notNull().default(true),
  /** Email reminders as they fire, as well as the bell (they can turn it off). */
  reminderEmails: boolean('reminder_emails').notNull().default(true),
  /** When the last daily summary went out (at most one per 24 hours). */
  lastDigestAt: at('last_digest_at'),
  /** Their Inbox: where apps put tasks they add without naming a board. */
  inboxBoardId: text('inbox_board_id').references((): AnyPgColumn => boards.id, { onDelete: 'set null' }),
  disabledAt: at('disabled_at'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
})

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the cookie's token: a leaked database can't be used to sign in. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: at('created_at').notNull().defaultNow(),
    expiresAt: at('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

/** Site-wide settings (one row). */
export const siteSettings = pgTable('site_settings', {
  id: integer('id').primaryKey().default(1),
  openSignup: boolean('open_signup').notNull().default(SETTING_DEFAULTS.openSignup),
  /** Emails sent with the platform's key, per day / per month (keeps under the provider's free tier). Null: no limit. */
  emailDailyBudget: integer('email_daily_budget').default(SETTING_DEFAULTS.emailDailyBudget!),
  emailMonthlyBudget: integer('email_monthly_budget').default(SETTING_DEFAULTS.emailMonthlyBudget!),
  /** Board emails (invites) each person may send per month with the platform's key; their own key has no limit. Null: no limit. */
  userMonthlyAllowance: integer('user_monthly_allowance').default(SETTING_DEFAULTS.userMonthlyAllowance!),
  brandName: text('brand_name').notNull().default(SETTING_DEFAULTS.brandName),
  brandColor: text('brand_color').notNull().default(SETTING_DEFAULTS.brandColor),
  /** Shown at the bottom of every email (a postal address is often expected by anti-spam rules). */
  emailFooter: text('email_footer').notNull().default(SETTING_DEFAULTS.emailFooter),
  /** Attachment space each board owner gets in the site's storage (their own storage has no limit). */
  storageQuotaMb: integer('storage_quota_mb').notNull().default(SETTING_DEFAULTS.storageQuotaMb),
  /** Largest single file. */
  maxFileMb: integer('max_file_mb').notNull().default(SETTING_DEFAULTS.maxFileMb),
  apiTokens: boolean('api_tokens').notNull().default(SETTING_DEFAULTS.apiTokens),
  webhooks: text('webhooks', { enum: ['off', 'public', 'any'] })
    .notNull()
    .default(SETTING_DEFAULTS.webhooks),
  oauthApps: text('oauth_apps', { enum: ['off', 'known', 'any'] })
    .notNull()
    .default(SETTING_DEFAULTS.oauthApps),
  /** The site's key pair for desktop notifications (Web Push, "VAPID"): made on first use; the private half encrypted. */
  vapidPublicKey: text('vapid_public_key'),
  vapidPrivateKeyEncrypted: text('vapid_private_key_encrypted'),
})

// ── Email ──────────────────────────────────────────────────────────────────────

/** Where the site's SMTP server is and how to connect (its password is stored encrypted, like a key). */
export interface SmtpSettings {
  host: string
  port: number
  /** tls: encrypted from the start (usually 465) · starttls: upgrades after connecting (usually 587) · none: internal relays */
  security: 'tls' | 'starttls' | 'none'
  /** Null: the server doesn't ask for a sign-in (relays that trust the server's IP address). */
  username: string | null
  /** Accept a certificate the server signed itself (internal servers). */
  allowSelfSigned: boolean
}

/**
 * How email goes out: the platform's (user_id null) and people's own ("bring your own key", Resend only).
 * The platform's can be Resend or an SMTP server.
 */
export const emailSenders = pgTable(
  'email_senders',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['resend', 'smtp'] }).notNull(),
    /**
     * The secret: Resend's API key, or the SMTP password ('' when there's none). Encrypted with the server's
     * ENCRYPTION_KEY (see src/crypto.ts); never sent to browsers.
     */
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    /** What people see instead of the key: re_…a1b2 (Resend), or the SMTP server's address. */
    keyHint: text('key_hint').notNull(),
    /** SMTP only: the server and how to connect. */
    smtp: jsonb('smtp').$type<SmtpSettings>(),
    fromAddress: text('from_address').notNull(),
    /** The provider's reason the last send failed, while it keeps failing. */
    lastError: text('last_error'),
    failingSince: at('failing_since'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  // One per person, and one for the platform (NULLS NOT DISTINCT makes the platform row unique too).
  (t) => [unique('email_senders_user_unique').on(t.userId).nullsNotDistinct()],
)

/** One-time links sent by email: confirming an address, resetting a password. Only the SHA-256 is stored. */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['verify', 'reset', 'admin-reset'] }).notNull(),
    /** The address it was sent to (a verify link only counts for that address). */
    email: text('email').notNull(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [index('email_tokens_user_idx').on(t.userId)],
)

export const EMAIL_KINDS = ['verify', 'reset', 'invite', 'digest', 'test', 'notice', 'reminder'] as const
export type EmailKind = (typeof EMAIL_KINDS)[number]

/** Every email, queued then sent (with retries). Also what budgets and allowances are counted from. */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind', { enum: EMAIL_KINDS }).notNull(),
    /** 0: account emails (verify, reset), 1: board emails (invites). Board emails stop first when the budget runs low. */
    priority: integer('priority').notNull(),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    /** Who caused it (for their allowance and limits). */
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Sent with the requester's own key (doesn't count against the platform's budget). */
    usesOwnKey: boolean('uses_own_key').notNull().default(false),
    status: text('status', { enum: ['queued', 'sending', 'sent', 'failed'] })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: at('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    providerId: text('provider_id'),
    createdAt: at('created_at').notNull().defaultNow(),
    sentAt: at('sent_at'),
  },
  (t) => [
    index('email_outbox_due_idx').on(t.status, t.nextAttemptAt),
    index('email_outbox_requested_idx').on(t.requestedBy, t.createdAt),
    index('email_outbox_created_idx').on(t.createdAt),
  ],
)

// ── Workspaces: a group of people, and a place for their boards ────────────────

export const WORKSPACE_ROLES = ['admin', 'member'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: at('created_at').notNull().defaultNow(),
})

/** Admins manage the workspace's people; everyone in it can open its boards shared with the workspace. */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: WORKSPACE_ROLES }).notNull(),
    ...meta,
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('workspace_members_user_idx').on(t.userId)],
)

/** Joining a workspace (as a member): its invite link, and invites by email. Like board_invites. */
export const workspaceInvites = pgTable(
  'workspace_invites',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['link', 'email'] }).notNull(),
    token: text('token').notNull(),
    /** Email invites: who it's for (lowercased). */
    email: text('email'),
    /** Email invites: the link was shown to the inviter, so using it doesn't prove the address (see board_invites). */
    linkShown: boolean('link_shown').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: at('created_at').notNull().defaultNow(),
    revokedAt: at('revoked_at'),
  },
  (t) => [uniqueIndex('workspace_invites_token_idx').on(t.token), index('workspace_invites_workspace_idx').on(t.workspaceId)],
)

// ── Boards and who can use them ────────────────────────────────────────────────

export const VISIBILITIES = ['private', 'invited', 'workspace'] as const
export type Visibility = (typeof VISIBILITIES)[number]
export const ROLES = ['owner', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const boards = pgTable(
  'boards',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** What the board is for (people and assistants read it to tell boards apart). */
    description: text('description'),
    mode: text('mode', { enum: ['manual', 'derived'] }).notNull(),
    background: text('background'),
    /** private: owners only · invited: its members · workspace: its members and everyone in its workspace. */
    visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('invited'),
    /** Anyone with the link can view it, even signed out (not while it's private). */
    publicLink: boolean('public_link').notNull().default(false),
    /** The workspace it's in; null: its owner's Personal space. A workspace with boards in it can't be deleted. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    /** What everyone in the workspace can do on it, when it's shared with the workspace. */
    workspaceRole: text('workspace_role', { enum: ['editor', 'viewer'] })
      .notNull()
      .default('editor'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...meta,
    /** Goes up by one with every change to the board, so clients can tell if they missed one. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    /** Last change of any kind (for "updated 5 minutes ago"). */
    activityAt: at('activity_at').notNull().defaultNow(),
    /** Archived by an owner: read-only and off the boards page until restored. */
    archivedAt: at('archived_at'),
  },
  (t) => [index('boards_workspace_idx').on(t.workspaceId)],
)

export const boardMembers = pgTable(
  'board_members',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ROLES }).notNull(),
    ...meta,
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] }), index('board_members_user_idx').on(t.userId)],
)

/**
 * Share links and access codes (at most one active of each per board), and email invites (one per address,
 * usable once, only by that address).
 */
export const boardInvites = pgTable(
  'board_invites',
  {
    id: uuid('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['link', 'code', 'email'] }).notNull(),
    /** The link's secret, or the access code (stored without the dash, uppercase). */
    token: text('token').notNull(),
    /** Email invites: who it's for (lowercased). */
    email: text('email'),
    /**
     * Email invites: the link was shown to the inviter (the email couldn't be sent). Then signing up through it
     * doesn't prove the address is the new person's: the inviter could have used it themselves.
     */
    linkShown: boolean('link_shown').notNull().default(false),
    role: text('role', { enum: ['editor', 'viewer'] }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: at('created_at').notNull().defaultNow(),
    revokedAt: at('revoked_at'),
  },
  (t) => [uniqueIndex('board_invites_token_idx').on(t.token), index('board_invites_board_idx').on(t.boardId)],
)

// ── Board contents (the model's records) ───────────────────────────────────────
// Ids are only unique within a board (lists are called "todo", "doing"…), so keys are (board_id, id).

export const lists = pgTable(
  'lists',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    category: text('category', { enum: ['backlog', 'todo', 'doing', 'done'] }).notNull(),
    color: text('color'),
    position: text('position').notNull(),
    ...meta,
  },
  (t) => [primaryKey({ columns: [t.boardId, t.id] })],
)

export const labels = pgTable(
  'labels',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    ...meta,
  },
  (t) => [primaryKey({ columns: [t.boardId, t.id] })],
)

export const tasks = pgTable(
  'tasks',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    parentId: text('parent_id'),
    title: text('title').notNull(),
    description: text('description'),
    /** urgent · high · medium · low; null: none. */
    priority: text('priority', { enum: PRIORITIES }),
    /** Archived (with its subtasks): out of every view and count until restored. */
    archivedAt: at('archived_at'),
    /** Reminder[] (model/types.ts); null: none. */
    reminders: jsonb('reminders').$type<Reminder[]>(),
    /** The list it's in. */
    status: text('status').notNull(),
    /** Position among its siblings in the outline. */
    outlineOrder: text('outline_order').notNull(),
    /** Position in its board list, once placed by hand. */
    rank: text('rank'),
    /** A whole day (2026-10-15), or with a time a UTC moment (2026-10-15T07:30:00Z): see model/dates.ts. */
    start: text('start'),
    due: text('due'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    labels: text('labels').array().notNull().default([]),
    blockedBy: text('blocked_by').array().notNull().default([]),
    color: text('color'),
    ...meta,
  },
  (t) => [primaryKey({ columns: [t.boardId, t.id] }), index('tasks_assignee_idx').on(t.assigneeId)],
)

// ── Comments and notifications ─────────────────────────────────────────────────

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    /** People @mentioned (board members at the time). */
    mentions: uuid('mentions').array().notNull().default([]),
    createdAt: at('created_at').notNull().defaultNow(),
    editedAt: at('edited_at'),
  },
  (t) => [index('comments_task_idx').on(t.boardId, t.taskId, t.createdAt)],
)

/** Things to tell someone about (an @mention for now). Shown under the bell, and in the daily email summary. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** mention: in a comment (board, task, comment) · added: to a board or a workspace (one of the two). */
    kind: text('kind', { enum: ['mention', 'added', 'reminder'] }).notNull(),
    boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: text('task_id'),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: at('created_at').notNull().defaultNow(),
    readAt: at('read_at'),
    /** Included in a daily email summary. */
    emailedAt: at('emailed_at'),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
)

// ── File storage and attachments ───────────────────────────────────────────────

/**
 * Where files go: the platform's storage (user_id null; without a row, the server's disk) and people's own
 * S3-compatible buckets ("bring your own storage"). The secret is encrypted like email keys.
 */
export const storageBackends = pgTable(
  'storage_backends',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['s3'] }).notNull(),
    endpoint: text('endpoint').notNull(),
    region: text('region').notNull(),
    bucket: text('bucket').notNull(),
    accessKeyId: text('access_key_id').notNull(),
    secretEncrypted: text('secret_encrypted').notNull(),
    keyHint: text('key_hint').notNull(),
    lastError: text('last_error'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
    /**
     * Replaced by other storage (or switched back to the server's disk). Kept, because files saved here still
     * open from here. At most one row per person (and one for the platform) isn't retired.
     */
    retiredAt: at('retired_at'),
  },
  (t) => [index('storage_backends_user_idx').on(t.userId)],
)

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    uploaderId: uuid('uploader_id').references(() => users.id, { onDelete: 'set null' }),
    /** Whose quota it counts against: the board's owner when it was uploaded (unless it's in a workspace). */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    /** The workspace whose space it counts against, for boards in a workspace (instead of `ownerId`'s). */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    /**
     * Where the bytes are: 'disk' (the server's disk) or 's3'. `backendId` is the storage_backends row for s3
     * (kept even if that storage is later changed, so old files still open). `ownStorage` = the owner's own bucket.
     */
    backend: text('backend', { enum: ['disk', 's3'] }).notNull(),
    backendId: uuid('backend_id'),
    ownStorage: boolean('own_storage').notNull().default(false),
    storageKey: text('storage_key').notNull(),
    name: text('name').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    /** In the trash: restorable for 30 days, then removed for good. */
    deletedAt: at('deleted_at'),
    /** Trashed because its card was deleted: comes back by itself if the card does (undo). */
    orphaned: boolean('orphaned').notNull().default(false),
    /** Attached to a comment (null: attached to the card itself). */
    commentId: uuid('comment_id'),
    /** Uploaded while writing a comment, not posted yet (removed after a day if it never is). */
    draft: boolean('draft').notNull().default(false),
  },
  (t) => [
    index('attachments_task_idx').on(t.boardId, t.taskId),
    index('attachments_owner_idx').on(t.ownerId),
    index('attachments_workspace_idx').on(t.workspaceId),
  ],
)

// ── Integrations: API tokens and webhooks ───────────────────────────────────────

/**
 * A personal API token: acts as its person (with their access), for scripts, integrations and AI assistants. Only
 * its SHA-256 is stored. `read` tokens can only look; `write` tokens can also change boards.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** The start and end of the token, to recognise it (kbt_ab…wxyz). */
    hint: text('hint').notNull(),
    scope: text('scope', { enum: ['read', 'write'] }).notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    lastUsedAt: at('last_used_at'),
    expiresAt: at('expires_at'),
  },
  (t) => [uniqueIndex('api_tokens_hash_idx').on(t.tokenHash), index('api_tokens_user_idx').on(t.userId)],
)

/** Where a board's changes are sent: an address that gets a signed POST for each change. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** For signing deliveries (HMAC-SHA256), encrypted like other secrets. */
    secretEncrypted: text('secret_encrypted').notNull(),
    active: boolean('active').notNull().default(true),
    /** The events it's sent (board.changed, comment.added, reminder.due); null: all of them. */
    events: text('events').array(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: at('created_at').notNull().defaultNow(),
    /** How the last delivery went. */
    lastDeliveryAt: at('last_delivery_at'),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
  },
  (t) => [index('webhooks_board_idx').on(t.boardId)],
)

/** Each delivery waits here until it's sent (retried with growing delays), and is kept a week for the log. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: at('next_attempt_at').notNull().defaultNow(),
    responseStatus: integer('response_status'),
    /** The start of what the address answered (up to 2 KB), for the log. */
    responseBody: text('response_body'),
    lastError: text('last_error'),
    createdAt: at('created_at').notNull().defaultNow(),
    sentAt: at('sent_at'),
  },
  (t) => [index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt), index('webhook_deliveries_hook_idx').on(t.webhookId, t.createdAt)],
)

// ── Apps connected with sign-in (OAuth 2.1, for MCP) ────────────────────────────

/** An app that registered itself (dynamic client registration), like Claude or ChatGPT. */
export const oauthClients = pgTable('oauth_clients', {
  /** The client_id it was given. */
  id: text('id').primaryKey(),
  /** What it calls itself (shown on the consent page, with where it sends people back to). */
  name: text('name').notNull(),
  redirectUris: text('redirect_uris').array().notNull(),
  /** SHA-256 of its client secret, for apps that asked for one; null: a public app (PKCE only). */
  secretHash: text('secret_hash'),
  createdAt: at('created_at').notNull().defaultNow(),
})

/** A one-time code from the consent page, exchanged for tokens within minutes (only its hash is stored). */
export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope', { enum: ['read', 'write'] }).notNull(),
  expiresAt: at('expires_at').notNull(),
})

/**
 * Someone allowed an app: its access token (short-lived) and refresh token (replaced each time it's used). Only
 * hashes are stored. Deleting the row disconnects the app.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: uuid('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['read', 'write'] }).notNull(),
    accessHash: text('access_hash').notNull(),
    accessExpiresAt: at('access_expires_at').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    refreshExpiresAt: at('refresh_expires_at').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    lastUsedAt: at('last_used_at'),
  },
  (t) => [
    uniqueIndex('oauth_grants_access_idx').on(t.accessHash),
    uniqueIndex('oauth_grants_refresh_idx').on(t.refreshHash),
    index('oauth_grants_user_idx').on(t.userId),
  ],
)

/**
 * What happened on a board, as short lines of text ("moved “Deploy” to Done"), one row per change that said something.
 * For "what's new" (the MCP tool recent_activity). Kept 90 days.
 */
export const boardActivity = pgTable(
  'board_activity',
  {
    id: uuid('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    at: at('at').notNull().defaultNow(),
    /** The command's type (task.move, records.restore for undo, …). */
    command: text('command').notNull(),
    /** ActivityItem[] (model/activity.ts). */
    items: jsonb('items').notNull(),
    /** The app it was made through ("Claude", "API"); null: the website. */
    via: text('via'),
  },
  (t) => [index('board_activity_board_idx').on(t.boardId, t.at)],
)

/**
 * Reminders that went out: one row per reminder per moment, so each fires once. (If its moment changes, e.g. the due
 * date moves, the new moment is a new row and it fires again then.)
 */
export const reminderSends = pgTable(
  'reminder_sends',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    reminderId: text('reminder_id').notNull(),
    fireAt: at('fire_at').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    sentAt: at('sent_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.taskId, t.reminderId, t.fireAt] }), index('reminder_sends_user_idx').on(t.userId, t.sentAt)],
)

/** Browsers where someone turned on desktop notifications (Web Push subscriptions). */
export const pushDevices = pgTable(
  'push_devices',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Where the browser's push service takes messages for it (unique per browser). */
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** Which browser, in words ("Chrome on Mac"), to tell devices apart. */
    label: text('label').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    lastUsedAt: at('last_used_at'),
  },
  (t) => [index('push_devices_user_idx').on(t.userId)],
)
