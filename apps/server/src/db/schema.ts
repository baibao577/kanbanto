import { SETTING_DEFAULTS } from './defaults'
import { bigint, boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
  /** Email a daily summary of @mentions (they can turn it off). */
  mentionEmails: boolean('mention_emails').notNull().default(true),
  /** When the last daily summary went out (at most one per 24 hours). */
  lastDigestAt: at('last_digest_at'),
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

export const EMAIL_KINDS = ['verify', 'reset', 'invite', 'digest', 'test', 'notice'] as const
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

// ── Boards and who can use them ────────────────────────────────────────────────

export const VISIBILITIES = ['private', 'invited', 'public'] as const
export type Visibility = (typeof VISIBILITIES)[number]
export const ROLES = ['owner', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const boards = pgTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mode: text('mode', { enum: ['manual', 'derived'] }).notNull(),
  background: text('background'),
  /** private: owners only · invited: members · public: members, and anyone with the link can view. */
  visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('invited'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...meta,
  /** Goes up by one with every change to the board, so clients can tell if they missed one. */
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
  /** Last change of any kind (for "updated 5 minutes ago"). */
  activityAt: at('activity_at').notNull().defaultNow(),
})

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
    /** The list it's in. */
    status: text('status').notNull(),
    /** Position among its siblings in the outline. */
    outlineOrder: text('outline_order').notNull(),
    /** Position in its board list, once placed by hand. */
    rank: text('rank'),
    start: date('start', { mode: 'string' }),
    due: date('due', { mode: 'string' }),
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
    kind: text('kind', { enum: ['mention'] }).notNull(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
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
    /** Whose quota it counts against: the board's owner when it was uploaded. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
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
  (t) => [index('attachments_task_idx').on(t.boardId, t.taskId), index('attachments_owner_idx').on(t.ownerId)],
)
