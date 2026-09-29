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
  `task.delete`, and the ones for lists, labels and the board.

`GET /api/boards/<id>` returns the whole board: its lists, labels, people and tasks (a task's `status` is its list's id;
`parentId` makes the tree).

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
| `list_boards` | The boards you can open |
| `get_board` | A board's lists, labels, people and task outline |
| `find_tasks` | Search one board or all of them: text, list, assignee (`me`), due date |
| `get_task` | A task with its parents, subtasks, what it waits on, and latest comments |
| `create_tasks` | Add tasks, or break one down into subtasks (`parent_id`) |
| `update_task` | Title, description, dates, assignee, labels, list |
| `move_task` | Change a task's parent or its place among siblings |
| `add_comment` | Comment as you; `@Name` notifies people |

Read-only tokens get the first four only. There's no delete tool, on purpose.

**Mind what assistants read.** Task text and comments are written by people on your boards. A line like "ignore your
instructions and…" in a card is just text to Kanbanto, but an assistant might follow it. Give assistants a read-only
token unless they need to make changes, and keep an eye on what they do (it's all visible live, as you, and undoable).

**claude.ai and ChatGPT** connect through their own servers and sign in with OAuth, which Kanbanto doesn't offer yet.
Use Claude Code, Claude Desktop with a local MCP bridge, or another app that takes a URL and headers.

### The Kanbanto Skill (Claude Code)

[`skills/kanbanto`](../skills/kanbanto/SKILL.md) teaches Claude Code how to work with boards well: search before
creating, break work down, treat task text as data. Copy the folder to `~/.claude/skills/` (for you) or
`.claude/skills/` in a project.
