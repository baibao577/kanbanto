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
- the mention digest, every hour;
- clean-up (expired sessions, old trash, unused uploads), every 6 hours.

## Code layout

A pnpm monorepo with three packages:

```
packages/model/   The board model and its rules: pure TypeScript, used by BOTH the web app and the server
  commands.ts       Every change to a board, with its rules (no loops, valid references, parent status…) → Change[]
  changes.ts        Apply changes; invert them (undo)
  schema.ts         zod schemas: board data, and every command a client can send
  api.ts            The API's request/response shapes, shared by server and web
  indexer.ts, view.ts, tree.ts, table.ts   The task tree, rolled-up status, what each view shows

apps/server/      Fastify + Drizzle + PostgreSQL
  src/db/schema.ts  Tables
  drizzle/          SQL migrations (generated; never edited after they're committed)
  src/db/defaults.ts, src/settings.ts   Site settings' defaults (one place) and loading them
  src/boards/       engine.ts (runs commands), store.ts (rows ⇄ records), access.ts (who can do what), invites.ts
  src/routes/       auth, boards, sharing, comments (and the bell), files, email, admin
  src/mail/         mailer.ts (outbox, budgets, whose key pays), senders.ts, transport.ts (SMTP, Resend),
                    templates.tsx + components.tsx (the emails), digest.ts
  src/storage/      stores.ts (server disk; S3-compatible via aws4fetch), service.ts (quotas, buckets),
                    egress.ts (people's own buckets: public addresses only)
  src/crypto.ts     AES-256-GCM for stored secrets; the master key (ENCRYPTION_KEY or the key file)
  src/live.ts       WebSocket fan-out per board
  src/cli.ts        Server commands (admin grant/revoke/list, user password, key, secret)

apps/web/         React + Vite + Tailwind + shadcn/ui, Phosphor icons
  src/data/sync.ts  BoardSync: keeps an open board in step with the server
  src/components/views.ts   The views (tabs): add one here and to LAYOUTS in the model
  src/components/board/dropRules.ts   What a drop on the board means (status, parent, person, position)
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
| `#/join/<token>` | A share link |
| `#/signin`, `#/signup`, `#/forgot` | Signing in |
| `#/verify/<token>`, `#/reset/<token>` | Links in emails |
| `#/account/<section>` | Account settings: profile, password, notifications, email, storage |
| `#/admin/<section>` | Platform console: overview, accounts, email, storage |

## Accounts and sharing

- **Sign-in** is email and password (scrypt hashes). Sessions are random tokens in an httpOnly, SameSite=Lax cookie
  (Secure over HTTPS); only their SHA-256 is stored. Changing a password signs out other devices and closes their live
  connections. Sign-in is limited per IP address and per account (10 wrong passwords in 15 minutes).
- **Behind proxies:** `X-Forwarded-*` headers count only from the proxies named in `TRUST_PROXY`; links in emails are
  built from `APP_URL`, never from request headers.
- **Everyone owns their own boards.** There are no workspaces. New accounts get an example board, unless they
  signed up to join someone else's.
- **Platform admins** are granted only on the server (`admin grant`), never through the website. They manage
  settings and accounts but get **no access to boards** unless a board is shared with them.
- **Who can open a board:** *Private* (owners only), *Invited people* (members), *Public* (anyone with the link can
  view, even signed out).
- **Roles:** Owner (edit, share, delete), Editor (edit), Viewer (view and comment). A board always keeps an owner.
- **Invites:** a share link and an access code (`ABCD-EFGH`), each with a role, each can be turned off or replaced.
  Email invites add existing, confirmed accounts at once; anyone else gets a one-time invite bound to their address.
  Signing up through an emailed invite confirms the address, unless the inviter was shown the link (the email
  couldn't be sent), since then the inviter could have used it.
- **Who's on a board** (the Share dialog) is for members: owners see email addresses, others see names.

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

- Every card has a live comment thread. Everyone on the board can comment, viewers included (not visitors of a
  public board).
- **@mentions** (of board members) show under the bell. By email, people get at most one summary a day, covering
  mentions unseen in the app for an hour.
- `#` in a comment or description links to one of the card's files.

## Files

- Files go to the **server's disk** (`UPLOADS_DIR`) by default, or to an **S3-compatible bucket** set in the
  Platform console. Each file remembers where it was saved; changing the setting never moves or breaks existing
  files (old settings are retired, not overwritten).
- **Bring your own bucket:** people can connect their own bucket in Account settings; files on boards they own go
  there, with no limit. Their buckets must be at public addresses: every connection is checked after the name is
  looked up (so changing DNS later doesn't get around it), and redirects aren't followed.
- **Quota** counts against the board's owner (default 50 MB in total across their boards; largest file 10 MB).
- Files are always served as downloads (pictures inline), never as web pages; programs and scripts are refused.
  Uploads are checked (who, and the declared size) before the file is read. Files for comments not yet posted are
  their uploader's only, and count against the owner's space once posted.
  Disk files stream through the server; bucket files use 5-minute signed links.
- Deleted files stay in a trash for 30 days. Files of a deleted card come back if the card is restored.

## Adding things

| To add | Where |
|---|---|
| A change people can make to a board | A command in `packages/model/src/commands.ts` (its rules) and its schema in `schema.ts` (the build fails if the two disagree). The server needs no change: it runs every command through the same `execute`. Add tests next to the model's. |
| A view (tab) | Its id in `LAYOUTS` (`packages/model/src/types.ts`), then its label, icon and component in `apps/web/src/components/views.ts`. Saved preferences and addresses pick it up. |
| An email | Its wording in `emails` (`apps/server/src/mail/templates.tsx`), its kind in `EMAIL_KINDS` (`db/schema.ts`) and a sample for the console's previews. It's then sent with `app.mail.queue(…)`. |
| An email provider | A branch in `sendWith…` (`src/mail/transport.ts`), its settings in `senders.ts`, and the form in `EmailKeyForm.tsx`. |
| A site setting | A column in `site_settings` (with a new migration), its default in `src/db/defaults.ts`, and the console page that changes it. Read it with `loadSettings()`. |
| Storage somewhere other than S3 | An `ObjectStore` (`src/storage/stores.ts`: put and delete, plus how downloads are served) and where `storeOf` picks it. |

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
