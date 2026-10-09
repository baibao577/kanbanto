import type { BoardField, FieldDef } from './fields'
import type { Passage } from './passages'
import type { PresetSettings } from './prefs'
import type { ReactionView } from './reactions'
import type { Change } from './records'
import type { CardDate, CardMomentKind, CardSort, CardState } from './search'
import type { BoardData, Category, Priority, Task } from './types'
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
  /**
   * Their profile picture: a path on this site (`/api/pictures/…`, a new one whenever the picture changes), or null
   * when they have none and show as their initials. The same wherever a person comes with a `picture`.
   */
  picture: string | null
  /** Platform admin (the people running the site; granted on the server, never by signing up). */
  isAdmin: boolean
  /** Confirmed their email address, or a platform admin vouched for it (required once the site can send email). */
  emailVerified: boolean
  /** Has a password to sign in with. Someone who only ever signed in with Google has none, and can add one. */
  hasPassword: boolean
  /** Gets the daily email summary of @mentions. */
  mentionEmails: boolean
  /** Gets reminders by email as well as under the bell. */
  reminderEmails: boolean
  /** Their time zone (IANA), for when "morning" is; null until their browser says. */
  timeZone: string | null
  /** Desktop notifications (on computers where they're turned on) for reminders, and for @mentions. */
  pushReminders: boolean
  pushMentions: boolean
  /** …and for news from cards they follow. */
  pushFollows: boolean
  /** The same three through a Telegram bot they connected to their own chat, when they have one. */
  telegramReminders: boolean
  telegramMentions: boolean
  telegramFollows: boolean
}

/** A link to one of the site's own pages (its privacy policy, terms…), or to anywhere else. */
export interface SiteLink {
  label: string
  /** A page on this site (/privacy), or a full address. */
  url: string
}

/** GET /api/auth/me */
export interface Me {
  user: PublicUser | null
  /** Someone without an invite can create an account (with the form, or only with Google: see `signupGoogleOnly`). */
  openSignup: boolean
  /** …but only with Google: the sign-up form is for people with an invite. */
  signupGoogleOnly: boolean
  /** The site can send email: password reset works, and new accounts must confirm their email. */
  emailEnabled: boolean
  /** People can sign in, and sign up, with Google here. */
  googleSignIn: boolean
  /** Links the site's operator shows under the sign-in form (none by default). */
  links: SiteLink[]
  /** Where "Guides" in the account menu goes: how to use Kanbanto. Null: the site has taken the item out. */
  guidesUrl: string | null
  /**
   * Which Kanbanto the site runs, for people who are signed in (null for a visitor): the release's number ("0.1.0"),
   * and the day this copy was built ("2026-10-07"; null when it runs straight from the source).
   */
  version: { number: string; built: string | null } | null
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
  digest: 'Morning summary',
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
  /** Your Inbox: yours alone, so it can't be shared, moved, archived or deleted. */
  inbox: boolean
}

/**
 * Comments and attachments per task (for the badges on cards), each task's latest comment (for card age), and the
 * minutes logged on each (not for visitors with the public link).
 */
export interface TaskCounts {
  comments: Record<string, number>
  attachments: Record<string, number>
  lastComment: Record<string, string>
  time: Record<string, number>
}

/** GET /api/boards/:id */
export interface BoardSnapshot {
  /** The board, without its archived cards (see ArchivedPage) unless asked for with `?archived=all`. */
  data: BoardData
  /** The board's change counter when this was read. */
  seq: number
  access: BoardAccess
  counts: TaskCounts
  /** You can comment (members, including viewers; not anonymous visitors of public boards). */
  canComment: boolean
  /**
   * What the cards' links point at, for you (see LinkedCard), by link: cards on other boards, and ones no longer
   * among this board's active cards. Up to 2,000; the rest are asked for from `/boards/:id/linked`.
   */
  linked?: Record<string, LinkedCard>
  /** Some card link in this board's space is in use, so a card here may have cards linking to it. */
  canBeLinked?: boolean
}

/** GET /api/boards/:id/archived: archived cards as the board keeps them, newest first by the date asked about. */
export interface ArchivedPage {
  tasks: Task[]
  /** How many there are in all (in the range asked for). */
  total: number
  /** Pass back as `offset` for the next page; null at the end. */
  nextOffset: number | null
}

