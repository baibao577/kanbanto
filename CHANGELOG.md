# Changelog

What changed in each release, newest first. Upgrading? See [Upgrades](docs/self-hosting.md#upgrades): back up first,
then `git pull` (or download the new release) and `docker compose up -d --build`. Database updates run by themselves.

## 0.1.0 — first public release

- **Boards of tasks inside tasks**, as deep as you like, shown as a **Board** (lists you name), a **Timeline** and an
  **Outline** (a table you can sort, filter and rearrange). Undo and redo, filters, search, zooming into a task.
  Lists can group subtasks under their parent; drag groups and cards into any order.
- **Dates with or without a time:** start and due are whole days by default; add a time (24-hour) when it matters.
  Everyone sees it in their own time zone, and dates read day first ("Mon 12 Oct · 14:30").
- **Works on phones and tablets:** press and hold a card, list or row to drag it. Each card's menu can also move it to
  another list, or to the top or bottom of its own. It installs as an app too (the browser's "Install" or "Add to Home
  screen"): its own icon and window. It still needs a connection, and a site served over HTTPS.
- **Sharing:** workspaces for teams (everyone in one can open its boards, without being invited to each), or boards
  shared one by one; owners, editors and viewers; share links, access codes and invites by email; a public link anyone
  can view. Changes appear for everyone live.
- **Comments** with @mentions, a notification bell and a daily email summary; **attachments** on cards and in comments.
- **Integrations:** personal API tokens (once a platform admin turns them on), webhooks per board with signed
  deliveries and retries, an MCP endpoint for AI assistants, a Skill for Claude Code, and an API reference at
  `/api/docs` on every site. Claude on the web and in Claude Desktop (and ChatGPT) can connect by signing in (OAuth),
  when a platform admin allows it. For assistants: a 90-day activity log of who changed what (and through which app),
  a team overview, searches by priority, label and time, and an Inbox for quick capture.
- **Cards in your calendar:** connect Google Calendar (Account settings → Calendar) and your cards' due dates and
  reminders appear in a calendar of Kanbanto's own there, updated within seconds; or make a private calendar link
  for Apple Calendar, Outlook and others. Your cards are the ones assigned to you, plus nobody's cards on boards
  only you are on; you choose which boards are in it. Platform admins turn each on in the console (Google Calendar
  needs a Google app, see [Calendar](docs/calendar.md)).
- **Priorities** (urgent, high, medium, low) on tasks: shown on cards, and in the Outline, filters and sorting. Boards
  can say **what they're for**.
- **Move a task to another board**, with its subtasks, comments and files (from its menu, or the card's panel). You see
  what fits before it moves: lists and labels are matched by name, and people who aren't on that board are named.
- **Descriptions and comments are formatted:** headings, bold, lists, checklists you can tick, code, quotes, tables
  and links, written in a light editor (Markdown shortcuts or a small toolbar) and saved as Markdown. Long text folds
  with "Show more", and a description can be read full page with its headings to jump to. Files and mentions work as
  before.
- **Reminders** on cards: at a time you type in plain words ("tmr 10:00", "fri 2pm") or pick, or before the due date
  (following it). They go to whoever is assigned, under the bell and by email (which can be turned off), and to
  webhooks as `reminder.due`. Assistants can set and list them.
- **Desktop notifications** (Web Push, no app to install), turned on per computer in Account → Notifications:
  reminders and @mentions pop up even when Kanbanto isn't open; clicking one opens the card.
- **Morning summary email** around 8:00 in your own time zone (set from your browser, changeable): cards due today and
  overdue, reminders later today, and mentions you haven't seen. Only when there's something; it replaces the daily
  mention email.
- **Times in plain words** when adding or renaming a card ("buy cat next monday 1pm" becomes "buy cat", due then, with
  a reminder if you like) and in the Due and Start pickers.
- **Webhooks** live in Board settings: each can send only some events (card changes, comments, reminders), and has a
  delivery log showing what was sent and what came back, with "Send again".
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
- Assistants can **set up boards**: create one, change its settings, lists and labels, and choose your Inbox. Sharing
  and deleting stay in the app.
- **Email** through any SMTP server or Resend, with limits to stay within a free plan. **File storage** on the server's
  disk or in an S3-compatible bucket (Cloudflare R2, Amazon S3, MinIO); people can bring their own.
- **Self-hosting:** one Docker Compose file, an optional HTTPS add-on, backups and restores, a Platform console for
  settings, and server commands for the rest. The encryption key for saved keys is made automatically.
