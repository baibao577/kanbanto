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
- boards' Telegram bots: one open request to Telegram for each bot that takes cards (see Integrations);
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
  src/chat/         A webhook's news as text for a chat app: each app's body, and the hosts its addresses are on
  src/telegram/     Boards' own Telegram bots: Telegram's API (api.ts), connecting and reading (bots.ts), messages
                    into cards (cards.ts), and the words of /help (help.ts)
  src/tell.ts       Telling one person their news as it happens: desktop notifications, a Telegram bot of their own
  src/calendar/     sync.ts (keeps people's Google calendars up to date), google.ts (Google's sign-in and calendar
                    calls, and a stand-in for tests), items.ts (which boards are in someone's calendar)
  src/mcp.ts        The MCP endpoint (/api/mcp): tools for AI assistants, over the same access checks and commands
  src/oauth.ts      Apps connecting with sign-in (OAuth 2.1 for MCP): discovery, registration, consent, tokens
  src/openapi.ts    /api/openapi.json (commands described from their schema) and the reference page at /api/docs
  src/mail/         mailer.ts (outbox, budgets, whose key pays), senders.ts, transport.ts (SMTP, Resend),
                    templates.tsx + components.tsx (the emails), digest.ts
  src/storage/      stores.ts (server disk; S3-compatible via aws4fetch), service.ts (quotas, buckets),
                    egress.ts (people's own buckets: public addresses only)
  src/pages.ts      The site's own pages (PAGES_DIR: a privacy policy, terms…) and the links under the sign-in form
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
- **The activity log** (`board_activity`): with each change the server writes what it did, in words
  (`describeAllChanges` in the model: "moved “Deploy” to Done"), with who made it and through which app, kept 180
  days. Each line about a task is written twice: as the board's log says it, and as the task's own history does
  (`own`: "moved it from To Do to Done", with what it was before and a date left as `{date}` for the reader's time
  zone). Assistants read the first (`recent_activity`); the card window's **History** tab reads the second
  (`readTaskActivity`, the lines of one task, asked of the rows' `items` with a jsonb `@>`: about 10 ms on a board
  with 100,000 logged changes, so it has no index of its own). A card's files and its logged time aren't board
  commands, so their routes write their own lines (`logLine`: attached, removed, restored; logged, changed, removed).
  A line about logged time says when the time was typed in, not when the work was done, so those (`TIME_COMMANDS`)
  don't count where the log is read for signs of work ("cards you touched that day", `find_tasks`' worked_after).
  Comments aren't in the log.
- **Offline:** changes wait in the tab (the top bar shows "Offline") and are sent when the connection returns.
  Closing the tab with unsent changes asks first. There's no offline storage.

## Board concepts

- **Tasks** nest to any depth (`parentId`). A parent's status can roll up from its subtasks.
- **Lists** are statuses. Each list *counts as* Backlog, Not started, In progress or Done; progress, "Up next" and
  roll-up read that, so lists can be named anything. Backlog is never "Up next", and any list can be hidden.
- **Card order** within a list (`Task.rank`, set by dragging) is separate from the outline order (`Task.order`).
- **A card's name** is its board's letters and its number: WEB-12 (`Board.code`, `Task.number`; see
  `packages/model/src/refs.ts`). The number is given by the server and nowhere else: `BoardEngine.mutate` hands the
  next one to each new card as it is saved, under the board's row lock, from a counter the board keeps in the
  database (`boards.next_number`, not part of the board record commands change, so undoing "add a card" never
  touches it). A card that has a number keeps it whatever a browser sends back, and no number is used twice. The
  browser shows a new card without one until the server answers. Boards made without commands (the example board,
  starters, imported files) are numbered as they are saved, and what existed before card numbers is numbered when
  the server starts (`boards/numbering.ts`). A board's letters come from its name, are its owners' to change
  (`PUT /api/boards/:id/code`, never a command or an undo), and are its own within a workspace or among one
  person's boards; the letters it had before are kept, so a name written with them still finds its card. A card
  moved to another board is a new card there, with a new number; where it went is recorded (`task_moves`), and
  when it moves again the earlier lines are pointed at the new place, so one look finds it
  (`GET /api/boards/:id/whereis`, by the number or the id it had: what the web app asks when an address names a
  card the board no longer has).
- **A card's name in text** stays text: a description or a comment that says WEB-12 is saved exactly so, and is
  shown as a link (`components/task/RichText.tsx`) when its letters are a board's the reader can open (this
  board's from memory, the others from the list of boards, asked once and shared: `app/card-refs.ts`). Nothing is
  looked up to show it: the link is `#/b/<board>?n=12`, and the card is found when someone follows it. In the
  editor, "/" opens the one menu of things to put in (`INSERTS` in `components/text/Editor.tsx`): each is a line
  with what it does, or a `step` when it has to be chosen first, as a card is (this board's cards from memory,
  other boards' from `GET /api/cards?in=titles`); a new kind of mention is a new line there.
- **Rules** (`packages/model/src/rules.ts`) are what a board says about its cards, the same to everyone on it. The
  first kind is a limit ("at most 3 cards in Doing", "at most 40 h of Estimate in This week", "at most 2 cards for
  each person"). A rule is a record of the board (`BoardData.rules`, the table `board_rules`), loaded with it the
  way its fields are and changed by its owners through routes (`boards/rules.ts`: the board's change number moves
  and every open copy reads it again), never by a command; `applyChanges` carries the rules along. Nothing a rule
  works out is stored: `evaluateRules` runs on the board as it is, in every browser and on the server, once for a
  version of the board. What a rule is about is a card set (`cardsOf`): the Filter menu's conditions, less the ones
  that depend on who is looking or what day it is, plus which cards count where they nest. That function is what
  other kinds of rule are meant to reuse, and what a rule does is a list (`then`). A rule that names something that is gone is never worked out with what is left of it
  (`ruleProblem`): a dropped condition would be a wider limit. When a board's fields get other ids (a merge, a
  move to another workspace, a file read into a new board) its rules follow, whole or not at all (`remapRule`).
- **Rules that tell people** are the second kind (`kind: 'when'`: "when a card arrives in Quoted, tell Dana"). A
  limit shows a state; this one acts at a moment, and only by telling, so no rule can set off another. Which cards
  arrived in a rule's card set, or left it, is the model's to say from the board before a change and after it
  (`firings`: the cards the change wrote and the cards above them in both trees, since a parent's list can follow
  its subtasks without the parent being written; a card that only gained or lost subtasks did neither; a rule that
  can't be worked out on either side says nothing, so undoing a deleted list isn't every card in it arriving). The
  server asks at the one point every command passes: `BoardEngine.mutate` hands the board as it was to
  `afterChange`, and `transfer` (a card moving between boards, which is no command) calls `afterMove` for each of
  the two boards. `boards/tell.ts` then works out who hears of it (the people ticked who are still on the board,
  the card's assignee for `@assignee`, never the actor, nobody who switched the rule off) and writes one
  `notifications` row of kind `rule` per person and rule, with what was said kept on the row (`said`: a card that
  left by being deleted has no title to look up later), merged with that person's unseen row from the same rule
  and actor in the last ten minutes; one push per person per change goes out under the "cards you follow" switch.
  It runs before the followers' step (`boards/follows.ts`), which then leaves out the move, archive, restore and
  delete lines for the cards a rule just told that person about. Who switched a rule off is each person's own
  business: the table `board_rule_mutes` and two routes of its own, never part of `BoardData`, which is sent
  whole to viewers and to visitors with the public link. A browser reads rules through `limitsOf` and `whensOf`,
  so a kind a newer server sends is left out, not tripped over. Rules aren't asked when a board's definitions
  change (a person removed, a field's option deleted), only when cards do.
- **A card's cover** is one of its files, a picture: `Task.cover` holds the file's id, and the Board draws
  `/api/attachments/<id>/thumb` without asking for the card's files. That is the picture's small copy, made by
  the browser of whoever chose the cover (`coverPicture` in the web app's `lib/picture.ts`: the whole picture, 640
  pixels wide; the Board cuts it to its frame) and kept in the database for the file (`attachment_thumbs`), apart
  from the files' storage: the server never opens a picture, the copy uses no file space, and it is checked like
  the file whenever it is asked for. It is written once and never replaced, so browsers keep it. The cover is the
  server's to set, like a card's number: `BoardEngine.setCover` locks the board, checks the file is that card's,
  writes it and sends the change to every open copy, without raising the card's version (what was done to the
  card before can still be undone). No command carries it, `restore()` pins it through undo, and the database
  write keeps the stored one (`boards/store.ts`). A card that comes back from being deleted keeps its cover when
  the file is still its own, and one moved to another board takes it along with its files. Removing the file,
  or the comment it was posted in, removes the cover (`routes/covers.ts`).
- **Labels** are board-wide and cards refer to them by id, so renaming or recolouring a label updates every card.

## Addresses

The app uses hash routing, so any static host or proxy works without rewrite rules:

| Address | Page |
|---|---|
| `#/` | Your boards |
| `#/b/<id>/<tab>?focus=<task>&task=<task>` | A board: tab (board, timeline, outline), zoomed-in task, open card. Back/Forward work. |
| `…?inbox=<task>` | On either of those: a card of your Inbox, open on top |
| `#/join/<token>` | An invite link, to a board or a workspace |
| `#/w/<id>` | A workspace's people and settings |
| `#/w/<id>/planning?by=person&zoom=days` | Its plan, by project or by person, in weeks, days or months (`zoom=months`) |
| `#/time?week=<monday>` | My week: your logged time on every board |
| `#/signin`, `#/signup`, `#/forgot` | Signing in |
| `#/verify/<token>`, `#/reset/<token>` | Links in emails |
| `#/account/<section>` | Account settings: profile, password, notifications, calendar, email, storage, api, add |
| `#/add?title=…&url=…&text=…&w=1` | The little "add a card" page, with what a page handed over (the bookmark button, a phone's Share). `w`: a window of its own, which closes when the card is added. `/share?…` (where a phone sends what was shared) becomes this. |
| `#/admin/<section>` | Platform console: overview, accounts, email, storage, integrations |

## Accounts and sharing

- **Sign-in** is email and password (scrypt hashes), and, when a platform admin turns it on, Google (OpenID Connect
  through the site's Google app, `routes/google-auth.ts`: the account is found by Google's ID for the person, then by
  a checked address Google runs the mailbox of, else made; such an account has no password until one is added, and
  only that ID is kept). Sessions are random tokens in an httpOnly, SameSite=Lax cookie
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
- **The Inbox** (`src/boards/inbox.ts`): everyone has one board with `boards.inbox_of` set to them, made the first
  time it's needed (the app opening, or an assistant adding a task without a board). It is an ordinary board in every
  other way (the engine, the three views, moves to and from it), kept theirs alone: private, in Personal, and the
  routes that would share, move, archive or delete it refuse (`notOnInbox`; a check constraint on the table is the
  backstop). In the app it is a panel beside the open page (`app/inbox.tsx`, `components/inbox/`): a second
  `useBoardStore` on that board, mounted while the panel or one of its cards shows, never on the Inbox board's own
  page. A card dragged out of the panel asks the open page where it would land (`zones` in
  `components/board/dnd.ts`: the board's lists, with the board's own drop marker, or the whole view), and the move to
  that board carries the place (`MoveTarget.order` in `model/moveBoard.ts`), so it arrives where it was dropped in
  one change.
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
  couldn't be sent) or it went out through the inviter's own email service, since then the inviter could have used it.
- **Who's on a board** (the Share dialog) is for its people: owners see email addresses, others see names. Everyone
  in the workspace can be assigned and @mentioned on its boards shared with it.

## Integrations

- **API tokens** (`kbt_…`, only their SHA-256 stored) act as their person. They reach `TOKEN_ROUTES` only (boards,
  the card search, logged time, workspaces, notifications, files, joining, MCP, and reading who they are), never
  account settings, the Platform console or a board's live connection; read-only tokens only `GET`.
  Platform admins turn them on (`site_settings.api_tokens`).
- **Webhooks** hang off the board engine: after each command that changed something, `BoardEngine.onChanged` queues a
  `board.changed` delivery for the board's webhooks (and posting a comment queues `comment.added`). A worker sends them,
  signed (HMAC-SHA256 of `<time>.<body>`), with retries. Admins choose where they may go: off, public addresses only
  (checked after every name lookup, like people's buckets), or anywhere.
- **A webhook to a chat app** (`webhooks.format`: slack, google-chat, teams, discord) is the same webhook with another
  body. The engine hands `onChanged` the change in words, the lines it writes to the activity log (`describeAllChanges`),
  and `chat/format.ts` turns them into the body that app reads, escaping what people typed. That body is what's queued,
  so the queue, the retries, the log and "Send again" don't know the difference; a change with no words (a reorder)
  queues nothing for them. Two things differ, because nothing at a chat app can answer: instead of the code a new
  address has to send back, the channel is sent a first message that has to be taken, and on a site limited to public
  addresses the address must be the chat app's own (`chat/hosts.ts`); and deliveries carry no signature.
- **A board's Telegram bot** is a webhook whose format is `telegram`: the row's encrypted secret is the bot's token
  (the owner's own, from @BotFather), and `telegram_bots` says which bot it is, the one chat it's connected to, and
  whether what's sent there becomes cards. News goes out through the same queue (`Webhooks.deliver` hands it to
  `Telegram.deliver`, which adds the chat). Coming in, `telegram/bots.ts` asks Telegram for new messages (long
  polling, `getUpdates`), so the site needs no address Telegram can reach; where reading left off (`read_from`) is
  saved after each message, and a card's mutation id is the message's own, so a restart neither loses nor repeats
  one. A bot is read only while it waits for its connecting code or takes cards. Only the connected chat counts:
  a bot's name is public, and anyone can write to it. Cards are added by `engine.mutate` in the name of whoever
  added the bot (checked again each time to be able to edit the board), `via` "Telegram"; `telegram_cards` remembers
  for a week which message made which card, for Undo, No date, an edited message and a reply (a comment). The
  connecting codes, the per-chat limits and albums in flight are in memory. Three shortcuts answer in the chat:
  `/board` (a link), `/list` (the titles in the list new cards go to, read as whoever added the bot) and, in someone's own chat
  with a bot, `/today` (what is theirs and due on that bot's board, and their reminders there in the next 24 hours, read the same way); each chat's menu (`setMyCommands` for that chat) lists the ones that work there.
  Links are only written for a site address Telegram will link (not `localhost`): otherwise the address is shown. Someone's own news (`tell.ts`) goes through a bot they connected to their own chat on the card's board, and no other (a bot's reach is the board it was added to: with no bot of theirs there, nothing is said on Telegram); that bot's chat is then left out of the board's news of the same thing. The token is in every address this code calls, so nothing in `telegram/api.ts`
  puts an address in an error or a log line. Platform admins allow bots or not (`site_settings.telegram_bots`), a
  switch of its own: bots work whatever the setting for webhooks is, and have their own box in Board settings.
- **MCP** is stateless: each POST to `/api/mcp` builds a server whose tools call the same functions the routes use
  (`requireAccess`, `engine.mutate`, `postComment`), as the token's person.
- **Cards by name.** What someone says about a card in plain names (its list, labels, a person, the board's own
  fields) is understood in one place, `boards/newCards.ts`: an assistant's `create_tasks` and `update_task` use it, and
  so do `POST /api/inbox/cards` and `POST /api/boards/:id/cards`, the one-call way in for scripts and automation tools.
  Every name is looked up before anything is added.
- **Importing.** A Trello export becomes a board in the model (`trello.ts`: `slimTrello` keeps the parts that are
  used and trusts none of their shapes, `fromTrello` makes the board, its comments and a summary), so the app shows
  what will come over from the same code the server then runs; `importBoard` saves it like any imported board, plus
  the comments with their own dates. Rows of a spreadsheet are read in the model too (`sheet.ts`, `sheetValues.ts`
  for the dates and numbers people type, `importCards.ts` for the plan): the server adds what only it knows (people's
  addresses, the cards a link field can reach, who may add an option) and the plan is both the check and the import.
  The cards are added by one command, `tasks.import`, so the engine's rules, the activity log, webhooks and undo
  all see one change; `afterBoardChange` tells each assignee once.
- **Calendars** work from what should be there, not from what just happened. `calendarItems` (in the model) says
  which events a board gives a person; the calendar link renders them as an .ics file on request, and
  `CalendarSync` compares them with what it last sent to Google (`calendar_events`, by hash) and sends the
  difference. It knows a board needs another look from the board's change number: `boards.seq` goes up with every
  command and every change of people, sharing or archiving, and `calendar_boards.synced_seq` is the number last
  sent for that person. So losing access, a list becoming a "done" list, or a restart need no special handling.
  Boards a person can no longer open have their events removed (`calendar_events` has no foreign key to the board,
  so a deleted board's events can still be found). Failures back off per connection and never give up; a refused
  connection waits to be connected again.
- **Templates** (`model/templates.ts`) are copies taken when saved, kept apart from boards so they stay out of
  every view, count, search and notification. A card template is a card with its subtree (`card_templates`, with
  its board; `templateOf` says what is kept: what a card is, and never who had it or when); starting a card from
  one is a `tasks.import` command with `template` set (`fromTemplate`), so it is one change with one undo, the log
  says where the card came from, and the board's rules see it arrive. A board template is a board's shape
  (`board_templates`, a workspace's or a person's: lists, labels, fields, rules, card templates, never cards or
  people); a board is made from one the way a starter is (`createFromTemplate`: its fields are fitted into the
  library of where it is made, its rules adopted as a file's are). Open copies of a board hear that its card
  templates changed over the live connection (`templates`) and ask for them again.
- **A board as a file** is made in the browser, from the board it has plus what it asks for (its archived cards).
  Two kinds. The whole board (`model/transfer.ts`: `exportFile`, read back by `readBoardFile` into a new board),
  which can carry what the board doesn't hold: its comments and logged time (`BoardExtras`, from
  `GET /api/boards/:id/extras`, read back leniently by `readExtras`). A board's people aren't accounts wherever
  the file is read, so a comment comes back as the importer's and says who wrote it, and logged time is the
  importer's only where the account is the same one; the rest is nobody's (`user_id` null, the name in the note),
  because hours must not land in someone's week by a name. And a spreadsheet (`model/exportSheet.ts`: `cardsSheet`,
  `toCsv`): one row a card, the columns named and the cells written the way the spreadsheet import reads them
  (`importCards.ts`), so a sheet goes out, is changed and comes back; it starts with a byte-order mark for Excel,
  and text someone typed that starts like a formula is marked as text with an apostrophe, which `parseSheet`
  takes off again.

## Email

- **How the site sends:** an SMTP server (nodemailer) or Resend's HTTP API, set in the Platform console, or an SMTP
  server from `SMTP_URL`. Both sit behind one `Transport` interface (`src/mail/transport.ts`); `src/mail/senders.ts`
  loads the site's and people's senders and decrypts their secret only to send.
- Every email goes through an **outbox** table and is counted against optional daily and monthly **limits** for the
  site. Invites, reminders and morning summaries may use only 80% of them, so sign-up and password emails keep working.
- **Whose account sends:** sign-up and password emails use the site's. Invites use the inviter's own Resend key if
  they added one, else their monthly allowance on the site's, else the app shows the link to send by hand. People's
  own keys are Resend only: letting anyone enter an SMTP server would let them make the server connect anywhere.
- Failed sends **retry** (1 minute up to 2 hours, 5 tries). A refusal that retrying can't fix (a bad key or password,
  an untrusted certificate) flags the sender with the reason, for its owner to see.
- **Confirming email** is required once the site can send email, for accounts that haven't confirmed yet (platform
  admins are exempt). New sign-ups get the same answer whether or not the address has an account; the link in the
  confirmation email confirms the address in the browser signed in to the account, or with the account's password
  (and then signs in). A platform admin can vouch for an address, and signing in with Google confirms it (taking
  the password and sessions of an account that wasn't confirmed, as "Forgot password" would). Accounts aren't confirmed
  automatically, because email invites go to the account with that address.
- Sent emails keep only what the limits need: their contents (with any sign-in link) are removed once sent.
- **Templates** are React components rendered with `@react-email/render`: `src/mail/templates.tsx` has one shared
  layout and a few lines per email; `src/mail/components.tsx` has the email-safe building blocks.

## Comments and notifications

- Every card has a live comment thread. Everyone on the board can comment, viewers included (not visitors with the
  public link).
- **@mentions** (of board members) show under the bell. In a comment, the app says who was picked; in a description,
  the server compares the text before and after a change and tells only the people whose `@Name` is new (never the
  person writing, and not when undo puts a mention back).
- **Following a card** (`task_followers`): people follow the cards they're part of without asking (they made it, it's
  assigned to them, they commented, they were mentioned) and can follow or unfollow any card. Stopping is remembered;
  only a new assignment starts it again. Followers get a line under the bell for each new comment, and for what
  happens to the card: moved to another list, assigned, due date, description, archived, deleted. Changes by the same
  person to the same card within ten minutes share one line while it's unread, and nobody is told about what they did
  themselves. This runs after every board command (`afterBoardChange` in `boards/follows.ts`), whichever way the
  command arrived (the app, an API token, an assistant).
- **Reactions** (`comment_reactions`; the set and its words are in `model/reactions.ts`): a comment can be answered
  with an emoji. What is kept is the emoji itself, one row per person, comment and emoji, so the set people choose
  from (six today) can grow without anything stored changing. Everyone who can comment can react
  (`PUT /api/boards/:id/comments/:commentId/reactions`); a comment's view carries its reactions with who added each,
  and a reaction reaches open copies as the whole comment (`action: 'reacted'` on the live `comment` message). The
  comment's author has one notification row of kind `reaction` for the comment (a later reaction brings it back to
  the top, unread); who reacted is read from the reactions when the bell is opened, and the row goes when every
  reaction is taken back. Reactions are deliberately quiet: no email, no push, not in the card's history or webhooks.
- By email, people get one morning summary a day (about 8:00 their time): what's due, today's reminders, and the
  mentions and followed-card news they haven't seen.
- `#` in a comment or description links to one of the card's files.

## Custom fields

- A **field** (`fields` table; the rules are in `model/fields.ts`) is defined once, in a **library**: a workspace's,
  managed by its admins, or a person's own, for their Personal boards. Its type (text, number, date, choice,
  checkbox, card link, person) is chosen once. `model/fields.ts` is the one place that knows the types: how to check a value, show it,
  compare it, and carry it over to another field.
- A **board picks** the fields it uses (`board_fields`: order, and up to three on the card front), its owners'
  choice. The picked definitions are put into the board when it's loaded (`BoardData.fields`), the way its people
  are: commands only read them. A card's values are `Task.custom`, by field id, set through `task.update`, so undo,
  the activity log, live updates and webhooks treat them like any other change.
- Library changes and a board's picks aren't board commands. They go through their own routes (`routes/fields.ts`,
  `boards/fields.ts`), raise the change counter of every board that shows the field in the same transaction, and
  then have the open copies fetch the board again.
- **Hidden values stay on the server.** A card in memory holds values only for the fields its board uses. Taking a
  field off a board (its row is kept, marked removed) or archiving it leaves the values in `tasks.custom`, and saving
  a card merges with what the row holds, so they're back when the field is. They are never sent to browsers,
  assistants, webhooks or exports. Deleting an archived field for good removes them from every card, then the field.
- **Links between cards** (the `link` type; `boards/links.ts`). A link is `"<board id>:<card id>"` in the value's
  list, so `FieldValue` is unchanged. One board can only half check one (shape, how many, the field's board, a card of
  its own): `checkValue` does that in the browser and on the server, and never refuses a link the card already held.
  The rest needs other boards, so it's the server's: inside `mutate`, on the open transaction, a link being added is
  checked for its card existing, being in the field's space and on a board the person can open (`checkLinks`); an
  undo that would bring back one that fails goes through without it. The same rules are applied again whenever
  links are read, so one that slips past a clean-up only reads "A card you can't open". Titles are never stored:
  each board answer carries `linked`, resolved for the viewer (`resolveLinks`), and the browser keeps them in a
  small store that chips subscribe to one link at a time. When a card moves to another board, or a board is deleted
  or leaves its space, `relink` rewrites or removes the links to it in a transaction of its own, after the change,
  locking the boards in id order. The activity log names a linked card only when it's on the same board.
- **People** (the `person` type). A value is a list of user ids, checked against the board's people wherever a
  value is checked: `checkValue` refuses someone new who isn't one of them and quietly drops someone the card held
  who has left; `tidyCustom` (undo, un-archiving, a file) and `carryCustom` (a card or a board moving, an import)
  keep only people who are there. Leaving a board or a workspace takes the person out of the person fields of the
  boards they're gone from, and unassigns them (`boards/people.ts`): inside that transaction the boards are locked
  and their change counter raised, so a command running at that moment can't write them back. Nobody is notified:
  that's what Assignee is for. No fall-through ever prints an id: a value reads as names, or "someone who left".
- **Merging two fields** (`mergeFields` in `boards/fields.ts`; the rules for one card are `mergeCustom` in
  `model/fields.ts`). One transaction that locks in the order every other change here does: the library, the two
  fields, then every board with a row for either, in id order. A card that holds both keeps the value its board
  shows; a choice's options go by name and the rest are added. Board rows and saved filters (`remapPreset`) are
  rewritten, the old field is deleted, and the boards reload. `setBoardFields` takes a share lock on the fields it's
  asked for, so it can't add one mid-merge. No webhook fires: nothing a card's people did changed.
- **An undo can't reach behind a re-keying.** An undo puts whole cards back. One whose card names a field the board
  has no row for at all (it was merged away, or the board moved to another space and got that space's fields) is
  refused in `mutate`: put back, the card would lose what it holds for the fields it has now. A field merely taken
  off the board or archived keeps its row, and such an undo goes through without that value, as before.
- **Starter boards** (`model/starters.ts`, `createStarter` in `boards/service.ts`). A starter is plain data: lists,
  example cards, saved filters and fields under ids of its own. `planStarter` fits those fields to the library of
  where the board is made: one of the same name and kind is used as it is (never changed), one that's archived is
  left out, the rest are added, which a workspace's admins may do; otherwise nothing is made. The cards' values and
  the saved filters are then carried to the library's ids. The ids of the starters' choice options are a contract:
  an added field keeps them, so they're in people's data from then on. An example card's dates are counted from
  today where the owner is (their time zone, not the server's); only a finished one is ever assigned to them, and
  none has a reminder, so making a starter sends nothing.
- **The Clients board.** Every starter has a "Client" card link (`linkTo: 'board'`). `clientLink` looks for that
  field in the library, under the library's lock: when there is none, a board of clients is made in the same
  transaction (a card per example client) and the new field links to it; when there is one, its board is used as it
  is, and the example cards are linked to the cards already there, by title. Nothing is ever added to a board of
  clients that exists; one that is archived, gone, or that the person can't open just leaves the examples
  unlinked. Two starters made at the same moment make one board of clients.
- **Columns, filters and totals.** The index carries the board's definitions (`TaskIndex.fields`), so sorting and
  filtering need nothing else. A field's column and sort key is `f:<field id>` (`model/table.ts`); the Outline's
  columns can be put in an order of the person's own (`OutlineConfig.order`: every column after Task as last
  arranged, nothing stored while it's the usual order). A filter by a field is a `FieldFilter` in
  `TableFilter.fields`, with one rule per kind (`fieldMatches`, `tidyFilter` in `model/fields.ts`). View settings
  that point at a field that left the board are dropped by `cleanPrefs`, which gives the same object back when
  nothing changed (it runs on every change).
- **The Outline grouped by a column** (`model/outlineGroups.ts`, `OutlineConfig.group`: a list, a person, a
  priority, a label, or a choice, person or tick field by its key). The Outline is a tree and a subtask's value can
  differ from its parent's, so a card goes under the heading of its own value (`groupCards`: headings in the order
  that means something, every list even when empty, "none" last, a card with two labels under each) and each heading
  lays the tree out the way a search does: its cards plus the cards above them for context (`groupKeep`, then
  `flattenTree`). A parent can so be a row under several headings; rows aren't dragged while grouped. A heading's
  count and totals are of its own cards; the bottom Total still counts each card once. What is added under a
  heading starts with its value (`groupFields`). Nothing is stored but the key: it is part of the view settings,
  saved in presets, carried when a field changes its id (`remapPreset`) and dropped when the field leaves
  (`cleanPrefs`); a key a later version adds reads as not grouped. Which headings are folded is kept on the device.
- **Several cards changed at once** (`model/bulk.ts`, `components/select/`). A view keeps which cards are ticked
  (`useSelection`: the person's own, forgotten with the view; a card that leaves the board leaves it for good, so
  an undo doesn't bring it back ticked) and shows `SelectionBar`, which floats at the foot of the view. Every
  action is one command, worked out in the model from the board as it is, so it is one entry in the history and
  one undo: `tasks.update` for fields (`setOnCards`: only the cards that would change, a parent that follows its
  subtasks left out of a move and counted, cards arriving in a list placed at its end; `labelOnCards` adds or
  removes one label and keeps the rest; `fieldOnCards` does the same for a field that holds several people or
  cards, and sets any other), `tasks.archive` and `tasks.delete` for putting away and deleting (what
  `task.archive` and `task.delete` do to one, for the named cards that have none of the others above them).
  A change with news for one person about more than three cards is told to them once, each kind of thing said
  about all the cards it happened to (`manyInWords` in `boards/follows.ts`). The Outline has it (a tick box where
  a row is pointed at, Shift for a range, the Task heading's box for all that is shown); the Board is to follow
  with the same bar.
- **A filter's tests, and how they stay compatible.** A new test is always a new key; no key ever changes meaning
  (`in` got `notIn` beside it, the old `date: 'past' | 'week' | 'none'` got `on` / `days` / `from` / `to`, `due` got
  `dueIs` and `startIs`). A tab left open across an update, or a rollback, reads a filter with keys it doesn't know
  and drops them: that filter isn't applied, which is safe. An overloaded key would be applied wrongly. The schema
  (`model/schema.ts`) names every key, each new one with `.catch(undefined)`, and a compile-time check holds it to
  the type, because a key the schema doesn't name is stripped from a saved preset without a word. One date test
  (`DateTest`, `dateMatches` in `model/dates.ts`) serves date fields, Due and Start. `filterCount` decides whether a
  filter is applied at all, so it counts every key.
- **Who is asking, and what day it is for them** (`MatchContext`): `'me'` is kept as a word in `assignees`, `in` and
  `notIn` and filled in when matching, so a saved "Mine" is each viewer's own; a public visitor is nobody. A whole
  day is itself; a moment is the day it falls on in the asker's time zone (`dayNumberIn`). The browser uses its own
  zone, `GET /api/cards` takes `timeZone` (else the account's, else UTC), assistants the zone they pass.
- **The address form** of a field's test (`fv`, `due`; `filterToText` / `filterFromText`): text always carries its
  test (`~`, `=`, `!~`, `!=`), "none of" is a leading `!` on a list, dates are a word, `next-N`, `last-N` or `A..B`.
  Every form read before is still read the same.
- **A board's saved filters follow its fields**: merged, or moved with the board to another space
  (`remapPreset`, in `mergeFields` and `moveBoardFields`), dropping what couldn't come along. Totals have one rule (`model/totals.ts`): a
  number counts once, on the card that holds it, and a card's total is its own plus its subtasks'. The Outline's cells
  are memoised and build their menus only when opened, so a table of thousands stays quick.
- **Fields travel by name and type.** A card moved to another board keeps a value where that board uses the same
  field, or one with the same name and type; the rest are dropped, and the move says which. A board moved to another
  space, or imported from a file, has its fields matched in the library it arrives in; the rest are added there if
  the person manages it (always for an import: it goes to their own), otherwise lost, and a move asks first.

## Files

- **Profile pictures** are not files in this sense (`src/pictures.ts`, `routes/pictures.ts`): a person's picture is
  shrunk by the app to 256 × 256 before it is sent and kept in the database (`account_pictures`, apart from `users`
  so reading a person doesn't read their picture), so there is no quota, nothing to move between storages, and it is
  in the database backup. `users.picture` holds its key, random and new with every upload, and a person is sent with
  `picture`, the path `/api/pictures/<key>`, beside their name. That path needs no sign-in (a public link's visitors
  see who cards are assigned to) and never shows another picture, so browsers keep it for a year. Boards hold their
  people in memory: a new picture or name goes through `changePerson` (`boards/announce.ts`), which raises the change
  number of every board the person is on and tells the open copies to fetch again.
- Files go to the **server's disk** (`UPLOADS_DIR`) by default, or to an **S3-compatible bucket** set in the
  Platform console. Each file remembers where it was saved; changing the setting never breaks existing files, and
  doesn't move them by itself (old settings are retired, not overwritten; saving a bucket used before brings its
  setting back).
- **Moving files** (`src/storage/move.ts`): files kept elsewhere (the disk, the site's storage, an earlier bucket) can
  be moved to the storage in use, by the platform admin for the site's storage and by people for their own boards.
  Each file is copied, its record switched, then the old copy removed; progress is kept in memory, so a restart just
  leaves the rest where it was. An earlier bucket with no files left is forgotten, with its keys. Two settings can be
  one bucket under two addresses: before a move between buckets, a mark is written through one and looked for
  through the other (`sameBucket`), and when it's found only the records change. Without that the "old copy" removed
  would be the only one.
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
- **One way in** (`saveUpload` in `routes/files.ts`): the app's upload, an API token's, an assistant's tools and an
  upload link all end there, so who may (`mayUpload`: editors for a card's file, anyone who can comment for a
  comment's), the size, the space left, blocked names and where it's stored have one implementation. It gives the
  file a name no other file of the card has (text points at a file by name, `📎report.pdf`), and writes a line in
  the board's activity for a card's own file. It runs one at a time per board (`serial`), so anything slow, like a
  download, is done before it is called.
- **Files from assistants** (`routes/uploads.ts`, the tools in `mcp.ts`). A tool's arguments are words, so there are
  three ways. Text the assistant writes. A web address the server fetches (`storage/download.ts`): https, public
  addresses only (checked on the address connected to), no redirects, a time and a size limit, one at a time per
  person; `FILES_FROM_URL=off` removes it. And an **upload link**: a ticket kept in memory under the hash of 32
  random bytes, for one file on one card under a fixed name, good once for ten minutes; the route that takes the
  file checks the ticket and the declared size before reading anything, loads the person again and checks their
  access again, answers the same for unknown, expired and used, and its address is redacted in the request log. A
  file nobody vouched for is a picture only when its first bytes are one (`pictureType`): a stored picture type is
  what makes a file show in the page instead of downloading. A file posted with a comment is saved as its sender's
  draft and attached by `postComment`, as the app does, and removed again if the comment can't be posted.

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
| A chat app a webhook can send to | Its name in `WEBHOOK_FORMATS` (`packages/model/src/api.ts`), its body and escaping in `src/chat/format.ts`, the hosts its addresses are on in `src/chat/hosts.ts`, its icon and where its address comes from in `Webhooks.tsx`, and a row in the guide and the API docs. |
| A site setting | A column in `site_settings` (with a new migration), its default in `src/db/defaults.ts`, and the console page that changes it. Read it with `loadSettings()`. |
| Storage somewhere other than S3 | An `ObjectStore` (`src/storage/stores.ts`: put, get and delete, plus how downloads are served) and where `storeOf` picks it. |

## Scaling

Kanbanto runs as **one server instance**. Live updates, the board cache and the sign-in failure counts live in that
process's memory, so two instances would not see each other's changes live. For personal and team use, one instance
(about 1 GB of memory) with PostgreSQL next to it is the intended setup. The board cache is bounded (200 boards, and
200,000 records in all), so large boards don't grow memory without limit. Long lists aren't virtualized: each list
shows 100 cards at a time, with "show more".

Each Telegram bot that takes cards holds one request to Telegram open (a few bytes a minute, one socket). Hundreds
are fine on one instance; thousands would be better served by having Telegram send the messages to the site
instead (its webhooks), which isn't built.

### How it holds up on a big board

Measured, and kept as tests. The data (`model/bigBoard.ts`, `apps/server/test/perfSeed.ts`): a workspace of 30
people and 25 boards, a library of 50 fields, one board of 10,000 cards (and 3,000 archived) with twenty fields of
every kind, and a board of 4,000 companies the others link to. On a laptop, with PostgreSQL in Docker:

| What | Takes |
|---|---|
| Open the big board (17 MB): read from the database / from memory | 0.22 s / 0.06 s |
| Edit one card's field; rename a field; add an option | 0.02 s |
| Eight people reopen the board at once after a field was renamed | 0.5 s (it is read from the database once, for all of them) |
| Merge two fields that 19,000 cards on 25 boards hold | 1.2 s |
| Move a 500-card board to Personal, and back | 0.3 s, 0.1 s |
| Move a card other cards link to, to another board | 0.3 s |
| Clear a field on every card of the big board | 0.8 s |
| Search cards over 24,000 cards, by words or a field's test | 0.08 to 0.14 s |
| An assistant's `find_tasks` | 0.12 to 0.21 s |
| Who links to a card; the card picker; what 40 links point at | 0.02 s or less |
| The model on 3,000 cards: index, filter by three fields, sort by a field, lay out a view | 4 ms or less each |

What made the difference: cards are written 500 to a statement where they used to be written one by one
(`writeCustom`: merging fields took 8.4 s), a board being read from the database is read once for everyone asking
(`BoardEngine.load`: eight people took 1.5 s), and a sort works out each card's value once instead of at every
comparison (`sortComparator`).

In Chrome, on the same board: the Board opens in about 0.2 s; the Outline draws its first 500 rows, sorts or shows
500 more in about 0.5 s, nearly all of it drawing 500 rows of 25 columns; a filter or a cell's edit shows in 0.2 s,
and a reload on the Outline in 0.9 s.

Known limits, left as they are: filters and searches are matched in memory, not in the database; the Outline draws
every row it shows (500 at a time), not only the ones on screen; and undoing "clear a field on every card" on a
board of 10,000 cards is refused, because an undo sends every card back and that request is over the 10 MB a
request may be.

To measure again:

- `pnpm test` runs the model's timings on 3,000 cards (`model/src/perf.test.ts`), each with a limit about five times
  what it took, so they fail only when something got much slower.
- `PERF=1 TEST_DATABASE_URL=<a throwaway database> pnpm --filter @kanbanto/server exec vitest run test/perf.test.ts --silent=false`
  times the server on the 10,000-card workspace (it empties that database first).
- `guides/perf/browser.mjs` times the app in Chrome against a throwaway site filled by
  `apps/server/test/perfSeedRun.ts`.

To run several instances you would pass live messages between them (Postgres `LISTEN/NOTIFY` or Redis) — see
`src/live.ts` and `src/boards/engine.ts`. Contributions welcome.

## Theming

All colours, radii and fonts are CSS variables in `apps/web/src/index.css` (`:root` for light, `.dark` for dark).
Tailwind utilities like `bg-lane` and `text-status-done` read from them. The 12-colour palette for labels, lists and
timeline bars is `--c-<name>` (see `packages/model/src/colors.ts`). Blend colours with `color-mix(in oklab, …)`, not
`oklch`: blending in oklch rotates the hue. To restyle, change the tokens and leave the components alone.