export interface CommentView {
  id: string
  taskId: string
  author: { id: string; name: string; picture?: string | null } | null
  body: string
  /** People @mentioned in it. */
  mentions: string[]
  /** Files attached to the comment. */
  attachments: AttachmentView[]
  /** The emoji people answered it with (see reactions.ts), in the order they're offered. None: an empty list. */
  reactions: ReactionView[]
  createdAt: string
  editedAt: string | null
  /**
   * It is about some words of the card's description (see passages.ts): the words, and a little of the text around
   * them. It starts a thread: others answer it (`parentId`), and it is resolved when the matter is settled.
   */
  passage?: Passage | null
  /** It answers a comment about a passage: that comment's id. */
  parentId?: string | null
  /** A comment about a passage: when it was resolved, and by whom (null: their account is gone). Null: it is open. */
  resolved?: { at: string; by: { id: string; name: string } | null } | null
}

/** Time someone logged on a card. */
export interface TimeEntryView {
  id: string
  boardId: string
  taskId: string
  /** Who logged it (null: their account is gone). */
  user: { id: string; name: string; picture?: string | null } | null
  /** The day it counts for, "2026-10-02". */
  day: string
  minutes: number
  note: string
  createdAt: string
  updatedAt: string
  /** Someone else changed it since (a board owner or workspace admin fixing it). */
  editedBy: { id: string; name: string } | null
  /** You may change or delete it. */
  canEdit: boolean
}

/** GET /api/boards/:id/time/mine?day=: what the log box suggests on a board for one day. */
export interface TimeMine {
  day: string
  /** Cards you touched that day on this board (moved, changed, commented on), latest first. */
  touched: string[]
  /** Cards on this board you logged time on lately, latest first. */
  recent: string[]
  /** Minutes you logged that day, on all your boards. */
  logged: number
  /** Your hours a day: from Planning in the board's workspace, or 8. */
  hoursPerDay: number
}

/** GET /api/time/week?from=: your week across boards ("My week"). */
export interface WeekView {
  /** The Monday it starts on. */
  from: string
  hoursPerDay: number
  entries: TimeEntryView[]
  /** The rows: cards you logged on, touched or are assigned to (open), with where they are. */
  cards: { boardId: string; taskId: string; title: string; parent: string | null; boardName: string; done: boolean; canLog: boolean }[]
  /** The days you touched each card, by `${boardId}:${taskId}`. */
  touched: Record<string, string[]>
}

/** How long a notification that has been read is kept: this many months after it came. Unread ones stay. */
export const NOTIFICATIONS_KEPT_MONTHS = 3

/**
 * Under the bell, and on the page of them all: someone @mentioned you, something happened on a card you follow, one
 * of a board's rules told you, a reminder, or someone added you to a board or a workspace.
 */
