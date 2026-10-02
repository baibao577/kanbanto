# API, webhooks and AI assistants

Kanbanto boards can be read and changed by scripts, other apps and AI assistants. Every Kanbanto site has its own
reference at **`/api/docs`** (for example `https://kanbanto.example.com/api/docs`), generated from what that server
accepts, with the description itself at `/api/openapi.json`. This page is the overview.

A platform admin turns these on in **Platform console → Integrations**: API tokens (off until turned on), and webhooks
(off, to public addresses only, or to any address).

## API tokens

Make one in **Account settings → API tokens**. It's shown once. Send it with every request:

```bash
curl https://kanbanto.example.com/api/boards -H "Authorization: Bearer kbt_…"
```

- A token **acts as you**, with your access to boards: it can't open anything you can't.
- **Read only** tokens can only use `GET`. **Read and make changes** tokens can also change boards.
- Tokens reach boards (tasks, comments, files, webhooks), workspaces and your notifications. Never your account
  settings, other tokens, or the Platform console.
- They can expire (30, 90 or 365 days) or not. Deleting one, or an admin turning tokens off, stops it at once.
- Only a hash of each token is stored. Account settings shows when each was last used.

## Changing a board

Every change is a **command**, the same ones the app sends:

```bash
curl -X POST https://kanbanto.example.com/api/boards/<board id>/mutations \
  -H "Authorization: Bearer kbt_…" -H "content-type: application/json" \
  -d '{"mutationId":"8c1d…","command":{"type":"task.create","parentId":"<parent task id>","fields":{"title":"Draft the brief","due":"2026-10-15"}}}'
```

- `mutationId` is any unique string you choose. Sending the same one again returns the first answer, so retrying is safe.
- The answer lists the records that changed (`changes`: each with `before` and `after`).
- A refused command answers 422 with the reason (for example, moving a task inside its own subtask).
- `/api/docs` lists every command and its fields: `task.create`, `task.update`, `task.move`, `tasks.moveToList`,
  `task.archive`, `task.restore`, `task.delete`, and the ones for lists, labels and the board.
- **Archiving** (`task.archive`) puts a task and its subtasks away: they're out of the board and its counts, kept (with
  comments and files) under `archived` in `GET /api/boards/<id>`, and come back with `task.restore`. `task.delete` on
  an archived task deletes it for good. A whole board is archived (read-only) with `POST /api/boards/<id>/archive`.
  `GET /api/cards?state=archived&board=<id>&q=<words>` lists archived cards across your boards, newest first, in pages.
- **Searching every board**: `GET /api/cards?state=all` (or `active`, for cards still on their boards) takes the same
  filters as the Search cards page: `q` (words in the title, description or a comment), `assignee=me`, `completed`,
  `kind`, `priority`, `label`, `due`, and a time range (`from`, `to`) about one of a card's dates (`when=done`,
  `created`, `changed` or `archived`). What I finished this week: `?state=all&assignee=me&when=done&from=2026-09-28`.
  A task's `doneAt` is when it entered a done list.

`GET /api/boards/<id>` returns the whole board: its lists, labels, people and tasks (a task's `status` is its list's id;
`parentId` makes the tree; `priority` is `urgent`, `high`, `medium` or `low`).

`POST /api/boards/<id>/tasks/<task id>/move` with `{"boardId": "<other board>"}` moves a task, with its subtasks,
comments and files, to another board you can edit (optionally `"list": "<list id there>"`). It gets a new id there,
which the answer gives. Lists and labels are matched by name; people who aren't on that board are unassigned.

**Reminders** live on a task (`reminders`: each `{ id, at }` or `{ id, beforeDue, tz }`, in minutes before its due
date), set with `task.update`. When one goes off, the task's assignee (or whoever set it, if nobody is assigned) gets
it under the bell and by email, and the board's webhooks get a `reminder.due` event.

