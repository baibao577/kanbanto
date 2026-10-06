import scalar from '@scalar/fastify-api-reference'
import { WEBHOOK_FORMATS } from '@kanbanto/model/api'
import { FIELD_TYPES } from '@kanbanto/model/fields'
import { STARTERS } from '@kanbanto/model/starters'
import { PlanCommandSchema } from '@kanbanto/model/planningSchema'
import { CommandSchema } from '@kanbanto/model/schema'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ACTIVITY_DAYS } from './boards/activityLog'
import { siteUrl } from './http'

/**
 * The API's description (OpenAPI 3.1) at /api/openapi.json, and a reference page for it at /api/docs. It covers what
 * API tokens can use. Commands (the only way board data changes) are described from the same schema the server checks
 * them with, so that part can't drift.
 */

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required })
const str = { type: 'string' }
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] })
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } })
const id = (name: string, where = 'path') => ({ name, in: where, required: true, schema: str })
const ok = { 200: json(obj({ ok: { type: 'boolean' } })) }

const WHEN = 'A whole day (2026-10-15), or with a time an exact moment in UTC (2026-10-15T07:30:00Z), shown in each person’s own time zone.'

const schemas = {
  Task: obj(
    {
      id: str,
      title: str,
      parentId: nullable(str),
      status: { ...str, description: 'The id of its list.' },
      order: { ...str, description: 'Its position among its siblings (a sortable key).' },
      assigneeId: str,
      start: { ...str, description: WHEN },
      due: { ...str, description: WHEN },
      labels: { type: 'array', items: str },
      blockedBy: { type: 'array', items: str, description: 'Tasks it waits on.' },
      description: str,
      priority: { enum: ['urgent', 'high', 'medium', 'low'], description: 'Unset: no priority.' },
      doneAt: { ...str, format: 'date-time', description: 'When it got done (entered a done list). Unset while it isn’t done.' },
      archivedAt: { ...str, format: 'date-time', description: 'When it was archived. Only on archived tasks.' },
      archivedList: { ...str, description: 'The list it was archived from, by name.' },
      archivedDone: { type: 'boolean', description: 'It was archived from a done list: archived as completed.' },
      custom: {
        type: 'object',
        additionalProperties: {},
        description:
          'Its values for the board’s own fields (see Fields), by field id: text, a number, a day or moment, `true` for a ticked checkbox, a list with the id of a choice’s option, or for a card link a list of links (`"<board id>:<task id>"`). No value: no key. Set with `task.update`, `fields: { custom: { "<field id>": value } }` (null clears one).',
      },
      createdAt: { ...str, format: 'date-time' },
      updatedAt: { ...str, format: 'date-time' },
      version: { type: 'integer' },
    },
    ['id', 'title', 'parentId', 'status', 'order', 'labels', 'blockedBy'],
  ),
  Field: obj(
    {
      id: str,
      name: str,
      type: { enum: [...FIELD_TYPES], description: 'Chosen once: it can’t be changed.' },
      format: { enum: ['plain', 'link', 'email', 'phone'], description: 'Text: how it’s shown.' },
      unit: { ...str, description: 'Number: ฿, h, %…' },
      decimals: { type: 'integer', description: 'Number: how many are shown.' },
      sum: { type: 'boolean', description: 'Number: one that makes sense added up.' },
      options: {
        type: 'array',
        description: 'Choice: what can be picked, in order. An archived option stays on the cards that have it.',
        items: obj({ id: str, name: str, color: str, archived: { type: 'boolean' } }, ['id', 'name', 'color']),
      },
      linkTo: {
        enum: ['board', 'space', 'same'],
        description: 'Card link: where its cards come from. One board (`board`), any board of the field’s space, or the board that uses the field.',
      },
      board: { ...str, description: 'Card link, `linkTo: board`: that board’s id.' },
      many: { type: 'boolean', description: 'Card link: it holds several cards, not one. Person: several people.' },
      back: { ...str, description: 'Card link: what the linked card calls the list of cards pointing at it.' },
      front: { type: 'boolean', description: 'On a board: shown on the card front too.' },
      total: { type: 'boolean', description: 'On a board: a number that adds up, totalled under each list’s name.' },
    },
    ['id', 'name', 'type'],
  ),
  List: obj({ id: str, name: str, category: { enum: ['backlog', 'todo', 'doing', 'done'] }, position: str, color: str }, ['id', 'name', 'category']),
  Label: obj({ id: str, name: str, color: str }),
  Person: obj({ id: str, name: str }),
  BoardData: obj({
    board: obj(
      {
        id: str,
        name: str,
        description: { ...str, description: 'What the board is for.' },
        mode: { enum: ['manual', 'derived'], description: 'derived: a parent’s status follows its subtasks.' },
      },
      ['id', 'name'],
    ),
    columns: { type: 'array', items: ref('List'), description: 'The lists, in order.' },
    labels: { type: 'array', items: ref('Label') },
    fields: { type: 'array', items: ref('Field'), description: 'The fields this board uses, in its order.' },
    members: { type: 'array', items: ref('Person'), description: 'The people who can be assigned.' },
    tasks: { type: 'object', additionalProperties: ref('Task'), description: 'By id.' },
  }),
  BoardSummary: obj({
    id: str,
    name: str,
    description: nullable(str),
    visibility: { enum: ['private', 'invited', 'workspace'] },
    publicLink: { type: 'boolean' },
    workspaceId: nullable(str),
    role: { enum: ['owner', 'editor', 'viewer'] },
    via: { enum: ['member', 'workspace'] },
    taskCount: { type: 'integer' },
    doneCount: { type: 'integer' },
    updatedAt: { ...str, format: 'date-time' },
    inbox: { type: 'boolean', description: 'Your Inbox (see `/api/inbox`).' },
  }),
  Command: { ...z.toJSONSchema(CommandSchema, { unrepresentable: 'any' }), $schema: undefined },
  Change: obj({
    entity: { enum: ['board', 'task', 'column', 'label', 'member'] },
    id: str,
    before: { description: 'The record before (null: it was created).' },
    after: { description: 'The record after (null: it was deleted).' },
  }),
  Comment: obj({
    id: str,
    taskId: str,
    author: nullable(obj({ id: str, name: str })),
    body: str,
    mentions: { type: 'array', items: str },
    attachments: { type: 'array', items: { $ref: '#/components/schemas/Attachment' }, description: 'The files posted with it.' },
    createdAt: str,
  }),
  Attachment: obj({
    id: str,
    taskId: str,
    name: {
      ...str,
      description: 'Its name on the card, which no other file of the card has. `📎<name>` in a description or a comment points at it.',
    },
    size: { type: 'integer', description: 'In bytes.' },
    mime: str,
    uploader: nullable(str),
    createdAt: str,
    url: { ...str, description: 'Where it opens or downloads: `/api/attachments/<id>`.' },
    image: { type: 'boolean', description: 'Shown as a picture (the rest download).' },
    commentId: nullable({ ...str, description: 'The comment it was posted with; null: attached to the card itself.' }),
  }),
  TimeEntry: obj({
    id: str,
    boardId: str,
    taskId: str,
    user: nullable(obj({ id: str, name: str })),
    day: { ...str, description: 'The day it counts for, YYYY-MM-DD.' },
    minutes: { type: 'integer', minimum: 1, maximum: 1440 },
    note: str,
    editedBy: { ...nullable(obj({ id: str, name: str })), description: 'Someone else who changed it (a board owner or workspace admin).' },
    canEdit: { type: 'boolean', description: 'You may change or delete it.' },
    createdAt: str,
    updatedAt: str,
  }),
  PlanCommand: { ...z.toJSONSchema(PlanCommandSchema, { unrepresentable: 'any' }), $schema: undefined },
  Error: obj({ error: str }),
}