export type NotificationView =
  | {
      id: string
      kind: 'mention'
      actor: string
      board: { id: string; name: string }
      task: { id: string; title: string }
      /** Where: a comment, or the card's description. */
      where: 'comment' | 'description'
      /** The start of the comment, or the line of the description. */
      excerpt: string
      /**
       * The words of the description the comment is about, or the thread it answers is (see passages.ts), and
       * that thread's first comment: where to open the description's full page.
       */
      about?: string
      thread?: string
      createdAt: string
      read: boolean
      /** You turned it back to unread yourself, to come back to it (see `PUT /api/notifications/{id}/read`). */
      kept: boolean
    }
  | {
      id: string
      /** A new comment on a card you follow. */
      kind: 'comment'
      actor: string
      board: { id: string; name: string }
      task: { id: string; title: string }
      /** The start of the comment. */
      excerpt: string
      /**
       * The words of the description the comment is about, or the thread it answers is (see passages.ts), and
       * that thread's first comment: where to open the description's full page.
       */
      about?: string
      thread?: string
      createdAt: string
      read: boolean
      /** You turned it back to unread yourself, to come back to it (see `PUT /api/notifications/{id}/read`). */
      kept: boolean
    }
  | {
      id: string
      /** Someone resolved a comment of yours about a passage of a description. */
      kind: 'resolved'
      actor: string
      board: { id: string; name: string }
      task: { id: string; title: string }
      /** The words it was about, the comment itself (to open the full page at), and the start of what it said. */
      about: string
      thread: string
      excerpt: string
      createdAt: string
      read: boolean
      /** You turned it back to unread yourself, to come back to it (see `PUT /api/notifications/{id}/read`). */
      kept: boolean
    }
  | {
      id: string
      /** People answered a comment of yours with an emoji. One line for a comment, however many did. */
      kind: 'reaction'
      /** Who did last. */
      actor: string
      board: { id: string; name: string }
      task: { id: string; title: string }
      /** Everyone whose reaction is on the comment now, by name, and the emoji they used. */
      people: string[]
      emoji: string[]
      /** The start of your comment. */
      excerpt: string
      createdAt: string
      read: boolean
      /** You turned it back to unread yourself, to come back to it (see `PUT /api/notifications/{id}/read`). */
      kept: boolean
    }
  | {
      id: string
      /** Something happened to a card you follow. */
      kind: 'change'
      actor: string
      board: { id: string; name: string }
      task: { id: string; title: string }
      /** What, in words that follow the actor's name ("moved “Deploy” to Done"), oldest first. */
      changes: string[]
      createdAt: string
      read: boolean
      /** You turned it back to unread yourself, to come back to it (see `PUT /api/notifications/{id}/read`). */
      kept: boolean
    }
  | {
      id: string
      /** One of the board's rules told you: cards arrived in its cards, or left them (see model rules.ts). */
      kind: 'rule'
      /** Who made the change. */
      actor: string
      board: { id: string; name: string }
      /** The first of the cards (to open; a card that left by being deleted is no longer there). */
      task: { id: string; title: string }
      /** The rule: its id, to stop it telling you (null once the rule is removed), and its name when it has one. */
      rule: { id: string | null; name: string }
      /** What happened, in words to follow the cards' titles ("arrived in Quoted"). */
      moment: string
      /** The cards, by the titles they had then: the first ones, and how many more there were. */
      cards: { id: string; title: string }[]
      more: number
      createdAt: string
      read: boolean
      /** You turned it back to unread yourself, to come back to it (see `PUT /api/notifications/{id}/read`). */
      kept: boolean
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
      /** You turned it back to unread yourself, to come back to it (see `PUT /api/notifications/{id}/read`). */
      kept: boolean
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
      /** You turned it back to unread yourself, to come back to it (see `PUT /api/notifications/{id}/read`). */
      kept: boolean
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
  /** Where its small copy is, when it has one (a picture that is, or was, a card's cover): what a list of pictures draws. */
  thumb?: string
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
  /** Your Inbox (see GET /api/inbox): it has its own place in the app, beside every board. */
  inbox: boolean
  /** Its letters: what its cards' names start with (WEB in WEB-12). Null only on a board not yet given any. */
  code: string | null
  /** The letters it had before (a name written with them still means its card). Left out: none. */
  pastCodes?: string[]
}

/** GET and POST /api/inbox: your Inbox board (null: not made yet), and how many of its cards aren't done. */
export interface InboxInfo {
  boardId: string | null
  open: number
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
  /** Words in the title, the description or a comment, or a card's name (WEB-12). */
  q?: string
  /** `titles`: `q` looks at names and titles only (quick, for a list that answers as someone types). */
  in?: 'titles'
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
  /**
   * A test of the due date: `overdue`, `week` (the next 7 days), `none`, a word (`today`, `tomorrow`, `this-week`,
   * `next-month`, …), `next-30` or `last-7` (days), or days as `2026-10-01..2026-10-31` (see `dueFromText`).
   */
  due?: string
  /** The time zone "today" is in, and the day a date with a time falls on. The one on your account, when unset. */
  timeZone?: string
  /** Which of a card's dates `from`..`to` is about (any of them, by default); alone, only cards that have that date. */
  when?: CardDate
  /** Moments (ISO): from this one up to, not including, that one. */
  from?: string
  to?: string
  /** `hide`: only cards without subtasks. */
  parents?: 'hide'
  /** Only the cards you follow (you're told about their comments and changes). */
  following?: boolean
  /**
   * One of the boards' own fields, by id: each card then says what it has for it (`field`). With `fv`, only the cards
   * whose value passes, on the boards that use the field: a choice's option ids with commas (`-`: none picked), `yes`
   * or `no` for a checkbox, `any` or `none` (has a value or not) for the rest; text also `~word` (contains), `=word`
   * (is), `!~word`, `!=word`; a date also `past`, `week`, and what `due` takes; a number also a range, `10..200`; a
   * list after `!` means none of them (see `filterFromText`).
   */
  field?: string
  fv?: string
  sort?: CardSort
  offset?: number
  limit?: number
}

