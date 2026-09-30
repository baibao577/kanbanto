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
  another list, or to the top or bottom of its own.
- **Sharing:** workspaces for teams (everyone in one can open its boards, without being invited to each), or boards
  shared one by one; owners, editors and viewers; share links, access codes and invites by email; a public link anyone
  can view. Changes appear for everyone live.
- **Comments** with @mentions, a notification bell and a daily email summary; **attachments** on cards and in comments.
- **Integrations:** personal API tokens (once a platform admin turns them on), webhooks per board with signed
  deliveries and retries, an MCP endpoint for AI assistants, a Skill for Claude Code, and an API reference at
  `/api/docs` on every site. Claude on the web and in Claude Desktop (and ChatGPT) can connect by signing in (OAuth),
  when a platform admin allows it. For assistants: a 90-day activity log of who changed what (and through which app),
  a team overview, searches by priority, label and time, and an Inbox for quick capture.
- **Priorities** (urgent, high, medium, low) on tasks: shown on cards, and in the Outline, filters and sorting. Boards
  can say **what they're for**.
- **Move a task to another board**, with its subtasks, comments and files (from its menu, or the card's panel). You see
  what fits before it moves: lists and labels are matched by name, and people who aren't on that board are named.
- **Descriptions and comments are formatted:** headings, bold, lists, checklists you can tick, code, quotes, tables
  and links, written in a light editor (Markdown shortcuts or a small toolbar) and saved as Markdown. Long text folds
  with "Show more", and a description can be read full page with its headings to jump to. Files and mentions work as
  before.
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
