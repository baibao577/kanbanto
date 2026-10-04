# Architecture

How Kanbanto works inside, for developers and for admins who want to know what they're running. For running it,
see [Self-hosting](self-hosting.md); for working on it, see [Contributing](../CONTRIBUTING.md).

## The big picture

```
Browser (React app)  ──HTTP /api──▶  Kanbanto server (Node, Fastify)  ──▶  PostgreSQL
        ▲                                   │                    └──▶  File storage (server disk or S3-compatible bucket)
        └──────── WebSocket (live) ◀────────┘                    └──▶  Email: an SMTP server or Resend (optional)
```

One Docker image holds both halves: the server answers `/api` and serves the built web app on the same port.
On start, it loads (or makes) the encryption key, runs database migrations, and moves any secrets saved with the old
public development key onto the real one. Background jobs run inside the same process:
- reminders whose moment has come, every minute; the morning summary email, checked every 10 minutes;
- the email outbox, webhook deliveries and Google Calendar sync, every 5 seconds;
- clean-up (expired sessions, old trash, unused uploads), every 6 hours.

## Code layout

A pnpm monorepo with three packages:

```
packages/model/   The board model and its rules: pure TypeScript, used by BOTH the web app and the server
  commands.ts       Every change to a board, with its rules (no loops, valid references, parent status…) → Change[]
  changes.ts        Apply changes; invert them (undo)
  schema.ts         zod schemas: board data, and every command a client can send
  time.ts           Logged time: reading what people type ("1:30 review"), showing it, man-days
  planning.ts, planningCommands.ts, planningSchema.ts   A workspace's plan (people's time on projects): its sums
                    (working days, man-days, loads), its commands and their rules (like commands.ts), their schemas
  calendar.ts, ics.ts   What a board puts in a person's calendar (one rule for links and Google), and the .ics file
  api.ts            The API's request/response shapes, shared by server and web
  indexer.ts, view.ts, tree.ts, table.ts   The task tree, rolled-up status, what each view shows

apps/server/      Fastify + Drizzle + PostgreSQL
  src/db/schema.ts  Tables
  drizzle/          SQL migrations (generated; never edited after they're committed)
  src/db/defaults.ts, src/settings.ts   Site settings' defaults (one place) and loading them
  src/boards/       engine.ts (runs commands), store.ts (rows ⇄ records, a board's people), access.ts (who can do
                    what), invites.ts, workspaces.ts (joining, leaving, moving boards)
  src/planning/     engine.ts (runs plan commands, one workspace at a time), store.ts (rows ⇄ records, seeding)
  src/routes/       auth, boards, sharing, workspaces, comments (and the bell), time (logged time, My week), files,
                    email, admin, integrations (API tokens, a board's webhooks), calendar (your link, Google
                    Calendar, the .ics feed)
  src/auth/apiTokens.ts   Bearer tokens: who they act as, and which routes they may use (TOKEN_ROUTES)
  src/webhooks.ts   Queues, signs and delivers webhooks (with retries), like the email outbox
  src/calendar/     sync.ts (keeps people's Google calendars up to date), google.ts (Google's sign-in and calendar
                    calls, and a stand-in for tests), items.ts (which boards are in someone's calendar)
  src/mcp.ts        The MCP endpoint (/api/mcp): tools for AI assistants, over the same access checks and commands
  src/oauth.ts      Apps connecting with sign-in (OAuth 2.1 for MCP): discovery, registration, consent, tokens
  src/openapi.ts    /api/openapi.json (commands described from their schema) and the reference page at /api/docs
  src/mail/         mailer.ts (outbox, budgets, whose key pays), senders.ts, transport.ts (SMTP, Resend),
                    templates.tsx + components.tsx (the emails), digest.ts
  src/storage/      stores.ts (server disk; S3-compatible via aws4fetch), service.ts (quotas, buckets),
                    egress.ts (people's own buckets: public addresses only)
  src/crypto.ts     AES-256-GCM for stored secrets; the master key (ENCRYPTION_KEY or the key file)
  src/live.ts       WebSocket fan-out per board
  src/cli.ts        Server commands (admin grant/revoke/list, user password, key, secret)

apps/web/         React + Vite + Tailwind + shadcn/ui, Phosphor icons
  src/data/sync.ts  BoardSync: keeps an open board in step with the server
  src/data/planSync.ts   PlanSync: the same for a workspace's plan (checked for changes now and then; no socket)
  src/components/planning/   The Planning tab: planLayout.ts (rows, time axis), PlanSheet.tsx (the timeline and its
                    gestures), dialogs, pickers
  src/components/time/   The log box (LogBox.tsx), My week, and helpers; a card's time is task/CardTime.tsx
  src/components/views.ts   The views (tabs): add one here and to LAYOUTS in the model
  src/components/board/dropRules.ts   What a drop on the board means (status, parent, person, position)
  src/lib/pointerDrag.ts   Dragging with a mouse, pen or finger (hold to pick up on touch), used by every view
  src/components/   board/, timeline/, outline/, task/, share/, account/, admin/, settings/, auth/, home/, shell/
```