/** A card, as a row: enough to recognise it and act on it, plus where it lives. */
export interface CardRow {
  id: string
  /** Its name, like WEB-12 (left out on a card that has none yet). */
  ref?: string
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
  /** Their profile picture, when they have one. */
  assigneePicture?: string
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
  /** Asked about a field (`CardsQuery.field`): what this card has for it, in words. Left out when it has nothing. */
  field?: { name: string; text: string }
  /** You can restore or delete it (an editor, on a board that isn't archived). */
  canEdit: boolean
}

export interface CardsPage {
  cards: CardRow[]
  total: number
  /** Pass back as `offset` for the next page; null at the end. */
  nextOffset: number | null
  /** On the first page: the labels, people and fields of the boards searched, to filter by. */
  labels?: string[]
  people?: { id: string; name: string; picture?: string | null }[]
  fields?: FieldDef[]
}

export interface SharingMember {
  userId: string
  name: string
  picture: string | null
  /** Owners see everyone's; others only their own. */
  email?: string
  role: Role
}

/**
 * What a link points at, as one person may see it: the card (its list as it reads on its board; an archived one has
 * the list it was archived from, if known, and no kind), `gone` when it was deleted, or `hidden` when it's on a board
 * they can't open. `hidden` says nothing about whether the card exists.
 */
export type LinkedCard =
  | { title: string; board: { id: string; name: string }; list: string | null; kind: Category | null; done: boolean; archived?: true }
  | { gone: true }
  | { hidden: true }

/** A card offered by a link field's picker (GET /api/boards/:id/fields/:fieldId/cards). */
export interface LinkPick {
  /** The link to store (see `linkRef`). */
  ref: string
  title: string
  board: { id: string; name: string }
  list: string
  kind: Category
  done: boolean
  /** Its parents' titles, top first. */
  path: string[]
}

/** The cards on one board that link to a card through one field. */
export interface LinkedFromGroup {
  board: { id: string; name: string; background: string | null }
  /** The field they link through; `back` is what its owner called this list ("Deals"). */
  field: { id: string; name: string; back?: string }
  /** The first 50, in their board's outline order. */
  cards: { id: string; title: string; list: string; kind: Category; done: boolean }[]
  count: number
  /** What those cards add up to, for that board's numbers that add up ("Deal value", "$34,500"). */
  totals: { name: string; text: string }[]
}

