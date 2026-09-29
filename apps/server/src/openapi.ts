import scalar from '@scalar/fastify-api-reference'
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
      createdAt: { ...str, format: 'date-time' },
      updatedAt: { ...str, format: 'date-time' },
      version: { type: 'integer' },
    },
    ['id', 'title', 'parentId', 'status', 'order', 'labels', 'blockedBy'],
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
    createdAt: str,
  }),
  Error: obj({ error: str }),
}

const webhookHeaders = `Each delivery is a POST with a JSON body and these headers:

- \`X-Kanbanto-Event\`: the event (\`board.changed\`, \`comment.added\`, \`ping\`)
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
        name: 'Webhook settings',
        description: 'A board’s webhooks, for its owners (when a platform admin allows webhooks). What they send is under Webhooks.',
      },
      { name: 'Workspaces' },
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
                    template: { enum: ['empty', 'example'] },
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
          parameters: [id('id')],
          responses: {
            200: json(
              obj({ data: ref('BoardData'), seq: { type: 'integer', description: 'Goes up by one with every change.' }, access: { type: 'object' } }),
            ),
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
                schema: obj({ body: str, mentions: { type: 'array', items: str, description: 'Ids of people on the board to tell.' } }, ['body']),
              },
            },
          },
          responses: { 200: json(obj({ comment: ref('Comment') })) },
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
          description: 'The answer includes its signing secret.',
          parameters: [id('id')],
          requestBody: { content: { 'application/json': { schema: obj({ url: { ...str, format: 'uri' } }) } } },
          responses: { 200: json(obj({ id: str, secret: str })) },
        },
      },
      '/api/boards/{id}/webhooks/{hookId}': {
        patch: {
          tags: ['Webhook settings'],
          summary: 'Pause, resume or change the address',
          parameters: [id('id'), id('hookId')],
          requestBody: { content: { 'application/json': { schema: obj({ active: { type: 'boolean' }, url: str }, []) } } },
          responses: ok,
        },
        delete: { tags: ['Webhook settings'], summary: 'Delete a webhook', parameters: [id('id'), id('hookId')], responses: ok },
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
          summary: 'Show the signing secret',
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
    },
    webhooks: {
      'board.changed': event('board.changed', {
        actor: nullable(obj({ id: str, name: str })),
        command: { ...str, description: 'The command’s type, e.g. task.move.' },
        seq: { type: 'integer' },
        changes: { type: 'array', items: ref('Change'), description: 'Up to 200; `truncated` is true when there were more.' },
      }),
      'comment.added': event('comment.added', {
        actor: obj({ id: str, name: str }),
        task: obj({ id: str, title: str }),
        comment: obj({ id: str, body: str, mentions: { type: 'array', items: str } }),
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