## How a change travels

```
UI ─run(command)─▶ BoardSync: execute() here ─▶ shown at once (optimistic)
                        │ POST /api/boards/:id/mutations { mutationId, command }   (one at a time, in order)
                        ▼
                   Server: lock the board row ─▶ execute() again (the same rules) ─▶ save ─▶ seq + 1
                        │ response { seq, changes }   and   WebSocket { type: 'changes', seq, changes, mutationId }
                        ▼
                   Every open copy applies the changes; the sender replays its not-yet-confirmed commands on top.
```

- **The server decides.** It re-runs each command with the same `execute` the app uses, so the rules can't be
  skipped. Commands are checked against a zod schema first. A command that no longer applies is refused (422) and
  the app says why.
- **`seq`** numbers every change to a board. A client that sees a gap (or reconnects behind) fetches the board again.
- **Undo/redo** is an ordinary command (`records.restore`) that says what each record should go back to *and* what
  it should be now. If someone else changed it since, the undo is refused rather than overwriting their edit.
- **Retries are safe:** the same `mutationId` gets the first answer back instead of running twice.
- **Offline:** changes wait in the tab (the top bar shows "Offline") and are sent when the connection returns.
  Closing the tab with unsent changes asks first. There's no offline storage.

## Board concepts

- **Tasks** nest to any depth (`parentId`). A parent's status can roll up from its subtasks.
- **Lists** are statuses. Each list *counts as* Backlog, Not started, In progress or Done; progress, "Up next" and
  roll-up read that, so lists can be named anything. Backlog is never "Up next", and any list can be hidden.
- **Card order** within a list (`Task.rank`, set by dragging) is separate from the outline order (`Task.order`).
- **Labels** are board-wide and cards refer to them by id, so renaming or recolouring a label updates every card.

## Addresses

The app uses hash routing, so any static host or proxy works without rewrite rules:

| Address | Page |
|---|---|
| `#/` | Your boards |
| `#/b/<id>/<tab>?focus=<task>&task=<task>` | A board: tab (board, timeline, outline), zoomed-in task, open card. Back/Forward work. |
| `#/join/<token>` | An invite link, to a board or a workspace |
| `#/w/<id>` | A workspace's people and settings |
| `#/w/<id>/planning?by=person&zoom=days` | Its plan, by project or by person, in weeks, days or months (`zoom=months`) |
| `#/time?week=<monday>` | My week: your logged time on every board |
| `#/signin`, `#/signup`, `#/forgot` | Signing in |
| `#/verify/<token>`, `#/reset/<token>` | Links in emails |
| `#/account/<section>` | Account settings: profile, password, notifications, calendar, email, storage, api |
| `#/admin/<section>` | Platform console: overview, accounts, email, storage, integrations |

## Accounts and sharing

- **Sign-in** is email and password (scrypt hashes). Sessions are random tokens in an httpOnly, SameSite=Lax cookie
  (Secure over HTTPS); only their SHA-256 is stored. Changing a password signs out other devices and closes their live
  connections. Sign-in is limited per IP address and per account (10 wrong passwords in 15 minutes).