/** Who links to a card (GET /api/boards/:id/tasks/:taskId/linked-from). */
export interface LinkedFrom {
  groups: LinkedFromGroup[]
  /** Cards that link to it from boards you can't open: only how many. */
  hidden: number
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

// ── Custom fields (see fields.ts) ──────────────────────────────────────────────

/** A field in a library, as the screen that manages it shows it. */
export interface FieldView extends FieldDef {
  /** Archived: hidden on every board, its values kept; it can be restored. */
  archivedAt: string | null
  /** How many boards use it now. */
  boards: number
}

/** A library of fields: a workspace's (GET /api/workspaces/:id/fields) or your own (GET /api/fields). */
export interface FieldLibraryView {
  fields: FieldView[]
  /** You may add, change, archive and delete them (a workspace's admins; always, for your own). */
  canManage: boolean
}

/** What deleting a field for good would take away (GET …/fields/:fieldId/usage). */
export interface FieldUsage {
  boards: number
  cards: number
}

/**
 * What merging a field into another would do (GET …/fields/:fieldId/merge?into=), in numbers only: whoever manages
 * a library can't necessarily open every board that uses it.
 */
export interface FieldMerge {
  /** Cards that hold a value for the field that goes, and how many boards they're on. */
  cards: number
  boards: number
  /** Of those cards, the ones that also hold a value for the kept field: they keep one of the two (the one their board shows). */
  both: number
  /** Options the kept field would get (a choice). */
  options: string[]
  /** What the two fields say differently, where the kept field's way will stand: "unit", "sum" (it adds up), "format", "many". */
  differs: ('unit' | 'decimals' | 'sum' | 'format' | 'many')[]
  /** Why it can't be done, when it can't. */
  problem?: string
}

/** A board's fields (GET /api/boards/:id/fields). */
export interface BoardFieldsView {
  /** The ones it uses, in order. */
  fields: BoardField[]
  /** For its owners: the fields of its library that could be added. */
  available: FieldDef[]
  /** You may choose this board's fields (its owners). */
  canPick: boolean
  /** Where its fields come from: a workspace's library, or (null) the Personal library of whoever is picking. */
  workspace: { id: string; name: string } | null
  /** You may add to that library and change it. */
  canManage: boolean
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
  picture: string | null
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
  /** The profile pictures of the people in the plan who have one, by account. */
  pictures: Record<string, string>
  /** The workspace's boards you can open: what a project can be linked to. */
  boards: { id: string; name: string; background: string | null }[]
  /** Time logged on linked boards' cards: minutes by board, then by account (see planActuals). */
  actuals: Record<string, Record<string, number>>
}

/**
 * GET /api/boards/:id/plan: the plan for a board's project (a workspace's plan can link a project to a board), for
 * its Timeline. Only for people in that workspace; null for everyone else, or when no project is linked.
 */
export interface BoardPlan {
  plan: {
    workspaceId: string
    /** prospect: it might not happen (see PlanProject). */
    project: { id: string; name: string; plannedMd: number | null; color: ColorName; prospect: boolean }
    /** Man-days on it, and the part nobody has yet. */
    scheduled: number
    unassigned: number
    /** One per person on it (earliest first), then each "not assigned yet" line with time on it. */
    lines: { key: string; name: string | null; picture?: string; role: string | null; blocks: { start: string; end: string; pct: number }[] }[]
  } | null
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
  picture: string | null
  isAdmin: boolean
  emailVerified: boolean
  disabled: boolean
  createdAt: string
  /** Boards they own. */
  boards: number
}

/**
 * GET /api/boards/:id/tasks/:taskId/activity: what happened to one card, newest first, from the board's activity log
 * (which goes back 180 days). For the board's people, not visitors with its public link. Comments aren't in it.
 */
export interface CardHistory {
  entries: CardHistoryEntry[]
  /** Pass back as `until` for the ones before these; null at the end. */
  nextUntil: string | null
}

/** One change to a card: who made it, when, through which app, and what it did. */
export interface CardHistoryEntry {
  at: string
  /** Null: their account is gone. */
  actor: { id: string; name: string; picture?: string | null } | null
  /** The app it was made through ("Claude", "API", "Telegram"); null: the website. */
  via: string | null
  /**
   * What it did to the card, in words to follow the person's name: "moved it from To Do to Doing". `{date}` in one
   * stands for `date` (a day or a moment), to be written in the reader's own words. Lines logged before the card's
   * own wording was kept name the card: "moved “Deploy” to Doing".
   */
  lines: { text: string; date?: string }[]
}

/**
 * An earlier version of a card's description: the whole text as it was saved at a moment (see the server's
 * boards/versions.ts). A person's saves within a few minutes are one version, the last of them.
 */
export interface DescriptionVersion {
  id: string
  at: string
  /** Who saved it. Null: their account is gone, or it is the text there was before versions were kept. */
  by: { id: string; name: string; picture?: string | null } | null
  /** The app it was saved through ("Claude"); null: the website. */
  via: string | null
  /** How long the text is, in characters. */
  length: number
}
/** GET /api/boards/:id/tasks/:taskId/versions: newest first. (One of them with its text: …/versions/:versionId.) */
export interface DescriptionVersions {
  versions: DescriptionVersion[]
}

/** What the server sends over a board's live connection. */
export type LiveMessage =
  /** Sent on connect: the board's change counter, so the client knows if it missed anything. */
  | { type: 'hello'; seq: number }
  /** Changes someone made (the mutation id lets the sender recognize its own). */
  | { type: 'changes'; seq: number; changes: Change[]; mutationId?: string }
  /** Something outside the board data changed (people, sharing): fetch the board again. */
  | { type: 'reload' }
  /** The board's card templates changed (one was saved, renamed or removed): ask for them again. */
  | { type: 'templates' }
  /** You can no longer open this board (removed, or it became private). */
  | { type: 'access-lost' }
  /** Your session ended (password changed elsewhere, account turned off): sign in again. */
  | { type: 'signed-out' }
  | { type: 'deleted' }
  // (reacted: someone added or took back an emoji; the comment comes whole, as for an edit.)
  | { type: 'comment'; taskId: string; action: 'added' | 'edited' | 'deleted' | 'reacted' | 'resolved'; commentId: string; comment?: CommentView }
  | { type: 'attachment'; taskId: string; action: 'added' | 'deleted'; attachmentId: string; attachment?: AttachmentView }
  /** Time was logged, changed or removed on a card: its new total (minutes). */
  | { type: 'time'; taskId: string; total: number }
  /** Who is writing a card's description at this moment (nobody: an empty list). See `DocMessage`. */
  | { type: 'writing'; taskId: string; people: { id: string; name: string }[] }
  | DocMessage

/**
 * Which elements the editor of a description knows (the web's components/text/elements.ts): 1 since callouts.
 * Raised whenever the editor learns one. Browsers writing a text together must all know the same ones: an editor
 * drops what it doesn't know from the text they share, for everyone. So the server takes into a session only
 * browsers on the version it was built with; one that was opened before an update is refused, and writes once its
 * page has been loaded again.
 */
export const EDITOR_VERSION = 1

/**
 * A description being written by several people at once: what the server sends a browser that has it open (see the
 * server's boards/liveDocs.ts). The text while it is written is a Yjs document; `state`, `vector`, `data` and
 * `awareness` are parts of it, as base64.
 */
export type DocMessage =
  /**
   * The answer to "join": the session's id, its document so far, and what the server has of it (`vector`). `same`:
   * the browser was in this very session before (its document goes on, and what it wrote meanwhile is sent back);
   * otherwise it starts a new document from `state`. `seed`: it is the one to load the saved text into it.
   */
  | { type: 'doc'; op: 'joined'; taskId: string; session: string; same: boolean; seed: boolean; state: string; vector: string; awareness: string }
  /** A change someone made, or where their cursors are. */
  | { type: 'doc'; op: 'update' | 'awareness'; taskId: string; data: string }
  /**
   * seed: load the saved text after all (whoever was asked left first). reset: this browser isn't in the card's
   * session (it ended, the text was changed from somewhere else, or the server started again): join again.
   * ended: the card is gone (deleted, archived, moved to another board).
   */
  | { type: 'doc'; op: 'seed' | 'reset' | 'ended'; taskId: string }
  /**
   * It can't join, with why: it may only read, or (`reload`) its page was opened before the app was updated and
   * has to be loaded again first (see EDITOR_VERSION).
   */
  | { type: 'doc'; op: 'refused'; taskId: string; error: string; reload?: boolean }

/** What a browser sends over a board's live connection: only this, about a description it has open for writing. */
export type DocRequest =
  /**
   * `session`: the session it was in before, when it is coming back after losing its connection. `client`: the id
   * its document writes under. `seeder`: it loaded the saved text into its document itself (if that never reached
   * the server and someone else has loaded it since, its document can't go on: the text would be there twice).
   * `editor`: its EDITOR_VERSION (left out by browsers from before there was one).
   */
  | { type: 'doc'; op: 'join'; taskId: string; session?: string; client?: number; seeder?: boolean; editor?: number }
  | { type: 'doc'; op: 'update'; taskId: string; session: string; data: string }
  | { type: 'doc'; op: 'awareness'; taskId: string; data: string }
  | { type: 'doc'; op: 'leave'; taskId: string }

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

/**
 * How a webhook's messages are written: Kanbanto's own data, signed (`json`), or a short text that a chat app shows
 * in a channel.
 */
export const WEBHOOK_FORMATS = ['json', 'slack', 'google-chat', 'teams', 'discord', 'telegram'] as const
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number]
/** The formats that are text for a chat app. */
export type ChatFormat = Exclude<WebhookFormat, 'json'>
/** The chat apps that give a channel an address to paste. (Telegram is a bot of the board's own instead.) */
export type AddressChatFormat = Exclude<ChatFormat, 'telegram'>
export const WEBHOOK_FORMAT_NAMES: Record<WebhookFormat, string> = {
  json: 'Another app',
  slack: 'Slack',
  'google-chat': 'Google Chat',
  teams: 'Microsoft Teams',
  discord: 'Discord',
  telegram: 'Telegram',
}