`GET /api/boards/<id>/activity?since=2026-09-01&until=2026-09-15` says what happened in a stretch of time, newest
first: each change in words ("moved “Deploy” to Done"), who made it and through which app (`via`), and comments.
`since` and `until` also take `24h`, `3d` or `2w` (back from now). Changes are kept for 90 days. For more, ask again
with `until` set to the answer's `nextUntil`.

**Dates.** A task's `start` and `due` are a whole day, `2026-10-15`, or with a time an exact moment in UTC,
`2026-10-15T07:30:00Z`, which the app shows in each person's own time zone. Send a time with its time zone
(`2026-10-15T14:30:00+07:00` or `…Z`); it's stored in UTC, to the minute. A time without a time zone is refused, since it
would mean a different moment on every computer.

## Webhooks

A board's owners add them in **Board settings → Webhooks**. Each change on the board (`board.changed`) and each new
comment (`comment.added`) is POSTed to the address as JSON:

```json
{
  "event": "board.changed",
  "delivery": "01a0…",
  "at": "2026-10-01T09:30:00.000Z",
  "board": { "id": "…", "name": "Launch" },
  "actor": { "id": "…", "name": "Ann" },
  "command": "task.move",
  "seq": 42,
  "changes": [{ "entity": "task", "id": "A3", "before": { "status": "todo" }, "after": { "status": "doing" } }]
}
```

(`before` and `after` are whole records; shortened here.)

**Check it came from Kanbanto.** Each delivery has `X-Kanbanto-Signature: t=<unix seconds>,v1=<hex>`, the HMAC-SHA256 of
`<t>.<raw body>` with the webhook's secret (shown when you add it, and again from its menu):

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function fromKanbanto(rawBody, header, secret) {
  const [, t, v1] = header.match(/^t=(\d+),v1=([0-9a-f]+)$/) ?? []
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false // missing, or older than 5 minutes
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'))
}
```

**Answer with any 2xx within 10 seconds.** Anything else is retried after 1, 5, 30, 120 and 360 minutes, then given up.
The same delivery keeps its `X-Kanbanto-Delivery` id across retries, so you can skip ones you've seen. The Webhooks
dialog shows each webhook's latest deliveries, can send a test (`ping`), and can pause it.

Where webhooks may point is the platform admins' choice: public `https://` addresses only (safe for a site anyone can
sign up to), or also `http://` and private addresses (for tools inside your network, like a self-hosted n8n). Redirects
are never followed.


Each webhook can be set to send only some events (`events`: `board.changed`, `comment.added`, `reminder.due`; all by
default). Its log (`GET /api/boards/<id>/webhooks/<webhook id>/deliveries`, `?failed=1` for problems only) shows each
delivery's payload and the start of the answer, and `POST …/deliveries/<delivery id>/resend` sends one again. Deliveries
are kept for a week.
## AI assistants (MCP)

