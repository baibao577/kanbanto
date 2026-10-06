# Changelog

What changed in each release, newest first. Upgrading? See [Upgrades](docs/self-hosting.md#upgrades): back up first,
then `git pull` (or download the new release) and `docker compose up -d --build`. Database updates run by themselves.

## 0.1.0 — first public release

- **Boards of tasks inside tasks**, as deep as you like, shown as a **Board** (lists you name), a **Timeline** and an
  **Outline** (a table you can sort, filter and rearrange). Undo and redo, filters, search, zooming into a task.
  Lists can group subtasks under their parent; drag groups and cards into any order. A board whose statuses are set
  by hand opens with one card per task, its subtasks on its card.
  An open card lists what every card has one line each, the most used first, with dates and the rest in groups you
  can fold away.
- **Your Inbox, beside every board:** a board of your own for notes and cards that have no board yet, which only you
  can see. The tray in the top bar (or the I key) opens it as a panel at the left of any board and of your
  boards page, with how many cards wait in it. It shows its lists as a stack of sections that fold: add a card, drag
  it to another section to change its list, tick small things off without ever putting them on a board. Drag a card
  out onto a list of the open board and it lands where you drop it (on the Timeline or the Outline, anywhere on the
  view); a card's menu does the same without dragging, which is the way on a phone, where the Inbox opens over the
  board. It is a real board: open it as one to change its lists. It can't be shared, moved to a workspace, archived
  or deleted. Everyone has one, made the first time the app opens; tasks an assistant adds without naming a board go
  there. For those who had chosen a board as their Inbox (Board settings → "Use as my Inbox", now gone): if nobody
  else could open that board, it is their Inbox now, with its cards; otherwise it stays an ordinary board and their
  Inbox starts empty. For apps: `GET /api/inbox`, a place in the list for a card moved to another board (`order`),
  `inbox` on a board in `GET /api/boards`; `user.inboxBoardId` and the `set_inbox` tool are gone.
- **A quieter top bar on a board:** search, Share and More are small icons that say what they are when pointed at
  (search opens into its box when clicked, or with the / key; Share says how many people are on the board), "New
  task" is the one button with a word, and a thin line sets the board's own buttons apart from what is yours on
  every page: your Inbox, the bell and your account. On a phone, Share is the first thing under More.
- **Dates with or without a time:** start and due are whole days by default; add a time (24-hour) when it matters.
  Everyone sees it in their own time zone, and dates read day first ("Mon 12 Oct · 14:30").
- **Works on phones and tablets:** press and hold a card, list or row to drag it. Each card's menu can also move it to
  another list, or to the top or bottom of its own. It installs as an app too (the browser's "Install" or "Add to Home
  screen"): its own icon and window. It still needs a connection, and a site served over HTTPS.
- **Sharing:** workspaces for teams (everyone in one can open its boards, without being invited to each), or boards
  shared one by one; owners, editors and viewers; share links, access codes and invites by email; a public link anyone
  can view. Changes appear for everyone live.
- **Comments** with @mentions, a notification bell and a daily email summary; **attachments** on cards and in comments.
  A description can @mention people too: they're told once, when their name is first written there.
- **Custom fields:** add your own fields to cards: text (or a link, an email, a phone number), a number with a unit,
  a date, a choice from a list of options, or a checkbox. A field is defined once in a library, a workspace's
  (its admins) or your own for Personal boards, and each board's owners pick the ones it uses, their order, and up to
  three that show on the card front. On an open card they are its first section, a box for each. Taking a field off
  a board, or archiving it, keeps its values; deleting an
  archived field for good removes them. Values go along when a card or a board moves, where the other side has a
  field for them, and with an exported board. In the Outline each field is a column: sort by it, change values in
  place, hide the ones you don't need, and drag a column's name sideways to put the columns in your own order
  (Alt+Shift and an arrow key does it without a mouse; a saved preset keeps the order). Filter by a field in every
  view (saved presets keep it), and in Search cards across boards, with a test that fits its kind: text that contains
  a word, doesn't, is exactly or isn't; a number that is, is at least, at most or between; a date that is today, this
  week, next month, in the next or last so many days, or between two days; any of a choice's options or none of
  them; a linked card found by typing its title; a person, or "Me", which is whoever is looking, so one saved "Mine"
  works for everyone. Due and Start take the same date tests, Assignee has "Me", and a board's search box looks in
  its text fields too. For apps: `due`, `fv` and `timeZone` on `GET /api/cards`; assistants ask with the same tests
  (`find_tasks`). Numbers that add up are totalled: in the Outline's bottom row and for a task with its subtasks, and
  under each list on the Board for the fields its owners choose. A **Card link** field joins cards, on the same
  board or across the boards of a workspace: a deal points at a company, picked by title, and the company lists the
  deals that point at it, with their total; links follow a card that moves, and you only see the title of a card
  you can open. A **Person** field holds one or several people of the board (a reviewer, an account owner), to read,
  sort and filter by: nobody is told, which is what Assignee is for. Two fields that turned out to mean the same
  thing can be **merged**: it says first how many cards change, a card that has both keeps the one its board shows,
  and boards and saved filters follow. **Starter boards** (a sales pipeline, a support desk, store orders, bookings) come with their
  lists, fields, saved filters and a few example cards, each card linked to a client on a **Clients** board that
  comes with the first starter and is shared by the ones after: open a client and see every deal, request, order
  and booking that is for them. Assistants read, set and find by fields, by name, and can add and
  change them (`manage_fields`).
- **Following cards:** you're told about new comments and what happens to the cards you're part of (moved to another
  list, assigned, due date, description, archived or deleted): the ones you made, are assigned, commented on or were
  mentioned on, which includes being told when a card is given to you. Follow or unfollow any card from its side
  column, or unfollow from the bell. Several changes in a row are one line, and never your own. Search cards has a
  **Following** search for them, and assistants can follow a task for you (`follow_task`).
- **Files for assistants and the API:** an assistant can put a file on a card: one it writes (a report, notes, a
  CSV), one fetched from a public web address, or, when it works on a computer, a local file sent to a one-time
  upload link (`attach_file`, `upload_link`); on the card itself, or posted in a comment. It sees a card's files
  and can read text files and look at pictures (`read_file`). Uploading with an API token, files in comments and
  pointing at a file in text (`📎name`) are documented, and `comment.added` webhooks list a comment's files. A
  second file with a name the card already has is numbered (`report (2).pdf`), so a mark always means one file;
  attaching a file to a card is a line in the board's activity. `FILES_FROM_URL=off` stops the server fetching
  files from web addresses.
- **File storage on MinIO**, tried against a real one (the docs have the steps): a wrong Region now says which
  region the storage is set to. Fixed: a bucket saved a second time under another address (its address changed) lost
  its files when they were moved "from the earlier bucket"; Kanbanto now recognises that both are one bucket and
  only notes the new address.
- **Integrations:** personal API tokens (once a platform admin turns them on), webhooks per board with signed
  deliveries and retries, an MCP endpoint for AI assistants, a Skill for Claude Code, and an API reference at
  `/api/docs` on every site. Claude on the web and in Claude Desktop (and ChatGPT) can connect by signing in (OAuth),
  when a platform admin allows it. For assistants: a 180-day activity log of who changed what (and through which app),
  a team overview, searches by priority, label and time, and your Inbox for quick capture.
- **Cards in your calendar:** connect Google Calendar (Account settings → Calendar) and your cards' due dates and
  reminders appear in a calendar of Kanbanto's own there, updated within seconds; or make a private calendar link
  for Apple Calendar, Outlook and others. Your cards are the ones assigned to you, plus nobody's cards on boards
  only you are on; you choose which boards are in it. Platform admins turn each on in the console (Google Calendar
  needs a Google app, see [Calendar](docs/calendar.md)).
- **Your site's own pages:** a `pages` folder (an about page, a privacy policy, terms) is served next to the app,
  with links to them under the sign-in form. See [Your own pages](docs/configuration.md#your-own-pages).
- **Priorities** (urgent, high, medium, low) on tasks: shown on cards, and in the Outline, filters and sorting. Boards
  can say **what they're for**.
- **Move a task to another board**, with its subtasks, comments and files (from its menu, or the card's panel). You see
  what fits before it moves: lists and labels are matched by name, and people who aren't on that board are named.
- **Descriptions and comments are formatted:** headings, bold, lists, checklists you can tick, code, quotes, tables
  and links, written in a light editor (Markdown shortcuts or a small toolbar) and saved as Markdown. Long text folds
  with "Show more", and a description can be read full page with its headings to jump to. Files and mentions work as
  before.
- **Writing a description, without losing your place or your words:** what you type is kept as a draft in the
  browser and offered back after a reload or a closed tab, with a "Saved" / "Not saved yet" sign; it's saved when
  you finish (clicking away, Esc, ⌘Enter) or with ⌘S. Esc leaves the editor instead of closing the card. Click a word
  to edit and the cursor is on that word. The toolbar stays in view, with numbered lists and quotes; "/" opens a menu
  of headings, lists, a table, a divider and a code block (inside a table: its rows and columns); pasted Markdown
  comes in formatted. In the card the editor stops at half the window and scrolls. **Expand** is now a place to
  write: it opens ready to type from an empty description or straight from the card's editor (same text, same
  cursor), looks like the page you'll read, keeps Contents beside you as headings appear, and counts your words.
- **Reminders** on cards: at a time you type in plain words ("tmr 10:00", "fri 2pm") or pick, or before the due date
  (following it). They go to whoever is assigned, under the bell and by email (which can be turned off), and to
  webhooks as `reminder.due`. Assistants can set and list them.
- **Desktop notifications** (Web Push, no app to install), turned on per computer in Account → Notifications:
  reminders, @mentions and news from the cards you follow pop up even when Kanbanto isn't open; clicking one opens
  the card.
- **Morning summary email** around 8:00 in your own time zone (set from your browser, changeable): cards due today and
  overdue, reminders later today, and mentions and news from the cards you follow that you haven't seen. Only when there's something; it replaces the daily
  mention email.
- **Times in plain words** when adding or renaming a card ("buy cat next monday 1pm" becomes "buy cat", due then, with
  a reminder if you like) and in the Due and Start pickers.
- **Webhooks** live in Board settings: each can send only some events (card changes, comments, reminders), and has a
  delivery log showing what was sent and what came back, with "Send again".
- **Add from anywhere:** put something in your Inbox without opening Kanbanto first. A button for your browser's
  bookmarks bar (Account settings → Add from anywhere) opens a small window with the page's title, its address and
  the words you had selected; press Add, and it closes. On Android, Kanbanto installed from Chrome is in the list of
  apps things are shared to. The window can also send the card to a board. Nothing is saved until you press Add,
  and the button holds no password. For scripts and automation tools (n8n, Zapier, Make, a shortcut): one call adds
  a card with plain names, `POST /api/inbox/cards` or `POST /api/boards/<id>/cards`, where a due date can be a day,
  a moment or words ("tomorrow 3pm"). Fixed on the way: an assistant's `update_task` with `due: null` or
  `start: null` now takes the date off, as its description says (it used to leave it).
- **A Telegram bot for a board:** a board's owner makes a bot at @BotFather and adds it in Board settings →
  People & apps (the Telegram box), then connects one chat by sending the bot a code. That chat gets the board's news as sentences,
  and what is sent there becomes cards: every message in your own chat with the bot, `/card …` in a group, or
  `/card` in reply to someone's message. The first line is the title, a time in it ("tomorrow 3pm") is the due
  date by your clock, photos and files are attached. The bot answers with what it understood and two buttons, Undo
  and No date; editing your message changes the card, and a reply to the bot's answer is a comment. The bot's menu has
  `/list` (the cards waiting in the list), `/board` (a link to the board) and, in your own chat with a bot,
  `/today` (what is overdue, due today and tomorrow, and your reminders in the next 24 hours). A bot connected to your
  own chat also tells you your reminders and mentions, from every board (Account settings → Notifications →
  Telegram); on your Inbox, what you send it lands in your Inbox. One bot serves one board; only the connected chat counts; the token is
  kept encrypted. A platform admin allows bots or not (Platform console → Integrations, off to start). The site
  needs no address Telegram can reach. Times in plain words are now read by the server too, in a person's time
  zone.
- **Webhooks to a chat channel:** a webhook can be sent to a channel in Slack, Google Chat, Microsoft Teams or
  Discord. Choose the app when adding it ("Send to") and paste the address the chat app gives for the channel. The
  channel then gets each change as a sentence, "Ann moved “Deploy” to Done on Launch", with the card's title opening
  the card; comments come with how they start, reminders with who they're for. The same three switches decide what
  is sent, and the log shows each message. Putting cards in another order says nothing. Nothing people typed can
  mention anyone in the chat. The channel is sent a first message when the webhook is added, and the webhook is
  only saved if the chat app takes it; these webhooks have no signing secret. Remember that card titles, names and
  the start of comments are then readable by everyone in that channel. For apps: `format` when adding a webhook.
- **Outline** uses the full width, with columns you choose and compact (or comfortable) rows (Display), indent guides
  and lightly tinted projects; on phones it's a nested list with each task's details underneath.
- **Card age** (Display → Card age): a chip with the days since anything happened on a card (moved to another list,
  edited, commented on, or its subtasks), after 3 days; amber from a week, red from two. Filter → "No activity
  lately" for any number of days, and "Recently changed" for the opposite (the last 3 days, or the number you choose);
  `find_tasks` takes `idle_days` for assistants. Cards' footers are two tidy lines:
  what needs attention, then the counts and the assignee.
- **Complete and archive** (a card's menu): finishes it and its subtasks, then archives it. Every archived card keeps
  the list it was archived from and whether it was completed, whatever happens to the lists later. The Archived
  cards page filters Completed / Not completed and opens a card right there (the usual card, read-only, with
  Restore and Delete); assistants can archive as completed too.
- **Done cards out of the way:** Display → Done lists shows only cards done or touched lately (14 days, or the
  number you choose), with "12 older · Show". The Outline and Timeline can hide done tasks, with a line saying how
  many.
- **Archive older done cards:** a done list's menu (or "Archive…" beside its older cards) archives, in one go, the
  cards done more than a number of days ago, each with its subtasks. It says how many will go first, and Undo brings
  them back. A finished card under work that isn't finished stays. Assistants do the same with `archive_done_tasks`.
- **Big boards stay light:** archived cards are no longer downloaded with a board; the app fetches one when it's
  opened, and the ones Stats and Export need. In the API, `GET /api/boards/<id>/archived` gives a board's archived
  cards by date range (archived, done or made between two moments), and `find_tasks` finds them by when they got done
  or were archived, so "what did we finish in March?" still has an answer after the cards are put away.
- **"What was I working on in January to March?"** Assistants can ask for the tasks worked on in a stretch of time
  (`find_tasks` with `worked_after` and `worked_before`): made or changed then, where a change is an edit, a move, a
  comment, logged time, finishing or archiving. Each result says what happened. Changes older than the 180-day
  activity log are only known when they were a task's last one.
- **More board backgrounds:** 12 designs besides the 12 colors (sunset, ocean, aurora, forest, midnight, …), and a
  custom one: pick any hue and a light, medium or deep shade, and the gradient and text colors are made for you.
- **Favourite boards:** star a board on the boards page or from its name menu; favourites come first on both.
- **Presets** on each board: save the filters and Display options as a named preset ("Focus", "Review") that
  everyone on the board can pick. Editors save, update, rename and delete them.
- **Public links** say that visitors also see the board's comments and files (and how many files there are).
- **Archive** cards (with their subtasks) and boards instead of deleting them. Archived cards have their own page
  (board ⋯ → Archived cards, or from search) across all your boards, where they can be searched, opened read-only,
  restored where they were, or deleted for good; archived boards are read-only and kept under "Archived boards" on the
  boards page.
- Assistants can **set up boards**: create one, change its settings, lists and labels. Sharing and deleting stay in
  the app.
- **Email** through any SMTP server or Resend, with limits to stay within a free plan. **File storage** on the server's
  disk or in an S3-compatible bucket (Cloudflare R2, Amazon S3, MinIO); people can bring their own.
- **Security review** before the first public release, with fixes: undo and imported files can no longer store a card
  whose parent links go round in a loop, or a reminder whose time isn't one (either could stall the server or stop
  reminders for every board), and old-format files pass the same checks as exports; desktop-notification addresses
  must be public ones, and a browser stops getting notifications when it signs out, when the password changes or
  the account is turned off; the bell and the morning email show nothing from a board you can no longer open; API
  tokens can't change your profile or open live connections; logged time isn't sent to visitors with the public
  link; assistants can't comment on an archived board; an invite sent with the inviter's own email service no
  longer counts as proof of the address; a file restored from the trash needs room in the quota; reminder emails
  for someone else count against whoever set them; the storage settings refuse non-JSON bodies before reading them;
  a confirmation link asks for the account's password outside the browser that signed up; sign-up with an invite the
  address can't use answers the same whether or not it has an account; someone removed from a board can no longer
  move its files to their own storage; a plan project can only be linked to a board its planner can open, and plan
  undo can't add an outsider's account; the app-connection page approves exactly what it shows; a sign-in under way
  doesn't survive a password change; webhook replies are read only as far as they're kept, and one webhook's slow
  address no longer holds back the others; searching archived cards, undo and live updates stay quick on very large
  boards. A second pass added: a new webhook address must answer a one-time code before it's saved; the app sends a
  content-security policy and no-framing, no-sniff, referrer and HSTS headers; unused reset and confirmation links
  end when the password changes; turning an account off also removes its API tokens, connected apps and calendar
  link; simultaneous requests can't get past the wrong-password limit, the email limits, the file quota or the
  last-owner rule; a board made private stops showing its logged time in the workspace's plan; CI actions are pinned
  to exact commits; a warning at startup when the database still has the default password. A third
  pass: turning an account off also ends the share links, access codes and invites of the boards and workspaces that
  person runs, so they can't come back under another address; plans stay within their size limits through undo and
  splitting, plan dates are between 2000 and 2100, and an assistant's search text is capped; one webhook's backlog,
  one person's pile of mentions or one odd reminder can no longer hold up webhooks, morning emails or calendar sync
  for others; the image's base is named by its exact contents.
- **Guides** for the people using it, in [`guides/`](guides/): a page for each thing you'd want to do (your first
  board, cards, sharing, workspaces, assistants, time and planning, calendars), with pictures taken from the app by a
  script, built into a small website with VitePress. **Guides** in the account menu opens them (at kanbanto.com by
  default; `GUIDES_URL` points it at your own, or `off` takes it out).
- **Self-hosting:** one Docker Compose file, an optional HTTPS add-on, backups and restores, a Platform console for
  settings, and server commands for the rest. The encryption key for saved keys is made automatically.