/** A board's Telegram bot (a webhook whose format is telegram). */
export interface TelegramBotView {
  /** The bot's @name, without the @. */
  bot: string
  /** The chat it's connected to: someone's own chat with it, or a group. Null: waiting for the code to be sent to it. */
  chat: { kind: 'private' | 'group'; name: string } | null
  /** Messages in the chat become cards on the board. */
  takesCards: boolean
  /** The list those cards go to (null: the board's first list of not-started work). */
  cardsTo: string | null
  /** Why it isn't working, when it isn't. */
  problem: string | null
}

/** How a chat is connected to a board's Telegram bot: a code to send it, good for a few minutes, and links that send it. */
export interface TelegramConnect {
  code: string
  /** Opens the bot in Telegram with the code ready to send (your own chat with it). */
  privateLink: string
  /** Lets you pick a group to add the bot to, and sends the code there. */
  groupLink: string
  minutes: number
}

export interface WebhookView {
  id: string
  url: string
  format: WebhookFormat
  /** Its Telegram bot, when that is its format. */
  telegram?: TelegramBotView
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
  /** While sign-up is open: new accounts are only made with Google (needs `googleSignIn`). */
  signupGoogleOnly: boolean
  apiTokens: boolean
  webhooks: WebhookMode
  oauthApps: OAuthMode
  /** People can make a private calendar link. */
  calendarLinks: boolean
  /** Board owners can connect a Telegram bot of their own to a board. */
  telegramBots: boolean
  /** People can sign in, and sign up, with Google (needs the site's Google app). */
  googleSignIn: boolean
}