- **Behind proxies:** `X-Forwarded-*` headers count only from the proxies named in `TRUST_PROXY`; links in emails are
  built from `APP_URL`, never from request headers.
- **Boards live in their owner's Personal space or in a workspace.** A workspace is a group of people (admins and
  members) and a place for boards; it adds one way into a board, it doesn't replace the board's own sharing. New
  accounts get an example board, unless they signed up to join someone else's board or workspace.
- **Platform admins** are granted only on the server (`admin grant`), never through the website. They manage
  settings and accounts but get **no access to boards** unless a board is shared with them. Workspace admins manage
  the workspace's people, and likewise get no access to its boards that aren't shared with the workspace.
- **Who can open a board** (`accessFor` in `src/boards/access.ts`): *Private* (owners only), *Only people added*
  (its members), *Everyone in the workspace* (its members, plus everyone in its workspace with the board's workspace
  role: editor by default, or viewer). Someone who's both gets the higher role. *Anyone with the link can view* is a
  switch on top (not while private); visitors see the cards, comments and files (the share dialog says how many).
- **Leaving a workspace** closes its boards to you, except ones you were added to. Boards you own there stay in the
  workspace; where you were the only owner, an admin becomes the owner. **Moving a board** into a workspace is up to
  its owner; taking one out also needs that workspace's admin.
- **Roles:** Owner (edit, share, delete), Editor (edit), Viewer (view and comment). A board always keeps an owner.
- **Invites:** a share link and an access code (`ABCD-EFGH`), each with a role, each can be turned off or replaced.
  Email invites add existing, confirmed accounts at once; anyone else gets a one-time invite bound to their address.
  Signing up through an emailed invite confirms the address, unless the inviter was shown the link (the email
  couldn't be sent), since then the inviter could have used it.
- **Who's on a board** (the Share dialog) is for its people: owners see email addresses, others see names. Everyone
  in the workspace can be assigned and @mentioned on its boards shared with it.

## Integrations

- **API tokens** (`kbt_…`, only their SHA-256 stored) act as their person. They reach `TOKEN_ROUTES` only (boards,
  workspaces, notifications, files, MCP), never account settings or the Platform console; read-only tokens only `GET`.
  Platform admins turn them on (`site_settings.api_tokens`).
- **Webhooks** hang off the board engine: after each command that changed something, `BoardEngine.onChanged` queues a
  `board.changed` delivery for the board's webhooks (and posting a comment queues `comment.added`). A worker sends them,
  signed (HMAC-SHA256 of `<time>.<body>`), with retries. Admins choose where they may go: off, public addresses only
  (checked after every name lookup, like people's buckets), or anywhere.
- **MCP** is stateless: each POST to `/api/mcp` builds a server whose tools call the same functions the routes use
  (`requireAccess`, `engine.mutate`, `postComment`), as the token's person.
- **Calendars** work from what should be there, not from what just happened. `calendarItems` (in the model) says
  which events a board gives a person; the calendar link renders them as an .ics file on request, and
  `CalendarSync` compares them with what it last sent to Google (`calendar_events`, by hash) and sends the
  difference. It knows a board needs another look from the board's change number: `boards.seq` goes up with every
  command and every change of people, sharing or archiving, and `calendar_boards.synced_seq` is the number last
  sent for that person. So losing access, a list becoming a "done" list, or a restart need no special handling.
  Boards a person can no longer open have their events removed (`calendar_events` has no foreign key to the board,
  so a deleted board's events can still be found). Failures back off per connection and never give up; a refused
  connection waits to be connected again.

## Email

- **How the site sends:** an SMTP server (nodemailer) or Resend's HTTP API, set in the Platform console, or an SMTP
  server from `SMTP_URL`. Both sit behind one `Transport` interface (`src/mail/transport.ts`); `src/mail/senders.ts`
  loads the site's and people's senders and decrypts their secret only to send.
- Every email goes through an **outbox** table and is counted against optional daily and monthly **limits** for the
  site. Invites may use only 80% of them, so sign-up and password emails keep working.
- **Whose account sends:** sign-up and password emails use the site's. Invites use the inviter's own Resend key if
  they added one, else their monthly allowance on the site's, else the app shows the link to send by hand. People's
  own keys are Resend only: letting anyone enter an SMTP server would let them make the server connect anywhere.
- Failed sends **retry** (1 minute up to 2 hours, 5 tries). A refusal that retrying can't fix (a bad key or password,
  an untrusted certificate) flags the sender with the reason, for its owner to see.
- **Confirming email** is required once the site can send email, for accounts that haven't confirmed yet (platform
  admins are exempt). New sign-ups get the same answer whether or not the address has an account; the link in the
  confirmation email signs them in. A platform admin can vouch for an address. Accounts aren't confirmed
  automatically, because email invites go to the account with that address.
- Sent emails keep only what the limits need: their contents (with any sign-in link) are removed once sent.
- **Templates** are React components rendered with `@react-email/render`: `src/mail/templates.tsx` has one shared
  layout and a few lines per email; `src/mail/components.tsx` has the email-safe building blocks.

## Comments and notifications

- Every card has a live comment thread. Everyone on the board can comment, viewers included (not visitors with the
  public link).
- **@mentions** (of board members) show under the bell. By email, people get at most one summary a day, covering
  mentions unseen in the app for an hour.
- `#` in a comment or description links to one of the card's files.

## Files

- Files go to the **server's disk** (`UPLOADS_DIR`) by default, or to an **S3-compatible bucket** set in the
  Platform console. Each file remembers where it was saved; changing the setting never breaks existing files, and
  doesn't move them by itself (old settings are retired, not overwritten; saving a bucket used before brings its
  setting back).