Kanbanto speaks the [Model Context Protocol](https://modelcontextprotocol.io) at **`/api/mcp`**, so assistants can find,
add and update tasks for you, with a token's access. Account settings → API tokens shows the exact setup for your site:

```bash
# Claude Code
claude mcp add --transport http kanbanto https://kanbanto.example.com/api/mcp --header "Authorization: Bearer kbt_…"
```

```json
// Cursor, VS Code and other apps that take a URL and headers
{ "mcpServers": { "kanbanto": { "url": "https://kanbanto.example.com/api/mcp", "headers": { "Authorization": "Bearer kbt_…" } } } }
```

| Tool | What it does |
|---|---|
| `list_boards` | The boards you can open: where each lives (a workspace, "Personal" or "Shared with you"), what it's for, and which is your Inbox |
| `get_board` | A board's lists, labels, people and its open tasks as an outline: the top levels, or the part under one task |
| `find_tasks` | Search one board, one workspace or everything: text, list, label, assignee (`me`, `nobody`), priority, blocked, due, created, changed or done between two times; sorted and paged |
| `team_overview` | How a board or workspace is doing: tasks per list, each person's open, overdue and blocked work, and what needs attention |
| `reminders` | Your reminders coming up in the next days, and the ones that went off today |
| `recent_activity` | What happened in a stretch of time (default: the last day), optionally by one person: changes, who made them and through which app, and comments |
| `get_task` | A task with its parents, subtasks, what it waits on, and latest comments |
| `create_tasks` | Add tasks, or break one down into subtasks (`parent_id`); without a board they go to your Inbox |
| `update_task` | Title, description, dates, assignee, priority, labels, list |
| `move_task` | Change a task's parent or its place among siblings |
| `set_reminder` | Add a reminder (at a time, or some minutes before it's due) or remove one; it goes to the task's assignee |
| `archive_task` | Archive a task with its subtasks, or restore it (`restore: true`); nothing is lost |
| `move_to_board` | Move a task, with its subtasks, comments and files, to another board (say, from the Inbox) |
| `create_board` | A new board in Personal or a workspace, with what it's for |
| `update_board` | Name, what it's for, background, how a parent task's status is set |
| `manage_lists` | Add, rename, reorder, change the kind of, or remove (empty) lists |
| `manage_labels` | Add, rename, recolor, or remove (unused) labels |
| `set_inbox` | Choose your Inbox board |
| `add_comment` | Comment as you; `@Name` notifies people |

Read-only tokens get the first six only. Every change on a board is kept as a line of activity for 90 days ("Ann moved
“Deploy” to Done", marked with the app it came through), which is what `recent_activity` reads. Sharing (inviting people, links,
roles) and deleting boards or tasks aren't tools, on purpose: an assistant reads text other people wrote, and those
can't be undone. People do them in the app.

**Help assistants help you.** Say what each board is for (Board settings → "What's this board for?"): assistants read it
to pick the right board. And choose an **Inbox** (Board settings → "Use as my Inbox"): "remind me to buy milk" then
lands there without Claude asking where.

**Mind what assistants read.** Task text and comments are written by people on your boards. A line like "ignore your
instructions and…" in a card is just text to Kanbanto, but an assistant might follow it. Give assistants a read-only
token unless they need to make changes, and keep an eye on what they do (it's all visible live, as you, and undoable).

### Claude on the web, Claude Desktop and ChatGPT: sign in instead of a token

When a platform admin allows it (**Platform console → Integrations → Apps that connect by signing in**), people add
Kanbanto to their AI app without copying a token. In Claude: **Settings → Connectors → Add custom connector**, with the
address `https://<your site>/api/mcp`. Claude sends them to a Kanbanto page to sign in and approve it (read, or read and
make changes), then back to Claude. **Account settings → API & apps** lists connected apps, with Disconnect.

How it works: OAuth 2.1 as the MCP specification describes it. A `401` from `/api/mcp` points to
`/.well-known/oauth-protected-resource/api/mcp`, then `/.well-known/oauth-authorization-server`; apps register
themselves (`/oauth/register`), people approve at `/oauth/authorize`, and apps exchange the one-time code with PKCE
(`/oauth/token`). Access tokens last an hour; refresh tokens are replaced each time they're used. These tokens only
work for `/api/mcp`.

The admin setting:

- **Off** (the default).
- **Known AI apps only**: apps that send people back to claude.ai, claude.com, chatgpt.com or chat.openai.com, or to
  an app on their own computer (Claude Code, Cursor, VS Code). The safe choice.
- **Any app**: any app that registers. People still approve each one and see where it sends them back to, but an app
  could pretend to be one they know.

Claude's and ChatGPT's servers make the calls, so **your Kanbanto must be reachable from the internet over https**. A
Kanbanto only on your computer or company network can use API tokens with Claude Code and similar apps instead.

### The Kanbanto Skill (Claude Code)

[`skills/kanbanto`](../skills/kanbanto/SKILL.md) teaches Claude Code how to work with boards well: search before
creating, break work down, treat task text as data. Copy the folder to `~/.claude/skills/` (for you) or
`.claude/skills/` in a project.