/** GET /api/admin/calendar/google: the site's Google app, for people's Google Calendar connections and for signing in with Google. */
export interface AdminGoogleCalendar {
  clientId: string | null
  /** An ID and a secret are saved (the secret is never shown). */
  configured: boolean
  /** The address to add to the Google app, under "Authorized redirect URIs". */
  redirectUri: string
  /** A second address to add there, for signing in with Google. */
  signInRedirectUri: string
  /** How many people have connected their Google Calendar. */
  connections: number
}

/** GET /api/account/calendar: your calendar link, your Google Calendar connection, and which boards are in them. */
export interface AccountCalendar {
  /** Calendar links are turned on for this site (by a platform admin). */
  linksEnabled: boolean
  /** This site can connect to Google Calendar (a platform admin set up its Google app). */
  googleEnabled: boolean
  /** Your link, if you made one: an address calendar apps subscribe to. */
  link: { url: string; createdAt: string } | null
  google: {
    /** The Google account, when Google said which. */
    email: string | null
    connectedAt: string
    lastSyncedAt: string | null
    /** The last problem, in words (null: none). */
    problem: string | null
    /** Google no longer accepts the connection: it has to be connected again. */
    reconnect: boolean
  } | null
  /** The boards whose cards can be in your calendar (by name), and whether you left each out. */
  boards: { id: string; name: string; off: boolean }[]
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

/**
 * Where a card is now (`GET /api/boards/:id/whereis`), asked by its number on a board or by the id it had there:
 * still on that board, or on the one it was moved to.
 */
export interface WhereIs {
  boardId: string
  taskId: string
  /** It's on another board than the one asked. */
  moved: boolean
  /** When it was ever moved (even away and back, which gave it a new id and number): its board's name, and its name there. */
  board?: string
  ref?: string
  archived?: boolean
}
