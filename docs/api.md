# API, webhooks and AI assistants

Kanbanto boards can be read and changed by scripts, other apps and AI assistants. Every Kanbanto site has its own
reference at **`/api/docs`** (for example `https://kanbanto.example.com/api/docs`), generated from what that server
accepts, with the description itself at `/api/openapi.json`. This page is the overview.

A platform admin turns these on in **Platform console → Integrations**: API tokens (off until turned on), and webhooks
(off, to public addresses only, or to any address).

## API tokens

Make one in **Account settings → API & apps**. It's shown once. Send it with every request:

```bash
curl https://kanbanto.example.com/api/boards -H "Authorization: Bearer kbt_…"
```

- A token **acts as you**, with your access to boards: it can't open anything you can't.
- **Read only** tokens can only use `GET`. **Read and make changes** tokens can also change boards.
- Tokens reach boards (tasks, comments, files, logged time, webhooks), the search across boards, workspaces, your
  own fields, your notifications, and who you are (`GET /api/auth/me`, read only). Never your account settings, other tokens or the
  Platform console, and not a board's live connection: ask again instead.
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
  `task.archive`, `tasks.archiveDone`, `task.restore`, `task.delete`, `tasks.import` (many cards in one change:
  see "Many cards at once" below), `tasks.update` (several tasks changed in one change:
  `{"type":"tasks.update","cards":[{"id":"<task id>","fields":{"status":"<list id>"}}, …]}`, each task with its own
  `fields` as `task.update` takes them), and the ones for lists, labels and the board.
- **Custom fields.** A board's own fields are in `data.fields` (id, name, type, and for a choice its options); a
  task's values are in `custom`, by field id. Set them with `task.update`:
  `{"type":"task.update","id":"<task id>","fields":{"custom":{"<field id>":"Acme","<another>":null}}}` sets the
  ones named (`null` clears one) and leaves the others. A value is text, a number, a day or moment (like `due`),
  `true` for a ticked checkbox, `["<option id>"]` for a choice, for a card link a list of links, each
  `"<board id>:<task id>"` (always with the board: a task's id is only unique on its board, and changes when it
  moves to another), or for a person field a list of user ids, who have to be people of the board (`members`).
  `tasks.clearField` clears one field on every card of the board. The fields themselves are managed elsewhere: a library per workspace
  (`/api/workspaces/<id>/fields`, its admins) and your own for Personal boards (`/api/fields`); a board's owners
  choose which ones it uses with `PUT /api/boards/<id>/fields`. See **Fields** in `/api/docs`.