const webhookHeaders = `Each delivery is a POST with a JSON body and these headers:

- \`X-Kanbanto-Event\`: the event (\`board.changed\`, \`comment.added\`, \`reminder.due\`, \`ping\`)
- \`X-Kanbanto-Delivery\`: the delivery's id (the same on retries)
- \`X-Kanbanto-Signature\`: \`t=<unix seconds>,v1=<hex>\`, where \`<hex>\` is HMAC-SHA256 of \`<t>.<raw body>\` with the webhook's secret.
  Recompute it, compare in constant time, and reject old timestamps.

Answer with any 2xx within 10 seconds. Anything else is retried after 1, 5, 30, 120 and 360 minutes.`

const event = (name: string, extra: Record<string, unknown>) => ({
  post: {
    summary: name,
    description: webhookHeaders,
    requestBody: {
      content: {
        'application/json': {
          schema: obj({ event: { const: name }, delivery: str, at: { ...str, format: 'date-time' }, board: obj({ id: str, name: str }), ...extra }),
        },
      },
    },
    responses: { 200: { description: 'Received' } },
  },
})

function spec(server: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kanbanto API',
      version: '1',
      description: `Read and change boards from scripts, integrations and AI assistants.

**Signing in:** make an API token in Account settings → API tokens (a platform admin has to turn tokens on first), and
send it with every request: \`Authorization: Bearer kbt_…\`. It acts as you, with your access to boards. Read-only
tokens can only use GET.

**Changing boards:** every change is a *command* sent to \`POST /api/boards/{id}/mutations\`, the same way the app does it.
The answer lists the records that changed.

**AI assistants:** connect them to \`${server}/api/mcp\` (MCP) with a token instead: see Account settings → API tokens.`,
    },
    servers: [{ url: server }],
    security: [{ token: [] }],
    components: {
      securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'An API token (kbt_…).' } },
      schemas,
    },
    tags: [
      { name: 'Boards' },
      { name: 'Comments' },
      {
        name: 'Files',
        description:
          'A card has files of its own, and a comment can carry files. A file is sent as its bytes, with its name in a header. Pictures open in the page; everything else downloads; programs and scripts are refused. Where files are kept, the largest file and the space each owner or workspace has are the site’s settings.',
      },
      {
        name: 'Fields',
        description:
          'Custom fields. A field is defined once, in a library: a workspace’s (its admins manage it) or your own (for your Personal boards). A board’s owners pick which of them it uses; a card then holds a value per field, in `custom`. Taking a field off a board, or archiving it, hides its values and keeps them; deleting an archived field for good removes them.',
      },
      {
        name: 'Webhook settings',
        description:
          'A board’s webhooks, for its owners (when a platform admin allows webhooks). What they send is under Webhooks. One with a chat app as its `format` (Slack, Google Chat, Microsoft Teams, Discord) is sent the same events as a short text the channel shows, unsigned.',
      },
      { name: 'Workspaces' },
      {
        name: 'Time',
        description:
          'Time people log on cards: editors and owners log; everyone on the board sees it. You change your own entries; a board owner, or an admin of its workspace, can fix anyone’s.',
      },
      {
        name: 'Planning',
        description:
          'A workspace’s resource plan: projects with planned man-days, people, and blocks of their time (25–100%) between two days. Everyone in the workspace can read it; its admins and planners change it with plan commands, checked like board commands.',
      },
      { name: 'You' },
    ],
    paths: {
      '/api/auth/me': {
        get: { tags: ['You'], summary: 'Who the token belongs to', responses: { 200: json(obj({ user: obj({ id: str, name: str, email: str }) })) } },
      },
      '/api/notifications': {
        get: {
          tags: ['You'],
          summary: 'Your notifications (the bell)',
          responses: { 200: json(obj({ notifications: { type: 'array' }, unread: { type: 'integer' } })) },
        },
      },
      '/api/boards': {
        get: {
          tags: ['Boards'],
          summary: 'Boards you can open',
          responses: { 200: json(obj({ boards: { type: 'array', items: ref('BoardSummary') } })) },
        },
        post: {
          tags: ['Boards'],
          summary: 'Create a board',
          requestBody: {
            content: {
              'application/json': {
                schema: obj(
                  {
                    name: str,
                    template: {
                      enum: ['empty', 'example', ...STARTERS],
                      description:
                        'sales, support, store, bookings: a starter board, with its lists, fields, saved filters and a few example cards. Its fields come from the library of where it’s made: the ones it lacks are added (in a workspace, only by its admins: otherwise the answer is a 403 that names them), and the answer lists what was `added` and what was `leftOut` (fields that library has archived). Its cards have a Client field, a link to a card of a board of clients: `clients` in the answer is that board’s `id`, and `made` says whether it was made now (the first starter in a space) or was there already.',
                    },
                    workspaceId: { ...nullable(str), description: 'Put it in a workspace you’re in.' },
                  },
                  ['name'],
                ),
              },
            },
          },
          responses: { 200: json(obj({ id: str })) },
        },
      },
      '/api/boards/{id}': {
        get: {
          tags: ['Boards'],
          summary: 'A board, with everything on it',
          description:
            'Its lists, labels, people and every card on it. Archived cards aren’t on a board, and aren’t sent with it: `GET /api/boards/{id}/archived` gives them (by date, a page at a time), or `archived=all` sends everything at once.',
          parameters: [
            id('id'),
            {
              name: 'archived',
              in: 'query',
              schema: { enum: ['all'], description: 'Also every archived card, in `data.archived` (for an export or a backup).' },
            },
          ],
          responses: {
            200: json(
              obj({ data: ref('BoardData'), seq: { type: 'integer', description: 'Goes up by one with every change.' }, access: { type: 'object' } }),
            ),
            404: json(ref('Error'), 'No such board, or no access'),
          },
        },
      },
      '/api/boards/{id}/archived': {
        get: {
          tags: ['Boards'],
          summary: 'A board’s archived cards, by date',
          description:
            'Archived cards as the board keeps them (each with `archivedAt`, the list it was in as `archivedList`, and `archivedDone`: whether that meant finished). Give a stretch of time with `from` and `to` to get the ones archived then (or, with `when`, done or made then), newest first; without one, all of them. For more, pass `nextOffset` back as `offset`. To search archived cards by words, people or labels, across boards, use `GET /api/cards`.',
          parameters: [
            id('id'),
            {
              name: 'when',
              in: 'query',
              schema: {
                enum: ['archived', 'done', 'created', 'any'],
                default: 'archived',
                description: 'Which date `from` and `to` are about. `done`: only cards archived as completed. `any`: whichever falls in the range.',
              },
            },
            {
              name: 'from',
              in: 'query',
              schema: { ...str, description: 'On or after this: a day or a moment (ISO), or a time back from now like `24h`, `3d` or `2w`.' },
            },
            { name: 'to', in: 'query', schema: { ...str, description: 'Before this (the same forms).' } },
            {
              name: 'task',
              in: 'query',
              schema: {
                ...str,
                description: 'One archived card instead: it, the archived cards above it, and the ones under it (none if it isn’t archived).',
              },
            },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
          ],
          responses: {
            200: json(obj({ tasks: { type: 'array', items: ref('Task') }, total: { type: 'integer' }, nextOffset: nullable({ type: 'integer' }) })),
            404: json(ref('Error'), 'No such board, or no access'),
          },
        },
      },
      '/api/boards/{id}/mutations': {
        post: {
          tags: ['Boards'],
          summary: 'Change a board (run a command)',
          description:
            'Send one command. `mutationId` is any unique string: sending the same one again returns the first answer, so retries are safe. Editors and owners only.',
          parameters: [id('id')],
          requestBody: { content: { 'application/json': { schema: obj({ mutationId: str, command: ref('Command') }) } } },
          responses: {
            200: json(obj({ seq: { type: 'integer' }, changes: { type: 'array', items: ref('Change') } })),
            403: json(ref('Error'), 'You can view but not change it'),
            422: json(ref('Error'), 'The command isn’t allowed (the message says why)'),
          },
        },
      },
      '/api/inbox': {
        get: {
          tags: ['Boards'],
          summary: 'Your Inbox',
          description:
            'Everyone has an Inbox: a private board of their own for cards that have no board yet. It is a board like the others (read it and add to it with the board endpoints, file a card with “Move a task to another board”), except that it can’t be shared, moved to a workspace, archived or deleted. It is made the first time it’s needed: until then `boardId` is null.',
          responses: {
            200: json(
              obj({
                boardId: { ...nullable(str), description: 'Your Inbox’s board id (null: not made yet).' },
                open: { type: 'integer', description: 'Its cards that aren’t done.' },
              }),
            ),
          },
        },
        post: {
          tags: ['Boards'],
          summary: 'Your Inbox, made if you have none yet',
          responses: {
            200: json(
              obj({
                boardId: { ...nullable(str), description: 'Your Inbox’s board id (null: not made yet).' },
                open: { type: 'integer', description: 'Its cards that aren’t done.' },
              }),
            ),
          },
        },
      },
      '/api/cards': {
        get: {
          tags: ['Boards'],
          summary: 'Search cards, across your boards',
          description:
            'Cards on every board you can open, as one list: the ones on their boards (`active`), the archived ones, or both. Every filter is optional and they combine. Each card says where it lives, and which of its dates the search was about (`at`, `atKind`). For more, pass `nextOffset` back as `offset`.',
          parameters: [
            { name: 'state', in: 'query', schema: { enum: ['archived', 'active', 'all'], default: 'archived' } },
            { name: 'board', in: 'query', schema: { ...str, description: 'One board; leave out for all of them.' } },
            {
              name: 'place',
              in: 'query',
              schema: { ...str, description: 'A workspace’s id, `personal` (your own boards) or `shared` (shared with you).' },
            },
            { name: 'q', in: 'query', schema: { ...str, description: 'Words in the title, the description or a comment.' } },
            {
              name: 'completed',
              in: 'query',
              schema: { enum: ['true', 'false'], description: 'Done (in a done list, or archived as completed) or not.' },
            },
            { name: 'kind', in: 'query', schema: { ...str, description: 'Kinds of list, with commas: `backlog`, `todo`, `doing`, `done`.' } },
            { name: 'assignee', in: 'query', schema: { ...str, description: '`me`, `none` (no one), or a person’s id.' } },
            { name: 'following', in: 'query', schema: { enum: ['true'], description: 'Only the cards you follow.' } },
            { name: 'priority', in: 'query', schema: { ...str, description: 'With commas: `urgent`, `high`, `medium`, `low`, `none`.' } },
            { name: 'label', in: 'query', schema: { ...str, description: 'A label’s name.' } },
            {
              name: 'due',
              in: 'query',
              schema: {
                ...str,
                description:
                  'A test of the due date: `overdue`, `week` (the next 7 days), `none`; a word: `today`, `tomorrow`, `yesterday`, `this-week`, `next-week`, `last-week` (Monday to Sunday), `this-month`, `next-month`, `last-month`, `past`, `future`, `any`; `next-30` or `last-7` (any number of days, today included); or days, both included: `2026-10-01..2026-10-31`, `2026-10-01..`, `..2026-10-31`.',
              },
            },
            {
              name: 'timeZone',
              in: 'query',
              schema: {
                ...str,
                description:
                  'The time zone “today” is in, and the day a date that has a time falls on (for `due` and for a date field’s `fv`): `Asia/Bangkok`. The one on your account when left out, or UTC.',
              },
            },
            {
              name: 'when',
              in: 'query',
              schema: {
                enum: ['any', 'done', 'created', 'changed', 'archived'],
                default: 'any',
                description: 'Which of a card’s dates `from` and `to` are about. Only the latest change of a card is kept.',
              },
            },
            { name: 'from', in: 'query', schema: { ...str, description: 'A moment (ISO): on or after this.' } },
            { name: 'to', in: 'query', schema: { ...str, description: 'A moment (ISO): before this.' } },
            { name: 'parents', in: 'query', schema: { enum: ['hide'], description: 'Only cards without subtasks.' } },
            {
              name: 'field',
              in: 'query',
              schema: {
                ...str,
                description:
                  'One of the boards’ own fields, by id: each card then says what it has for it (`field`: its name and the value in words).',
              },
            },
            {
              name: 'fv',
              in: 'query',
              schema: {
                ...str,
                description:
                  'With `field`: only cards whose value passes, on the boards that use the field. A choice: its options’ ids with commas (`-` for none picked). A checkbox: `yes` or `no`. The rest: `any` (has a value) or `none`. Text also with its test in front: `~word` (contains), `=word` (is exactly), `!~word` (doesn’t contain), `!=word` (isn’t). A date also `past`, `week` (the next 7 days), and everything `due` takes (`today`, `this-month`, `next-30`, `2026-10-01..2026-10-31`). A number also a range: `10..200`, `10..` or `..200`. A card link: links with commas; a person field: people’s ids, or `me`. For a choice, a card link and a person field, a `!` in front means none of them: `!id1,id2`.',
              },
            },
            { name: 'sort', in: 'query', schema: { enum: ['recent', 'created', 'due', 'priority'], default: 'recent' } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          ],
          responses: { 200: json({ type: 'object' }) },
        },
      },
      '/api/boards/{id}/archive': {
        post: {
          tags: ['Boards'],
          summary: 'Archive or restore a board',
          description:
            'Owners only. An archived board is left out of `/api/boards` lists in the app (it has `archivedAt`), and is read-only for everyone until restored. Its cards, comments and files are kept.',
          parameters: [id('id')],
          requestBody: { content: { 'application/json': { schema: obj({ archived: { type: 'boolean' } }) } } },
          responses: ok,
        },
      },
      '/api/boards/{id}/tasks/{taskId}/move': {
        post: {
          tags: ['Boards'],
          summary: 'Move a task to another board',
          description:
            'Moves the task, with its subtasks, comments and files, to another board you can edit. It gets a new id there (in the answer). Lists and labels are matched by name (missing labels are added); people who aren’t on that board are unassigned; “waiting on” links to tasks that stay behind are dropped. Editors and owners of both boards.',
          parameters: [id('id'), id('taskId')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj(
                  {
                    boardId: { ...str, description: 'The board to move it to.' },
                    list: { ...str, description: 'A list there for what isn’t done yet. Default: lists with the same name, else the same kind.' },
                    parentId: { ...nullable(str), description: 'A task there to put it under. Default: the top level.' },
                    order: {
                      ...obj({ ids: { type: 'array', items: str }, at: { type: 'integer' } }),
                      description:
                        'With `list`: its place in that list. `ids` are the list’s cards in the order the board shows them, `at` where it goes among them (0: first). Then the task goes in exactly that list, even a finished one. Default: the end of the list.',
                    },
                  },
                  ['boardId'],
                ),
              },
            },
          },
          responses: {
            200: json(
              obj({
                id: { ...str, description: 'Its id on the other board.' },
                board: obj({ id: str, name: str }),
                summary: obj({
                  title: str,
                  subtasks: { type: 'integer' },
                  unassigned: { type: 'array', items: str, description: 'People who aren’t on that board.' },
                  newLabels: { type: 'array', items: str },
                  droppedLinks: { type: 'integer' },
                }),
              }),
            ),
            422: json(ref('Error'), 'It can’t be moved there (the message says why)'),
          },
        },
      },
      '/api/boards/{id}/activity': {
        get: {
          tags: ['Boards'],
          summary: 'What happened on a board, in a stretch of time',
          description: `Newest first: its changes, in words ("moved “Deploy” to Done"), and comments. Changes are kept for ${ACTIVITY_DAYS} days. For more, ask again with \`until\` set to \`nextUntil\`.`,
          parameters: [
            id('id'),
            { name: 'since', in: 'query', schema: { ...str, description: 'An ISO date or date-time, or back from now: 24h, 3d, 2w. Default: 24h.' } },
            { name: 'until', in: 'query', schema: { ...str, description: 'Up to when (not including it), in the same forms. Default: now.' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: {
            200: json(
              obj({
                activity: {
                  type: 'array',
                  items: obj(
                    {
                      at: { ...str, format: 'date-time' },
                      kind: { enum: ['change', 'comment'] },
                      actor: nullable(obj({ id: str, name: str })),
                      command: str,
                      via: { ...nullable(str), description: 'The app it was made through ("Claude", "API"); null: the website.' },
                      items: { type: 'array', items: obj({ taskId: str, text: str }, ['text']), description: 'Changes: what it did, in words.' },
                      taskId: str,
                      task: nullable(str),
                      body: str,
                      mentions: { type: 'array', items: str },
                    },
                    ['at', 'kind', 'actor'],
                  ),
                },
                nextUntil: nullable({ ...str, format: 'date-time' }),
              }),
            ),
          },
        },
      },
      '/api/boards/{id}/tasks/{taskId}/comments': {
        get: {
          tags: ['Comments'],
          summary: 'A task’s comments',
          parameters: [id('id'), id('taskId')],
          responses: { 200: json(obj({ comments: { type: 'array', items: ref('Comment') } })) },
        },
        post: {
          tags: ['Comments'],
          summary: 'Comment on a task',
          parameters: [id('id'), id('taskId')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj(
                  {
                    body: str,
                    mentions: { type: 'array', items: str, description: 'Ids of people on the board to tell.' },
                    attachments: {
                      type: 'array',
                      items: str,
                      description: 'Ids of files you uploaded for this comment (with `X-Attach-To: comment`) to post with it.',
                    },
                  },
                  ['body'],
                ),
              },
            },
          },
          responses: { 200: json(obj({ comment: ref('Comment') })) },
        },
      },
      '/api/boards/{id}/tasks/{taskId}/attachments': {
        get: {
          tags: ['Files'],
          summary: 'A task’s files',
          description: 'Its own and the ones in its comments (`commentId` says which).',
          parameters: [id('id'), id('taskId')],
          responses: { 200: json(obj({ attachments: { type: 'array', items: ref('Attachment') } })) },
        },
        post: {
          tags: ['Files'],
          summary: 'Upload a file to a task, or for a comment',
          description:
            'The body is the file’s bytes; its size has to be said (`Content-Length`, which `curl --data-binary @file` sends). Editors and owners attach to a task. With `X-Attach-To: comment` the file waits, yours only, for a comment you then post with its id in `attachments` (anyone who can comment). A name the task already has gets a number: use the `name` that comes back.',
          parameters: [
            id('id'),
            id('taskId'),
            {
              name: 'X-File-Name',
              in: 'header',
              required: true,
              schema: { ...str, description: 'The file’s name, percent-encoded if it has anything but plain letters.' },
            },
            { name: 'X-File-Type', in: 'header', schema: { ...str, description: 'Its kind, like `image/png`. Left out: a download.' } },
            { name: 'X-Attach-To', in: 'header', schema: { enum: ['comment'], description: 'For a comment you’re about to post.' } },
          ],
          requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          responses: {
            200: json(obj({ attachment: ref('Attachment') })),
            411: json(ref('Error'), 'The upload didn’t say its size.'),
            413: json(ref('Error'), 'Bigger than the largest file allowed, or no file space left.'),
          },
        },
      },
      '/api/attachments/{attId}': {
        get: {
          tags: ['Files'],
          summary: 'Open or download a file',
          description:
            'For anyone who can view its board. The bytes, or a redirect to a short-lived link when the file is kept in a bucket (follow it: `curl -L`).',
          parameters: [id('attId')],
          responses: { 200: { description: 'The file.' }, 302: { description: 'Where the file is, for five minutes.' } },
        },
      },
      '/api/boards/{id}/attachments/{attId}': {
        delete: {
          tags: ['Files'],
          summary: 'Delete a file',
          description: 'Editors and owners. It goes to a trash for 30 days: `…/restore` brings it back.',
          parameters: [id('id'), id('attId')],
          responses: ok,
        },
      },
      '/api/boards/{id}/attachments/{attId}/restore': {
        post: {
          tags: ['Files'],
          summary: 'Bring a deleted file back',
          parameters: [id('id'), id('attId')],
          responses: { 200: json(obj({ attachment: ref('Attachment') })) },
        },
      },
      '/api/boards/{id}/linked': {
        get: {
          tags: ['Fields'],
          summary: 'What links point at, for you',
          description:
            'For links held by this board’s cards (card link fields): each card’s title, board and list, `gone` for a deleted card, or `hidden` for one on a board you can’t open (which says nothing about whether it exists). A board’s own answer carries the first 2,000 as `linked`; this is for the rest.',
          parameters: [
            id('id'),
            {
              name: 'refs',
              in: 'query',
              required: true,
              schema: { ...str, description: 'Links, with commas (each written for an address). Up to 60.' },
            },
          ],
          responses: { 200: json(obj({ linked: { type: 'object', additionalProperties: { type: 'object' } } })) },
        },
      },
      '/api/boards/{id}/fields/{fieldId}/cards': {
        get: {
          tags: ['Fields'],
          summary: 'Cards a link field can link',
          description:
            'For one of the board’s card link fields: cards by words in their titles (the latest ones, without `q`), from the board the field names, this board, or the boards of its space, as far as you can open them. Up to 30. Each comes with `ref`, the link to store. For editors.',
          parameters: [
            id('id'),
            id('fieldId'),
            { name: 'q', in: 'query', schema: str },
            { name: 'task', in: 'query', schema: { ...str, description: 'The card being edited: it isn’t offered to itself.' } },
          ],
          responses: { 200: json(obj({ cards: { type: 'array', items: { type: 'object' } }, problem: str })) },
        },
      },
      '/api/boards/{id}/tasks/{taskId}/linked-from': {
        get: {
          tags: ['Fields'],
          summary: 'The cards that link to a card',
          description:
            'Grouped by the board and field they link from, each group with what its cards’ numbers add up to. Cards on boards you can’t open are only counted (`hidden`). `subtasks=1`: links to the card or to any card under it.',
          parameters: [id('id'), id('taskId'), { name: 'subtasks', in: 'query', schema: { enum: ['1'] } }],
          responses: { 200: json(obj({ groups: { type: 'array', items: { type: 'object' } }, hidden: { type: 'integer' } })) },
        },
      },
      '/api/boards/{id}/fields': {
        get: {
          tags: ['Fields'],
          summary: 'A board’s fields',
          description: 'The fields it uses, in order. Its owners also get `available`: the fields of its library that could be added.',
          parameters: [id('id')],
          responses: {
            200: json(
              obj({
                fields: { type: 'array', items: ref('Field') },
                available: { type: 'array', items: ref('Field') },
                canPick: { type: 'boolean' },
                canManage: { type: 'boolean', description: 'You may change the library itself.' },
                workspace: nullable(obj({ id: str, name: str })),
              }),
            ),
          },
        },
        put: {
          tags: ['Fields'],
          summary: 'Choose a board’s fields (its owners)',
          description:
            'The whole list, in order: up to 20, up to 3 with `front`, up to 3 with `total` (numbers that add up only). From the board’s library: its workspace’s, or for a Personal board your own. A field left out is taken off the board: its values are kept, unseen, and are back if it’s added again.',
          parameters: [id('id')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj({ fields: { type: 'array', items: obj({ id: str, front: { type: 'boolean' }, total: { type: 'boolean' } }, ['id']) } }, [
                  'fields',
                ]),
              },
            },
          },
          responses: { 200: json(obj({ fields: { type: 'array', items: ref('Field') } })) },
        },
      },
      ...Object.fromEntries(
        (
          [
            ['/api/workspaces/{id}/fields', 'a workspace’s fields (everyone in it reads them; its admins change them)', [id('id')]],
            ['/api/fields', 'your own fields, for your Personal boards', []],
          ] as const
        ).flatMap(([path, whose, params]) => {
          const library = json(
            obj({
              fields: {
                type: 'array',
                items: {
                  allOf: [
                    ref('Field'),
                    obj({
                      archivedAt: nullable({ ...str, format: 'date-time' }),
                      boards: { type: 'integer', description: 'How many boards use it.' },
                    }),
                  ],
                },
              },
              canManage: { type: 'boolean' },
            }),
          )
          const settings = {
            format: { enum: ['plain', 'link', 'email', 'phone'] },
            unit: str,
            decimals: nullable({ type: 'integer' }),
            sum: { type: 'boolean' },
            options: {
              type: 'array',
              description:
                'The whole list, in order. Leave `id` out for a new option. An option left out is deleted for good (cleared from the cards that have it), which is only for archived ones.',
              items: obj({ id: str, name: str, color: str, archived: { type: 'boolean' } }, ['name', 'color']),
            },
          }
          return [
            [
              path,
              {
                get: { tags: ['Fields'], summary: `A library: ${whose}`, parameters: [...params], responses: { 200: library } },
                post: {
                  tags: ['Fields'],
                  summary: 'Add a field',
                  description: 'Up to 50 in a library. A name is used once (whatever the case) and can’t be something every card has, like Due.',
                  parameters: [...params],
                  requestBody: {
                    content: {
                      'application/json': {
                        schema: obj({ name: str, type: { enum: [...FIELD_TYPES] }, ...settings }, ['name', 'type']),
                      },
                    },
                  },
                  responses: { 200: library },
                },
              },
            ],
            [
              `${path}/{fieldId}`,
              {
                patch: {
                  tags: ['Fields'],
                  summary: 'Change, archive or restore a field',
                  description: 'Every board that uses it gets the change. `archived: true` hides it on every board and keeps its values.',
                  parameters: [...params, id('fieldId')],
                  requestBody: { content: { 'application/json': { schema: obj({ name: str, archived: { type: 'boolean' }, ...settings }) } } },
                  responses: { 200: library },
                },
                delete: {
                  tags: ['Fields'],
                  summary: 'Delete an archived field for good',
                  description: 'Its values are removed from every card on every board. This can’t be undone.',
                  parameters: [...params, id('fieldId')],
                  responses: { 200: library },
                },
              },
            ],
            [
              `${path}/{fieldId}/usage`,
              {
                get: {
                  tags: ['Fields'],
                  summary: 'What deleting a field would take away',
                  parameters: [...params, id('fieldId')],
                  responses: { 200: json(obj({ boards: { type: 'integer' }, cards: { type: 'integer' } })) },
                },
              },
            ],
            [
              `${path}/{fieldId}/merge`,
              {
                get: {
                  tags: ['Fields'],
                  summary: 'What merging a field into another would do',
                  description: 'In numbers only. Nothing is changed.',
                  parameters: [
                    ...params,
                    id('fieldId'),
                    { name: 'into', in: 'query', required: true, schema: str, description: 'The field to keep.' },
                  ],
                  responses: {
                    200: json(
                      obj({
                        cards: { type: 'integer', description: 'Cards that hold a value for the field that goes.' },
                        boards: { type: 'integer', description: 'The boards those cards are on.' },
                        both: {
                          type: 'integer',
                          description: 'Of those cards, the ones that also have a value for the kept field: they keep one of the two.',
                        },
                        options: { type: 'array', items: str, description: 'Options the kept field would get (a choice).' },
                        differs: {
                          type: 'array',
                          items: str,
                          description: 'Settings the two fields differ in (unit, decimals, sum, format, many): the kept field’s stand.',
                        },
                        problem: { ...str, description: 'Why it can’t be done, when it can’t.' },
                      }),
                    ),
                  },
                },
                post: {
                  tags: ['Fields'],
                  summary: 'Merge a field into another of the same kind',
                  description:
                    'Every card’s value for this field becomes its value for `into`. A card that has both keeps the one its board shows (the kept field’s, unless the board only shows this one); lists that hold several (cards, people) are joined, and a checkbox is ticked if either was. A choice’s options are matched by name, and the rest are added to `into`. Boards and saved filters that used this field use `into`, and this field is gone. It can’t be undone. Refused for fields of different kinds, an archived field, and two card links whose cards come from different places.',
                  parameters: [...params, id('fieldId')],
                  requestBody: {
                    content: { 'application/json': { schema: obj({ into: { ...str, description: 'The field to keep.' } }, ['into']) } },
                  },
                  responses: { 200: library },
                },
              },
            ],
          ]
        }),
      ),
      '/api/boards/{id}/tasks/{taskId}/follow': {
        get: {
          tags: ['Comments'],
          summary: 'Whether you follow a task (you’re told about its comments and changes)',
          parameters: [id('id'), id('taskId')],
          responses: { 200: json(obj({ following: { type: 'boolean' } })) },
        },
        put: {
          tags: ['Comments'],
          summary: 'Follow a task, or stop',
          parameters: [id('id'), id('taskId')],
          requestBody: { content: { 'application/json': { schema: obj({ following: { type: 'boolean' } }, ['following']) } } },
          responses: { 200: json(obj({ following: { type: 'boolean' } })) },
        },
      },
      '/api/boards/{id}/webhooks': {
        get: {
          tags: ['Webhook settings'],
          summary: 'The board’s webhooks, with their latest deliveries',
          parameters: [id('id')],
          responses: { 200: json({ type: 'object' }) },
        },
        post: {
          tags: ['Webhook settings'],
          summary: 'Add a webhook',
          description:
            'The answer includes its signing secret. With a chat app as the `format`, `url` is a channel’s address in that app: the channel is sent a first message, which has to be taken for the webhook to be saved, and there is no secret. With `telegram`, give the `token` of a bot of the board’s own instead of `url`: the answer has `connect`, the code a chat sends the bot to become the board’s.',
          parameters: [id('id')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj(
                  {
                    url: { ...str, format: 'uri' },
                    token: {
                      ...str,
                      description: 'For `telegram`, in place of `url`: the token @BotFather gave for the bot. Kept encrypted, never returned.',
                    },
                    format: {
                      enum: [...WEBHOOK_FORMATS],
                      description:
                        'How its messages are written. `json` (the default): Kanbanto’s own data, signed. The others: text for a channel in that chat app. It can’t be changed afterwards.',
                    },
                    events: {
                      type: 'array',
                      items: { enum: ['board.changed', 'comment.added', 'reminder.due'] },
                      description: 'What it’s sent. Default: all (including events added later).',
                    },
                  },
                  [],
                ),
              },
            },
          },
          responses: {
            200: json(
              obj(
                {
                  id: str,
                  secret: { ...str, description: 'Only for the `json` format.' },
                  connect: {
                    ...obj({ code: str, privateLink: str, groupLink: str, minutes: { type: 'integer' } }),
                    description: 'Only for `telegram`: send the bot `/start <code>` from the chat that should be the board’s (the links do that).',
                  },
                },
                ['id'],
              ),
            ),
          },
        },
      },
      '/api/boards/{id}/webhooks/{hookId}': {
        patch: {
          tags: ['Webhook settings'],
          summary: 'Pause, resume or change the address',
          parameters: [id('id'), id('hookId')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj(
                  {
                    active: { type: 'boolean' },
                    url: str,
                    events: { type: 'array', items: { enum: ['board.changed', 'comment.added', 'reminder.due'] } },
                  },
                  [],
                ),
              },
            },
          },
          responses: ok,
        },
        delete: { tags: ['Webhook settings'], summary: 'Delete a webhook', parameters: [id('id'), id('hookId')], responses: ok },
      },
      '/api/boards/{id}/webhooks/{hookId}/telegram': {
        patch: {
          tags: ['Webhook settings'],
          summary: 'A Telegram bot: whether messages in its chat become cards, in which list; or a new token for the same bot',
          parameters: [id('id'), id('hookId')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj(
                  {
                    takesCards: { type: 'boolean' },
                    cardsTo: nullable({ ...str, description: 'A list’s id; null: the first list of not-started work.' }),
                    token: str,
                  },
                  [],
                ),
              },
            },
          },
          responses: ok,
        },
      },
      '/api/boards/{id}/webhooks/{hookId}/telegram/code': {
        post: {
          tags: ['Webhook settings'],
          summary: 'A Telegram bot: a new code, for another chat to become the board’s',
          parameters: [id('id'), id('hookId')],
          responses: { 200: json(obj({ connect: obj({ code: str, privateLink: str, groupLink: str, minutes: { type: 'integer' } }) })) },
        },
      },
      '/api/boards/{id}/webhooks/{hookId}/test': {
        post: {
          tags: ['Webhook settings'],
          summary: 'Send a test delivery (ping) now',
          parameters: [id('id'), id('hookId')],
          responses: { 200: json(obj({ ok: { type: 'boolean' }, status: nullable({ type: 'integer' }), error: nullable(str) })) },
        },
      },
      '/api/boards/{id}/webhooks/{hookId}/secret': {
        get: {
          tags: ['Webhook settings'],
          summary: 'Show the signing secret (a webhook that sends to a chat app has none: 400)',
          parameters: [id('id'), id('hookId')],
          responses: { 200: json(obj({ secret: str })) },
        },
        post: {
          tags: ['Webhook settings'],
          summary: 'Replace the signing secret',
          parameters: [id('id'), id('hookId')],
          responses: { 200: json(obj({ secret: str })) },
        },
      },
      '/api/workspaces': { get: { tags: ['Workspaces'], summary: 'Workspaces you’re in', responses: { 200: json({ type: 'object' }) } } },
      '/api/workspaces/{id}': {
        get: { tags: ['Workspaces'], summary: 'A workspace and its people', parameters: [id('id')], responses: { 200: json({ type: 'object' }) } },
      },
      '/api/boards/{id}/tasks/{taskId}/time': {
        get: {
          tags: ['Time'],
          summary: 'The time logged on a card',
          parameters: [id('id'), id('taskId')],
          responses: { 200: json(obj({ entries: { type: 'array', items: ref('TimeEntry') }, canLog: { type: 'boolean' } })) },
        },
        post: {
          tags: ['Time'],
          summary: 'Log time on a card',
          parameters: [id('id'), id('taskId')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj(
                  {
                    minutes: { type: 'integer', minimum: 1, maximum: 1440 },
                    day: { ...str, description: 'The day it counts for, YYYY-MM-DD.' },
                    note: { ...str, maxLength: 200 },
                  },
                  ['minutes', 'day'],
                ),
              },
            },
          },
          responses: { 200: json(obj({ entry: ref('TimeEntry') })) },
        },
      },
      '/api/boards/{id}/time/{entryId}': {
        patch: {
          tags: ['Time'],
          summary: 'Change an entry’s time, day or note',
          parameters: [id('id'), id('entryId')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj({ minutes: { type: 'integer', minimum: 1, maximum: 1440 }, day: str, note: { ...str, maxLength: 200 } }, []),
              },
            },
          },
          responses: { 200: json(obj({ entry: ref('TimeEntry') })) },
        },
        delete: { tags: ['Time'], summary: 'Delete an entry', parameters: [id('id'), id('entryId')], responses: ok },
      },
      '/api/boards/{id}/time/mine': {
        get: {
          tags: ['Time'],
          summary: 'For logging on a board: the cards you worked on that day and logged on lately, and your day so far',
          parameters: [
            id('id'),
            id('day', 'query'),
            { name: 'timeZone', in: 'query', schema: { ...str, description: 'Yours, e.g. Asia/Bangkok. Default UTC.' } },
          ],
          responses: {
            200: json(
              obj({
                day: str,
                touched: { type: 'array', items: str, description: 'Card ids, latest first.' },
                recent: { type: 'array', items: str },
                logged: { type: 'integer', description: 'Minutes you logged that day, on all your boards.' },
                hoursPerDay: { type: 'number' },
              }),
            ),
          },
        },
      },
      '/api/time/week': {
        get: {
          tags: ['Time'],
          summary: 'Your week across boards (My week)',
          parameters: [
            { name: 'from', in: 'query', required: true, schema: { ...str, description: 'The Monday it starts on, YYYY-MM-DD.' } },
            { name: 'timeZone', in: 'query', schema: { ...str, description: 'Yours, e.g. Asia/Bangkok. Default UTC.' } },
          ],
          responses: {
            200: json(
              obj({
                from: str,
                hoursPerDay: { type: 'number' },
                entries: { type: 'array', items: ref('TimeEntry') },
                cards: { type: 'array', items: { type: 'object' }, description: 'The rows: cards you logged on, worked on, or are assigned to.' },
                touched: {
                  type: 'object',
                  additionalProperties: { type: 'array', items: str },
                  description: 'Days you worked on each card, by `boardId:taskId`.',
                },
              }),
            ),
          },
        },
      },
      '/api/workspaces/{id}/planning': {
        get: {
          tags: ['Planning'],
          summary: 'A workspace’s plan',
          description:
            'The plan (roles, people, projects, lines, blocks), its change counter (`seq`), whether you can change it, and the minutes logged on linked boards (`actuals`, by board then by person).',
          parameters: [id('id')],
          responses: { 200: json({ type: 'object' }) },
        },
      },
      '/api/workspaces/{id}/planning/mutations': {
        post: {
          tags: ['Planning'],
          summary: 'Change the plan (admins and planners)',
          description: 'One plan command; refused (409) with a reason if it breaks a rule, like two blocks overlapping on one person’s line.',
          parameters: [id('id')],
          requestBody: {
            content: {
              'application/json': {
                schema: obj({
                  mutationId: { ...str, description: 'Your id for this change: sending it again does it once.' },
                  command: ref('PlanCommand'),
                }),
              },
            },
          },
          responses: { 200: json(obj({ seq: { type: 'integer' }, changes: { type: 'array', items: { type: 'object' } } })) },
        },
      },
      '/api/boards/{id}/plan': {
        get: {
          tags: ['Planning'],
          summary: 'The plan of the project linked to a board',
          description:
            'Who is booked on it, at what share and until when; `plan` is null when the board isn’t linked or you aren’t in its workspace.',
          parameters: [id('id')],
          responses: { 200: json(obj({ plan: nullable({ type: 'object' }) })) },
        },
      },
    },
    webhooks: {
      'board.changed': event('board.changed', {
        actor: nullable(obj({ id: str, name: str })),
        command: { ...str, description: 'The command’s type, e.g. task.move.' },
        seq: { type: 'integer' },
        changes: { type: 'array', items: ref('Change'), description: 'Up to 200; `truncated` is true when there were more.' },
      }),
      'reminder.due': event('reminder.due', {
        task: obj({ id: str, title: str, due: nullable(str), list: nullable(str) }),
        reminder: obj({ id: str, at: { ...str, format: 'date-time' } }),
        for: obj({ id: str, name: str }),
      }),
      'comment.added': event('comment.added', {
        actor: obj({ id: str, name: str }),
        task: obj({ id: str, title: str }),
        comment: obj({
          id: str,
          body: str,
          mentions: { type: 'array', items: str },
          files: { type: 'array', items: obj({ id: str, name: str, size: { type: 'integer' } }), description: 'The files posted with it.' },
        }),
      }),
      ping: event('ping', {}),
    },
  }
}

export const openApiRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/openapi.json', async (req) => spec(siteUrl(req)))
  await app.register(scalar, {
    routePrefix: '/api/docs',
    configuration: {
      url: '/api/openapi.json',
      title: 'Kanbanto API',
      hideClientButton: true,
      // Just the reference: no Scalar toolbar, AI chat or MCP generator (those talk to Scalar's services), no telemetry,
      // and a token typed into "Try it" isn't kept in the browser.
      showDeveloperTools: 'never',
      agent: { disabled: true },
      mcp: { disabled: true },
      telemetry: false,
      persistAuth: false,
      // The system's fonts, not Scalar's: the page reaches no other site (it works on a network without internet).
      withDefaultFonts: false,
    },
  })
}