- **Moving files** (`src/storage/move.ts`): files kept elsewhere (the disk, the site's storage, an earlier bucket) can
  be moved to the storage in use, by the platform admin for the site's storage and by people for their own boards.
  Each file is copied, its record switched, then the old copy removed; progress is kept in memory, so a restart just
  leaves the rest where it was. An earlier bucket with no files left is forgotten, with its keys.
- **Bring your own bucket:** people can connect their own bucket in Account settings; files on boards they own go
  there, with no limit. Their buckets must be at public addresses: every connection is checked after the name is
  looked up (so changing DNS later doesn't get around it), and redirects aren't followed.
- **Quota** counts against the board's owner (default 50 MB in total across their boards; largest file 10 MB), or,
  for a board in a workspace, against the workspace (the same amount, across its boards; always the site's storage).
  Moving a board moves its files' count with it.
- Files are always served as downloads (pictures inline), never as web pages; programs and scripts are refused.
  Uploads are checked (who, and the declared size) before the file is read. Files for comments not yet posted are
  their uploader's only, and count against the owner's space once posted.
  Disk files stream through the server; bucket files use 5-minute signed links.
- Deleted files stay in a trash for 30 days. Files of a deleted card come back if the card is restored.

## Planning

- **Each workspace has a plan:** projects with a budget in man-days, people (every member, plus people added by name:
  contractors, future hires, stand-ins like "New SE"), roles (SE, DE, SA, BA to start; each workspace changes its
  own), and blocks: a person (or nobody yet) on a project from one day to another, at 25, 50, 75 or 100% of their
  time. It's separate from the boards' cards.
- **Sums** (`packages/model/src/planning.ts`): a block is worth its working days (Monday to Friday) × its share; one
  working day of a person is one man-day, whatever their hours. A project is Under, Fit (within half a man-day) or
  Over its plan. A person's load is the sum of their shares on a day; over 100% is flagged with when. Blocks on one
  line (one person, or nobody, on one project) never overlap.
- **Who:** workspace admins, and members an admin marks as planners, change the plan; everyone else in the workspace
  sees it. Members stay in the plan while they're in the workspace; someone who leaves keeps their time until a
  planner takes them out (their time then becomes "not assigned yet"), and gets it back if they rejoin.
- **Prospects:** a project can be marked as a prospect (it might not happen). Its time shows dashed and is kept out of
  people's Over / Fit / free from; a person who'd go over 100% only if a prospect happens says so apart.
- **Boards:** a project can be linked to one board in the same workspace (`planning_projects.board_id`); the board's
  Timeline then shows the project's plan as a read-only band (`GET /api/boards/:id/plan`, workspace members only).
  A board that leaves the workspace loses its link.
- **Order:** projects and people keep the order planners drag them into (`position`); people without one (until the
  first move) come by role, then name.
- **Changes** work like a board's: commands checked by the same model code on both sides, sent one at a time, each
  numbered (`planning_state.seq`, the row that's locked while a plan changes), with undo as a checked restore. There's
  no live connection for plans yet: an open plan checks for changes every minute and when the tab comes back.

## Logged time

- **Entries** (`time_entries`): a person, a card, a day, minutes (1 to 24 hours) and a note. Like comments, the card
  is only named, not linked: an entry stays when its card is deleted (and is back with it on undo), but only entries
  on cards that exist are counted. Moving a card to another board takes its time along.
- **Who:** editors and owners log; everyone on the board sees it (not visitors with the public link). You change your
  own; a board owner, or an admin of its workspace who can open the board, can fix anyone's ("edited by …").
- **Typing it** (`packages/model/src/time.ts`): the time at either end and the rest as the note ("API integration –
  3h 20m", "1:30 review"); a plain number is hours, and over 12 is refused ("20 hours? Type 20m").
- **Nothing is guessed.** The log box and My week suggest *which* cards (the ones you changed, moved or commented on
  that day, from the board's activity log and comments) but never *how long*.
- **Live:** each change sends a card's new total on the board's socket (`{ type: 'time' }`).
- **Planning:** `GET /workspaces/:id/planning` carries minutes by linked board and person; `planActuals` turns them into
  each person's man-days (their hours ÷ their hours a day). Lines show logged of planned, against what was booked up
  to today (`bookedUntil`).

## Adding things

| To add | Where |
|---|---|
| A change people can make to a board | A command in `packages/model/src/commands.ts` (its rules) and its schema in `schema.ts` (the build fails if the two disagree). The server needs no change: it runs every command through the same `execute`. Add tests next to the model's. |
| A view (tab) | Its id in `LAYOUTS` (`packages/model/src/types.ts`), then its label, icon and component in `apps/web/src/components/views.ts`. Saved preferences and addresses pick it up. |
| An email | Its wording in `emails` (`apps/server/src/mail/templates.tsx`), its kind in `EMAIL_KINDS` (`db/schema.ts`) and a sample for the console's previews. It's then sent with `app.mail.queue(…)`. |
| An email provider | A branch in `sendWith…` (`src/mail/transport.ts`), its settings in `senders.ts`, and the form in `EmailKeyForm.tsx`. |
| A site setting | A column in `site_settings` (with a new migration), its default in `src/db/defaults.ts`, and the console page that changes it. Read it with `loadSettings()`. |
| Storage somewhere other than S3 | An `ObjectStore` (`src/storage/stores.ts`: put, get and delete, plus how downloads are served) and where `storeOf` picks it. |

## Scaling

Kanbanto runs as **one server instance**. Live updates, the board cache and the sign-in failure counts live in that
process's memory, so two instances would not see each other's changes live. For personal and team use, one instance
(about 1 GB of memory) with PostgreSQL next to it is the intended setup. The board cache is bounded (200 boards, and
200,000 records in all), so large boards don't grow memory without limit. Long lists aren't virtualized: each list
shows 100 cards at a time, with "show more".

To run several instances you would pass live messages between them (Postgres `LISTEN/NOTIFY` or Redis) — see
`src/live.ts` and `src/boards/engine.ts`. Contributions welcome.

## Theming

All colours, radii and fonts are CSS variables in `apps/web/src/index.css` (`:root` for light, `.dark` for dark).
Tailwind utilities like `bg-lane` and `text-status-done` read from them. The 12-colour palette for labels, lists and
timeline bars is `--c-<name>` (see `packages/model/src/colors.ts`). Blend colours with `color-mix(in oklab, …)`, not
`oklch`: blending in oklch rotates the hue. To restyle, change the tokens and leave the components alone.