- **Merging two fields.** `POST …/fields/<field id>/merge` with `{"into":"<field id>"}` merges a field into another
  of the same library and kind: every card's value moves to `into` (a card that has both keeps the one its board
  shows; lists that hold several are joined), boards and saved filters that used the field use `into`, and the
  field is gone. It can't be undone. `GET` the same address with `?into=` says first what it would do, in numbers
  (`cards`, `boards`, `both`, the `options` a choice would gain, and a `problem` when it can't be done).
- **Starter boards.** `POST /api/boards` with `template: "sales"` or `"support"` makes a board for that kind of work:
  its lists, saved filters, a few example cards, and its fields, which come from the library of where it's made.
  Fields that library has (same name and kind) are used as they are; the rest are added, which in a workspace only
  its admins may do (otherwise a 403 that names them, and nothing is made). The answer lists what was `added` and
  what was `leftOut` (fields that library has archived).
- **Links between cards.** A card link field (`type: "link"`) says where its cards come from: `linkTo` is `board`
  (with `board`, a board of the field's own space), `space` (any board there) or `same` (the board that uses it);
  `many` lets it hold several. A link is refused (422) unless its card exists, is in the same workspace (or, for
  your own fields, on a board you own) and on a board you can open. `GET /api/boards/<id>` answers with `linked`:
  what each link points at **for you** (title, board, list; `gone` for a deleted card; `hidden` for one on a board
  you can't open), since titles are never stored with the link. `GET /api/boards/<id>/linked?refs=` answers for
  more of them, `GET /api/boards/<id>/fields/<field id>/cards?q=` finds cards to link by title, and
  `GET /api/boards/<id>/tasks/<task id>/linked-from` lists the cards that link to one. When a linked card moves to
  another board of the same space its links are rewritten to follow it; when it leaves the space, or its board is
  deleted, they are removed.
- **Files.** A card has files of its own, and a comment can carry files. A file is sent as its bytes, its name in a
  header:

  ```bash
  curl -X POST "https://kanbanto.example.com/api/boards/<id>/tasks/<task id>/attachments" \
    -H "Authorization: Bearer kbt_…" \
    -H "Content-Type: application/octet-stream" \
    -H "X-File-Name: report.pdf" -H "X-File-Type: application/pdf" \
    --data-binary @report.pdf
  ```

  The answer is `{"attachment": {"id", "name", "size", "mime", "url", "image", "commentId", …}}`. Editors and owners
  attach to a card. A name the card already has gets a number (`report (2).pdf`): use the `name` that comes back.
  Percent-encode a name with anything but plain letters in it. The upload has to say its size (`curl` does).
  - **In a comment:** upload with one more header, `X-Attach-To: comment` (anyone who can comment may; the file is
    yours alone until it's posted), then post the comment with its id:
    `POST …/tasks/<task id>/comments` with `{"body": "The screenshot", "attachments": ["<file id>"]}`.
  - **In a description or a comment's words:** write `📎` and the file's name (`See 📎report.pdf`). It shows as a
    link to that file of the card.
  - `GET /api/boards/<id>/tasks/<task id>/attachments` lists a card's files, its comments' among them (`commentId`).
    `GET /api/attachments/<file id>` opens one (`curl -L`: a file kept in a bucket answers with a redirect to a
    five-minute link). `DELETE /api/boards/<id>/attachments/<file id>` puts one in a trash for 30 days, and
    `POST …/attachments/<file id>/restore` brings it back.
  - Pictures open in the page and everything else downloads. Programs and scripts (`.exe`, `.sh`, `.js`…) are
    refused. The largest file and the space a person or a workspace has are set by the site (`413` when over).
- **Archiving** (`task.archive`) puts a task and its subtasks away: they're out of the board and its counts, kept (with
  comments and files), and come back with `task.restore`. `task.delete` on an archived task deletes it for good.
  `tasks.archiveDone` tidies a done list in one go: `{"type":"tasks.archiveDone","status":"<list id>","before":"2026-09-01T00:00:00Z"}`
  archives its top-level tasks that got done before that moment, each with its subtasks (a finished task under
  unfinished work stays). A whole board is archived (read-only) with `POST /api/boards/<id>/archive` and
  `{"archived": true}` (`false` restores it).
- **Archived tasks aren't sent with the board** (a board can have far more of them than tasks on it). Ask for them:
  - `GET /api/boards/<id>/archived?from=2026-01-01&to=2026-04-01` gives the ones archived in that stretch of time,
    as the board keeps them, newest first, 200 at a time (`limit` up to 1000; pass `nextOffset` back as `offset`).
    `when=done` or `when=created` asks by another date, `when=any` by any of the three; `from` and `to` also take
    `30d`, `2w` or `24h` (that long ago). Without a range: all of them.
  - `GET /api/boards/<id>/archived?task=<task id>` gives one, with the archived tasks above and under it (an empty
    list if that task isn't archived).
  - `GET /api/boards/<id>?archived=all` sends the board with everything, under `data.archived` (an export, a backup).
  - `GET /api/cards?state=archived&board=<id>&q=<words>` searches them, across your boards, newest first, in pages.
- **Searching every board**: `GET /api/cards?state=all` (or `active`, for cards still on their boards) takes the same
  filters as the Search cards page: `q` (words in the title, description or a comment), `assignee=me`, `completed`,
  `kind`, `priority`, `label`, `due`, and a time range (`from`, `to`) about one of a card's dates (`when=done`,
  `created`, `changed` or `archived`). What I finished this week: `?state=all&assignee=me&when=done&from=2026-09-28`.
  Without `state`, only archived cards are searched. A task's `doneAt` is when it entered a done list.
  `due` takes `overdue`, `none`, or a test of the date: a word (`today`, `tomorrow`, `yesterday`, `this-week`,
  `next-week`, `last-week`, `this-month`, `next-month`, `last-month`, `past`, `future`, `any`), `next-7` or `last-30`
  (that many days from today), or two days with `..` between them (`2026-10-01..2026-10-31`; either side can be left
  out). `week` still means the next 7 days. "Today" is the day in `timeZone` (an IANA name such as `Asia/Bangkok`;
  without it, the zone in your account, then UTC), and a date with a time counts as the day it falls on there.
  By one of your own fields: `field=<field id>` makes each card say what it has for it, and `fv` keeps the cards whose
  value passes, on the boards that use the field. Every kind takes `any` or `none` (has a value or not). A choice, a
  card link or a person takes ids with commas (`-` for none picked; `me` for a person), and a leading `!` asks for
  cards with none of them (`!id1,id2`). A checkbox takes `yes` or `no`. A number takes a range like `1000..5000`,
  `1000..` or `..5000`. A date takes what `due` takes. Text takes its test first: `~word` (contains), `!~word`
  (doesn't contain), `=words` (is exactly), `!=words` (isn't), without regard to capitals. Something `fv` can't read
  is refused with a sentence saying what the field takes. The first page lists the `fields` of the boards searched.

`GET /api/boards/<id>` returns the whole board: its lists, labels, people and the tasks on it (a task's `status` is
its list's id; `parentId` makes the tree; `priority` is `urgent`, `high`, `medium` or `low`). Its archived tasks come
separately (see above).

`POST /api/boards/<id>/tasks/<task id>/move` with `{"boardId": "<other board>"}` moves a task, with its subtasks,
comments and files, to another board you can edit (optionally `"list": "<list id there>"`). It gets a new id there,
which the answer gives. Lists and labels are matched by name; people who aren't on that board are unassigned. With
`list`, `"order": {"ids": [<that list's cards, as the board shows them>], "at": 1}` gives it a place among them (0:
first) instead of the end; then the task goes in exactly that list, even a finished one.

**The Inbox.** Everyone has a private board of their own for cards that have no board yet. `GET /api/inbox` answers
`{"boardId": "<its id>", "open": 3}` (`open`: its top-level cards that aren't done; `boardId` is null until it has
been made, which `POST /api/inbox` does). It is a board like the others: read it and add to it with the board
endpoints, and file a card with the move above. Only its owner can open it, and it can't be shared, moved to a
workspace, archived or deleted (those answer 400 with `"code": "inbox"`). In `GET /api/boards` it is the one with
`"inbox": true`.

**Adding a card in one call.** For a script, an automation tool or a shortcut on a phone, there is a plainer way
than a command: `POST /api/inbox/cards` adds a card to your Inbox (made first, if you have none), and
`POST /api/boards/<id>/cards` to a board, with names instead of ids.

```bash
curl -X POST https://kanbanto.example.com/api/inbox/cards \
  -H "Authorization: Bearer kbt_…" -H "Content-Type: application/json" \
  -d '{ "title": "Call Sam about the invoice", "due": "tomorrow 3pm", "timeZone": "Asia/Bangkok" }'
```

```json
{
  "board": { "id": "01a11125-73e1-…", "name": "Inbox", "inbox": true },
  "card": {
    "id": "01a11125-73ea-…",
    "title": "Call Sam about the invoice",
    "url": "https://kanbanto.example.com/#/b/01a11125-73e1-…?task=01a11125-73ea-…"
  }
}
```

On a board, the same with what the board has, by name:

```bash
curl -X POST https://kanbanto.example.com/api/boards/<id>/cards \
  -H "Authorization: Bearer kbt_…" -H "Content-Type: application/json" \
  -d '{ "title": "Fix the sign-up page", "list": "Doing", "labels": ["ui"], "assignee": "me", "priority": "high",
        "subtasks": [{ "title": "Reproduce it on a phone" }] }'
```

| Field | What it takes |
|---|---|
| `title` | Needed. |
| `description` | Markdown. |
| `list` | A list's name or id. Left out: the first list of not-started work. |
| `due`, `start` | A day (`2026-10-31`), a moment with its time zone (`2026-10-31T14:30:00+07:00`), or words: `"tomorrow 3pm"`, `"friday"`. Words are read on the clock of `timeZone`, else the account's time zone, else UTC. |
| `labels` | Names or ids. |
| `assignee` | A person's name or id, or `"me"`. |
| `priority` | `urgent`, `high`, `medium` or `low`. |
| `fields` | The board's own fields by name: `{ "Stage": "Won", "Value": 12000 }`. |
| `subtasks` | Cards under it, each with a `title` and any of the above. |
| `parentId` | A card to put it under (boards only). |
| `datesInTitle` | `true`: a time written in the title ("Call Sam tomorrow 3pm") is taken out of it and becomes the due date, as when typing in the app. Off unless asked for: nobody is there to say a guess was wrong. |

A name that isn't on the board adds nothing and says what there is: `There’s no list “Later”. The lists are: Backlog,
To Do, Doing, Done.` Anything the call doesn't know is refused, not ignored. The card's `url` opens it in the app.

In **n8n**, this is an HTTP Request node: method `POST`, the address above, "Send Headers" with a header
`Authorization` holding `Bearer kbt_…`, and "Send Body" as JSON, such as
`{ "title": "A card from n8n", "due": "tomorrow" }`. (Tried with n8n itself: the node's answer is the card, and the
board's activity says it came through the API.) Zapier ("Webhooks by
Zapier", POST), Make ("HTTP", Make a request) and an iPhone Shortcut ("Get Contents of URL") take the same four things.

**Many cards at once, from a spreadsheet.** `POST /api/boards/<id>/tasks/import` takes rows as text, the way they
are copied out of Excel or Google Sheets (tabs between the cells) or saved as a .csv (commas or semicolons), and
adds a card for each. With `"dryRun": true` it changes nothing and answers with the check:

```bash
jq -Rs '{text: ., dryRun: true}' rows.csv | curl -X POST https://kanbanto.example.com/api/boards/<id>/tasks/import \
  -H "Authorization: Bearer kbt_…" -H "Content-Type: application/json" --data-binary @-
```

For a file holding `Task,Deadline,Tags,Status`, then `Book the photographer,2026-11-03,Marketing,To Do`,
`Order printed flyers,next week,Print,Waiting on supplier` and `,2026-11-10,,Doing`:

```json
{
  "columns": ["title", "due", "labels", "list"],
  "report": {
    "cards": 2,
    "subtasks": 0,
    "lists": ["Waiting on supplier"],
    "labels": ["Marketing", "Print"],
    "options": [],
    "noTitle": [4],
    "duplicates": [],
    "problems": [{ "column": "Deadline", "kind": "date", "rows": [3], "samples": ["next week"] }]
  },
  "added": 0
}
```

Without `dryRun` the same call adds the cards and answers with `added`, the board's new `seq` and the `changes`. It is
one change: one line in the activity ("imported 2 cards"), one `board.changed` to the board's webhooks, and each
assignee told once. Lists and labels the rows name are made; a cell that can't be read (`problems`) leaves its card
without that value; a row with no title, or whose title is already a card on the board, is left out (`noTitle`,
`duplicates`; rows are numbered as in the sheet, the first being 1).

| Field | What it takes |
|---|---|
| `text` | Needed. The rows, up to 2,000 of them and 40 columns. |
| `columns` | What each column is, in order: `title`, `description`, `list`, `due`, `start`, `labels`, `assignee`, `priority`, `parent`, `skip`, or one of the board's fields by name (or `f:<field id>`). Left out: read from the names in the first row ("Task", "Deadline", "Tags", "Owner", and Thai ones), and the answer's `columns` says what was understood. |
| `header` | `false` when the first row is a card, not column names (then say `columns`). |
| `dateOrder` | `dmy` or `mdy`: how to read `3/4/2026` in a column where no date says. Each column settles itself when one of its dates only works one way; when none does, the check says so (`report.askDateOrder`) and adding is refused until this is given. |
| `addAnyway` | `true`: also add rows whose title is already a card on the board. |
| `timeZone` | The clock a time of day in a date cell is read on (`31/10/2026 14:30`). Else the account's, else UTC. |
| `mutationId` | Yours to choose: with `addAnyway`, the same one sent again adds nothing twice. |

Dates are read in the forms people type (`2026-10-15`, `15/10/2026`, `15 Oct 2026`, `15 ต.ค. 2569`), numbers with
their separators and signs (`฿1,200`), an assignee by name or email address, a `parent` by the title of another
row or of a card on the board, a card link by the linked card's title. A new option is added to a choice field only
when the caller manages that field.

**A whole board from Trello.** `POST /api/boards/import` takes `{"file": <the JSON Trello exports>}` as well as
Kanbanto's own export files, and makes a new board in Personal: lists in order, cards, checklists as subtasks,
comments with their dates (in your name, each saying who wrote it), custom fields as fields of yours. `"lists":
{"<Trello list id>": "doing"}` says what a list counts as (`backlog`, `todo`, `doing`, `done`) where the guess from
its name isn't wanted. The answer has `trello`: what came over and what stayed behind (people, uploaded files,
comments Trello left out of the file).

**Reminders** live on a task (`reminders`: each `{ id, at }` or `{ id, beforeDue, tz }`, in minutes before its due
date), set with `task.update`. When one goes off, the task's assignee (or whoever set it, if nobody is assigned) gets
it under the bell and by email, and the board's webhooks get a `reminder.due` event.

`GET /api/boards/<id>/activity?since=2026-09-01&until=2026-09-15` says what happened in a stretch of time, newest
first: each change in words ("moved “Deploy” to Done"), who made it and through which app (`via`), and comments.
`since` and `until` also take `24h`, `3d` or `2w` (back from now). Changes are kept for 180 days. For more, ask again
with `until` set to the answer's `nextUntil`.

`GET /api/boards/<id>/tasks/<taskId>/activity` is one task's own history, newest first: `entries`, each with `at`,
`actor`, `via` and `lines`, what was done to it in words that follow the person's name ("moved it from To Do to
Doing"). `{date}` in a line stands for that line's `date`. It is read from the same activity, so it goes back 180
days too, and its comments aren't in it. Files attached, removed and restored are, and so is time logged, changed
and removed. Page with `until` and `nextUntil` as above. A line logged before 0.2 names the task, as the board's
activity does.

**Dates.** A task's `start` and `due` are a whole day, `2026-10-15`, or with a time an exact moment in UTC,
`2026-10-15T07:30:00Z`, which the app shows in each person's own time zone. Send a time with its time zone
(`2026-10-15T14:30:00+07:00` or `…Z`); it's stored in UTC, to the minute. A time without a time zone is refused, since it
would mean a different moment on every computer.

## Webhooks

A board's owners add them in **Board settings → People & apps**. Each change on the board (`board.changed`) and each new
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

(`before` and `after` are whole records; shortened here. A change with more than 200 records is cut there, with
`"truncated": true`.) The other events: `comment.added` has `board`, `actor`, `task` (`id`, `title`) and `comment`
(`id`, `body`, `mentions`, and `files`: the `id`, `name` and `size` of each file posted with it); `reminder.due` has `board`, `task` (`id`, `title`, `due`, `list`), `reminder` (`id`, `at`)
and `for` (who it's for); `ping` has `board` only.

**Say you want them.** When a webhook is added (or its address changed), Kanbanto first sends the address
`{ "event": "verify", "challenge": "<a one-time code>" }` with the header `X-Kanbanto-Event: verify`. Answer with any 2xx
within 10 seconds, with the code somewhere in the reply (the same JSON back is fine), and the webhook is saved;
otherwise it's refused. The check isn't signed (there's no secret yet): answer it before checking signatures. This is
so nobody can point a webhook at a server that isn't theirs. (A site whose admin allows webhooks to any address
doesn't ask.)

```js
if (req.headers['x-kanbanto-event'] === 'verify') return res.json({ challenge: req.body.challenge })
```

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
The same delivery keeps its `X-Kanbanto-Delivery` id across retries, so you can skip ones you've seen. Board settings
shows each webhook's latest deliveries, can send a test (`ping`), and can pause it.

Where webhooks may point is the platform admins' choice: public `https://` addresses only (safe for a site anyone can
sign up to), or also `http://` and private addresses (for tools inside your network, like a self-hosted n8n). Redirects
are never followed.


Each webhook can be set to send only some events (`events`: `board.changed`, `comment.added`, `reminder.due`; all by
default). Its log (`GET /api/boards/<id>/webhooks/<webhook id>/deliveries`, `?failed=1` for problems only) shows each
delivery's payload and the start of the answer, and `POST …/deliveries/<delivery id>/resend` sends one again. Deliveries
are kept for a week.

### To a chat channel

A webhook has a **format**, chosen when it's added (`format`, in the app "Send to"): `json` is everything above. The
others are for a channel in a chat app, which is sent the same three events as a short text it can show, with the
card's title opening the card:

| `format` | The address is | What is POSTed |
|---|---|---|
| `slack` | a channel's incoming webhook (`https://hooks.slack.com/services/…`) | `{ "text": "Ann moved <https://…|“Deploy”> to Done on Launch" }` |
| `google-chat` | a space's webhook (`https://chat.googleapis.com/v1/spaces/…`) | `{ "text": "…" }`, links written the same way |
| `teams` | a channel's workflow, the one that posts when a webhook request is received | a message holding an Adaptive Card, one line of text per change |
| `discord` | a channel's webhook (`https://discord.com/api/webhooks/…`) | `{ "content": "Ann moved [“Deploy”](<https://…>) to Done on Launch", "allowed_mentions": { "parse": [] } }` |

```bash
curl -X POST https://kanbanto.example.com/api/boards/<id>/webhooks \
  -H "Authorization: Bearer kbt_…" -H "Content-Type: application/json" \
  -d '{ "url": "https://hooks.slack.com/services/T0/B0/…", "format": "slack" }'
```

What differs from a `json` webhook:

- **The words are the activity log's.** A card change says what the board's activity says (added, moved, assigned,
  renamed, a date set…); one change with several lines is one message, eight lines at most and then "and 5 more". A
  change that only puts cards in another order says nothing. A comment is who wrote it, on which card, and its first
  200 characters; a reminder is who it's for, the card, and when it's due.
- **What people typed can't tell anyone.** A card called `@everyone` or `<!channel>` is written so the chat app
  shows those characters and mentions nobody.
- **No code to send back, no signature.** A chat app can't answer the check above, and nobody at that end would check
  a signature. Instead, the channel is sent a first message when the webhook is added ("Kanbanto will post news from
  Launch here.") and the webhook is only saved if the chat app takes it. On a site that sends webhooks to public
  addresses only, the address also has to be the chat app's own, as in the table. The answer to adding one has no
  `secret`, and the two secret routes answer 400.
- **Sending one again** sends the same message. The format can't be changed afterwards: add another webhook.

### Telegram

A board's own Telegram bot is a webhook too, with `format: "telegram"` and the bot's `token` (from @BotFather) in
place of `url`. (In the app it has a box of its own in Board settings, and its own switch for the site: a platform
admin turns on "Boards can have a Telegram bot", whatever the setting for webhooks is.)

```bash
curl -X POST https://kanbanto.example.com/api/boards/<id>/webhooks \
  -H "Authorization: Bearer kbt_…" -H "Content-Type: application/json" \
  -d '{ "format": "telegram", "token": "123456789:AAH…" }'
```

The answer is `{ "id", "connect": { "code", "privateLink", "groupLink", "minutes" } }`: nothing is sent until a chat
is connected, by sending the bot `/start <code>` from it (the links do that) within `minutes`. The first chat to do
so becomes the board's; `POST /api/boards/<id>/webhooks/<webhook id>/telegram/code` makes a new code, for another
chat to take its place. In `GET /api/boards/<id>/webhooks` such a webhook has `telegram`: `bot` (its @name), `chat`
(`kind`: `private` or `group`, and `name`; null until connected), `takesCards`, `cardsTo` and `problem`.

- The chat gets the same three events as sentences, like the chat apps above.
- With `takesCards` (on to start), what is sent in the chat becomes cards on the board, in the list `cardsTo` (null:
  the first list of not-started work): every message in someone's own chat with the bot, `/card …` in a group.
  `PATCH /api/boards/<id>/webhooks/<webhook id>/telegram` changes both, or takes a new `token` for the same bot.
- A card is added in the name of the person who added the bot, with "Telegram" as the app it came through
  (`via` in the board's activity).
- The token is kept encrypted and never returned. One bot serves one board (409 for a second).
- Messages are asked for, not sent to this server: the site needs no address Telegram can reach.

How it is used in the chat (the buttons, edits, replies, files, and the menu's `/list`, `/board` and `/today`) is in
the guide, "Telegram: a bot for a board".

The channel's address is the key to the channel: whoever has it can post there. Card titles, people's names and the
start of comments are posted in the channel, for everyone in it to read.
## AI assistants (MCP)

Kanbanto speaks the [Model Context Protocol](https://modelcontextprotocol.io) at **`/api/mcp`**, so assistants can find,
add and update tasks for you, with a token's access. Account settings → API & apps shows the exact setup for your site:

```bash
# Claude Code
claude mcp add --transport http kanbanto https://kanbanto.example.com/api/mcp --header "Authorization: Bearer kbt_…"
```

```json
// Cursor, VS Code and other apps that take a URL and headers
{ "mcpServers": { "kanbanto": { "url": "https://kanbanto.example.com/api/mcp", "headers": { "Authorization": "Bearer kbt_…" } } } }
```

Files and assistants: a tool can only carry words, so there are three ways to hand a file over. The assistant
writes it; the server fetches it from a public `https` address (never a private network; no redirects; at most
25 MB or the site's largest file; `FILES_FROM_URL=off` turns this one way off); or the assistant asks for an
**upload link** and sends a local file to it, which is how a screenshot or a log gets from the computer it works on
to a card. The link (`POST /api/uploads/<token>`, the file's bytes as the body) needs no other sign-in, so it is
built to be worth little: one file, on one card, under a name fixed in advance, once, within 10 minutes; it answers
only that the file was saved; what the person who asked may do is checked again when it's used; and it is never
written to the server's log. Assistants can't delete files.

| Tool | What it does |
|---|---|
| `list_boards` | Who you act as (name, time zone, today's date there) and the boards you can open: where each lives (a workspace, "Personal" or "Shared with you"), what it's for, and which is your Inbox (a private board of your own, for cards that have no board yet) |
| `get_board` | A board's lists, labels, people and its open tasks: the top levels (subtasks under their task), the part under one task, or one list's cards (`tasks: false` for just the lists, labels and people), and its own fields with their types and options. Top-level tasks come list by list, each list in the order made by hand (`order: outline` for the outline's order) |
| `find_tasks` | Search one board, one workspace or everything: text, list, kind of list (`counts_as: doing`: in progress on every board, whatever the list is called), label, assignee (`me`, `nobody`), priority, blocked, the board's own fields by name (`fields: {"Stage": "Won", "Client": null}`, or a test: `{"Deal value": {"min": 10000}, "Close date": {"range": "this-month"}, "Company": {"contains": "cafe"}, "Stage": {"none_of": ["Lost"]}}`; boards without the field are skipped, and a test a field's kind doesn't have is refused), due, created, last worked on, done or archived between two times; sorted and paged. Without a `sort`, results come list by list, each list in the order its cards were put in by hand, so one list reads top to bottom as on the board. Asking by when tasks got done also finds the ones archived since. `worked_after` / `worked_before`: what was worked on in a stretch of time (made or changed then), each result saying what happened |
| `team_overview` | How a board or workspace is doing: tasks per list, each person's open, overdue and blocked work, what needs attention, and the time each person logged on it this week |
| `reminders` | Your reminders coming up in the next days, and the ones that went off in the last 24 hours |
| `my_day` | What needs your attention across your boards, in one answer: your overdue tasks and the ones due today, what you have in progress, your tasks waiting on others, today's reminders, and comments that mention you and you haven't seen |
| `recent_activity` | What happened in a stretch of time (default: the last day), optionally by one person: changes, who made them and through which app, and comments, each with the board and task ids it's about |
| `get_task` | A task with its parents, subtasks, what it waits on, latest comments, its files, and the time logged on it |
| `read_file` | Open one of a task's files: a text file as text (80,000 characters at a time), a picture as a picture (up to 2 MB); other kinds are only described |
| `my_week` | Your logged time for a week across your boards: each day against your hours a day (empty days stand out), each task's time per day, and tasks you worked on without logging time |
| `plan_overview` | A workspace's resource plan, read only: each project's planned, scheduled and logged man-days, who's booked at what share; each person's load, when they go over 100% and when they're free |
| `create_tasks` | Add tasks, each with its own `subtasks` if you like, or break one down into subtasks (`parent_id`); without a board they go to your Inbox, which everyone has. A wrong list, label or person adds nothing. Each can come with `fields` (the board's own, by name) |
| `update_task` | Title, description, dates, assignee, priority, labels, what it waits on (`waiting_on`), list, and its place in the list (`position: top` / `bottom`, `before_task_id` / `after_task_id`). Put in another list, it goes to the end unless placed. `fields: {"Stage": "Won", "Value": 12000}` sets the board's own fields by name (`null` clears one; a card link takes a card's title, a person field a person's name or `me`) |
| `update_tasks` | The same change to several tasks at once (`task_ids`), as one change with one line of activity: their list, assignee, priority, dates, the board's own fields, labels (`labels` replaces them, `add_labels` and `remove_labels` keep the others). `with_subtasks` also takes every task under them, which is how a task moves to another list with its subtasks. A wrong id or name changes nothing; asked twice, it changes nothing the second time |
| `move_task` | Change a task's parent or its place among siblings in the outline |
| `set_reminder` | Add a reminder (at a time, or some minutes before it's due: before a whole due day, from 9:00 in your time zone) or remove one; it goes to the task's assignee |
| `archive_task` | Archive a task with its subtasks, or restore it (`restore: true`); nothing is lost |
| `archive_done_tasks` | Tidy a board: archive a done list's top-level tasks that got done more than some days ago, with their subtasks (`dry_run` says what would go) |
| `move_to_board` | Move a task, with its subtasks, comments and files, to another board (say, from the Inbox) |
| `create_board` | A new board in Personal or a workspace, with what it's for; `starter: "sales"`, `"support"`, `"store"` or `"bookings"` for one that comes with its own lists, fields, saved filters and example cards. A starter's cards link to a client each, on a Clients board made with the first starter in a space and shared by the ones after (`clients_board` in the answer) |
| `update_board` | Name, what it's for, background, how a parent task's status is set |
| `manage_lists` | Add, rename, reorder, change the kind of, or remove (empty) lists |
| `manage_labels` | Add, rename, recolor, or remove (unused) labels |
| `manage_fields` | A library's fields (a workspace's, for its admins, or your own): list them, add one, change its name or settings, give a choice its options by name (one left out is archived, never deleted), rename an option, archive and restore. And a board's own choice (its owners): put a field on it, or take it off |
| `log_time` | Log time you spent on a task ("1:30", "2h", "45m"), today, yesterday or another day, with a short note |
| `add_comment` | Comment as you; `@Name` notifies people, and so are the task's followers; `📎name` points at one of the task's files |
| `attach_file` | Put a file on a task: one the assistant writes (`text`, up to 500 kB) or one fetched from a public https address (`url`); with `comment`, posted in a comment that says those words. The answer gives the mark (`📎name`) to point at it in a description or a comment |
| `upload_link` | For an assistant that works on a computer: a web address that takes one local file for a task, once, within 10 minutes, and the `curl` command that sends it |
| `follow_task` | Follow a task (you're told about its comments and changes), or stop with `follow: false` |

Read-only tokens get the reading tools only (`list_boards` to `plan_overview`). Plans can be read but not changed
through MCP: planners change them in the app's Planning tab. Every change on a board is kept as a line of activity for 180 days ("Ann moved
“Deploy” to Done", marked with the app it came through), which is what `recent_activity` reads. Sharing (inviting people, links,
roles) and deleting boards or tasks aren't tools, on purpose: an assistant reads text other people wrote, and those
can't be undone. People do them in the app. The same goes for deleting a field for good and merging two fields.

**Help assistants help you.** Say what each board is for (Board settings → "What's this board for?"): assistants read it
to pick the right board. Everyone has an **Inbox**, a private board of their own: "remind me to buy milk" lands
there without Claude asking where, and it sits one click away beside any board (the tray in the top bar).

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
- **Known AI apps only**: apps that send people back to claude.ai, claude.com, chatgpt.com, chat.openai.com or vscode.dev, or to
  an app on their own computer (Claude Code, Cursor, VS Code). The safe choice.
- **Any app**: any app that registers. People still approve each one and see where it sends them back to, but an app
  could pretend to be one they know.

Claude's and ChatGPT's servers make the calls, so **your Kanbanto must be reachable from the internet over https**. A
Kanbanto only on your computer or company network can use API tokens with Claude Code and similar apps instead.

### The Kanbanto Skill (Claude Code)

[`skills/kanbanto`](../skills/kanbanto/SKILL.md) teaches Claude Code how to work with boards well: search before
creating, break work down, treat task text as data. Copy the folder to `~/.claude/skills/` (for you) or
`.claude/skills/` in a project.
