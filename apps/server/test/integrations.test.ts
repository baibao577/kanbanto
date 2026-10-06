import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boardActivity, comments, tasks, webhookDeliveries } from '../src/db/schema'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** Ann (a platform admin) with her first board; the site's integration switches as given. */
async function site(settings: { apiTokens?: boolean; webhooks?: 'off' | 'public' | 'any' } = {}) {
  const ann = await Person.signUp(t.app, 'Ann')
  await setPlatformAdmin(t.db, 'ann@example.com', true)
  if (Object.keys(settings).length) await ann.ok('PATCH', '/api/admin/settings', settings)
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  return { ann, id }
}

/** Requests with an API token instead of a session. */
const withToken = (token: string) => {
  const p = new Person(t.app)
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) =>
    p.request(method, url, body, { authorization: `Bearer ${token}`, ...headers })
  return call
}
/** Webhooks are queued in the background after a change is saved: give that a moment, then send what's due. */
const deliver = async () => {
  await new Promise((r) => setTimeout(r, 100))
  return t.app.webhooks.process()
}
const makeToken = async (p: Person, scope: 'read' | 'write') =>
  (await p.ok('POST', '/api/account/tokens', { name: 'script', scope, expiresInDays: null })).token as string

describe('API tokens', () => {
  it('are off until a platform admin turns them on', async () => {
    const { ann } = await site()
    expect((await ann.ok('GET', '/api/account/tokens')).enabled).toBe(false)
    expect((await ann.request('POST', '/api/account/tokens', { name: 'x', scope: 'read', expiresInDays: null })).status).toBe(403)
    const bob = await Person.signUp(t.app, 'Bob')
    expect((await bob.request('PATCH', '/api/admin/settings', { apiTokens: true })).status).toBe(403)
  })

  it('act as their person, only on the API’s board routes; read tokens only read', async () => {
    const { ann, id } = await site({ apiTokens: true })
    const token = await makeToken(ann, 'write')
    expect(token).toMatch(/^kbt_/)
    const listed = (await ann.ok('GET', '/api/account/tokens')).tokens
    expect(listed).toEqual([expect.objectContaining({ name: 'script', scope: 'write', hint: `${token.slice(0, 6)}…${token.slice(-4)}` })])
    expect(JSON.stringify(listed)).not.toContain(token)

    const api = withToken(token)
    expect((await api('GET', '/api/auth/me')).body.user.email).toBe('ann@example.com')
    expect((await api('GET', '/api/boards')).body.boards).toHaveLength(1)
    const changed = await api('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A', fields: { title: 'Via API' } },
    })
    expect(changed.status).toBe(200)
    // Never the account, its tokens, or the Platform console.
    expect((await api('GET', '/api/account/tokens')).status).toBe(403)
    expect((await api('POST', '/api/account/tokens', { name: 'more', scope: 'write', expiresInDays: null })).status).toBe(403)
    expect((await api('PATCH', '/api/admin/settings', { openSignup: false })).status).toBe(403)
    expect((await api('POST', '/api/auth/password', { current: 'x', next: 'y' })).status).toBe(403)

    const read = withToken(await makeToken(ann, 'read'))
    expect((await read('GET', `/api/boards/${id}`)).status).toBe(200)
    expect((await read('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.delete', id: 'A' } })).status).toBe(403)
  })

  it('stop working when deleted, or when tokens are turned off', async () => {
    const { ann } = await site({ apiTokens: true })
    const token = await makeToken(ann, 'read')
    const api = withToken(token)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: false })
    expect((await api('GET', '/api/boards')).status).toBe(401)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    expect((await api('GET', '/api/boards')).status).toBe(200)
    const [{ id: tokenId }] = (await ann.ok('GET', '/api/account/tokens')).tokens
    await ann.ok('DELETE', `/api/account/tokens/${tokenId}`)
    expect((await api('GET', '/api/boards')).status).toBe(401)
    expect((await withToken('kbt_nope')('GET', '/api/boards')).status).toBe(401)
  })
})

/** A local address that records what it receives and answers with `status`. */
async function receiver(status = 200) {
  const got: { headers: Record<string, string | string[] | undefined>; body: string }[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      got.push({ headers: req.headers, body })
      res.statusCode = status
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`
  return { url, got, close: () => new Promise((r) => server.close(r)) }
}

describe('webhooks', () => {
  it('are off until allowed; public-only refuses this machine’s addresses', async () => {
    const { ann, id } = await site()
    expect((await ann.request('POST', `/api/boards/${id}/webhooks`, { url: 'https://example.com/hook' })).status).toBe(403)
    await ann.ok('PATCH', '/api/admin/settings', { webhooks: 'public' })
    expect((await ann.request('POST', `/api/boards/${id}/webhooks`, { url: 'http://example.com/hook' })).status).toBe(400)
    expect((await ann.request('POST', `/api/boards/${id}/webhooks`, { url: 'https://127.0.0.1/hook' })).status).toBe(400)
    expect((await ann.request('POST', `/api/boards/${id}/webhooks`, { url: 'https://localhost/hook' })).status).toBe(400)
    // A public address has to say it wants them: it's sent a code, and must answer with it.
    const asked: string[] = []
    t.app.webhooks.ask = async (url) => {
      asked.push(url)
      return { status: 200, text: 'ok' }
    }
    const refused = await ann.request('POST', `/api/boards/${id}/webhooks`, { url: 'https://example.com/hook' })
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringMatching(/didn’t confirm/) } })
    t.app.webhooks.ask = async (_url, body) => ({ status: 200, text: JSON.stringify({ challenge: JSON.parse(body).challenge }) })
    expect((await ann.request('POST', `/api/boards/${id}/webhooks`, { url: 'https://example.com/hook' })).status).toBe(200)
    expect(asked).toEqual(['https://example.com/hook'])
  })

  it('send each change, signed with the secret; only owners manage them', async () => {
    const { ann, id } = await site({ webhooks: 'any' })
    const r = await receiver()
    try {
      const { secret } = await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: r.url })
      expect(secret).toMatch(/^whsec_/)
      await ann.ok('POST', `/api/boards/${id}/mutations`, {
        mutationId: mid(),
        command: { type: 'task.update', id: 'A', fields: { title: 'Launch!' } },
      })
      await ann.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'Looks good' })
      expect(await deliver()).toBe(2)

      const [change, comment] = r.got
      expect(change.headers['x-kanbanto-event']).toBe('board.changed')
      const [, time, sig] = String(change.headers['x-kanbanto-signature']).match(/^t=(\d+),v1=([0-9a-f]+)$/)!
      expect(createHmac('sha256', secret).update(`${time}.${change.body}`).digest('hex')).toBe(sig)
      const payload = JSON.parse(change.body)
      expect(payload).toMatchObject({ event: 'board.changed', board: { id }, actor: { name: 'Ann' }, command: 'task.update' })
      expect(payload.changes[0]).toMatchObject({ entity: 'task', id: 'A', after: { title: 'Launch!' } })
      expect(JSON.parse(comment.body)).toMatchObject({ event: 'comment.added', task: { id: 'A' }, comment: { body: 'Looks good' } })

      const { webhooks } = await ann.ok('GET', `/api/boards/${id}/webhooks`)
      expect(webhooks[0]).toMatchObject({ url: r.url, lastStatus: 200, lastError: null })
      expect(webhooks[0].recent.map((d: { status: string }) => d.status)).toEqual(['sent', 'sent'])

      const bob = await Person.signUp(t.app, 'Bob')
      await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
      expect((await bob.request('GET', `/api/boards/${id}/webhooks`)).status).toBe(403)
    } finally {
      await r.close()
    }
  })

  it('retry when the address fails, and can be tested and paused', async () => {
    const { ann, id } = await site({ webhooks: 'any' })
    const r = await receiver(500)
    try {
      const { id: hookId } = await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: r.url })
      expect(await ann.ok('POST', `/api/boards/${id}/webhooks/${hookId}/test`)).toEqual({
        ok: false,
        status: 500,
        error: 'The address answered 500.',
      })
      await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.update', id: 'A', fields: { title: 'x' } } })
      await deliver()
      const [hook] = (await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks
      expect(hook.recent[0]).toMatchObject({ event: 'board.changed', status: 'pending', attempts: 1, responseStatus: 500 })
      // Paused: nothing more is queued.
      await ann.ok('PATCH', `/api/boards/${id}/webhooks/${hookId}`, { active: false })
      const before = r.got.length
      await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.update', id: 'A', fields: { title: 'y' } } })
      await deliver()
      expect(r.got.length).toBe(before)
    } finally {
      await r.close()
    }
  })
})

describe('MCP', () => {
  const rpc = (call: ReturnType<typeof withToken>, method: string, params: object = {}) =>
    call(
      'POST',
      '/api/mcp',
      { jsonrpc: '2.0', id: 1, method, params },
      { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    )
  const toolResult = (r: { body: { result: { content: { text: string }[]; isError?: boolean } } }) => ({
    ...JSON.parse(r.body.result.content[0].text),
    isError: !!r.body.result.isError,
  })

  it('needs an API token', async () => {
    await site({ apiTokens: true })
    const r = await new Person(t.app).request('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r.status).toBe(401)
    expect(r.headers['www-authenticate']).toBe('Bearer')
  })

  it('lets an assistant find, create and change tasks as the token’s person', async () => {
    const { ann, id } = await site({ apiTokens: true })
    const mcp = withToken(await makeToken(ann, 'write'))
    const init = await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.body.result.serverInfo.name).toBe('kanbanto')
    const tools = (await rpc(mcp, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name)
    expect(tools).toEqual([
      'list_boards',
      'get_board',
      'find_tasks',
      'team_overview',
      'recent_activity',
      'reminders',
      'my_day',
      'get_task',
      'read_file',
      'my_week',
      'plan_overview',
      'create_tasks',
      'update_task',
      'move_task',
      'set_reminder',
      'archive_task',
      'archive_done_tasks',
      'move_to_board',
      'create_board',
      'update_board',
      'manage_lists',
      'manage_labels',
      'manage_fields',
      'log_time',
      'follow_task',
      'attach_file',
      'upload_link',
      'add_comment',
    ])
    // Following: Logo isn't Ann's until she follows it; then it's among what she follows, until she stops.
    const tool = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))
    const logo = (await tool('find_tasks', { text: 'logo' })).tasks[0].id
    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: logo, fields: { assigneeId: null } },
    })
    expect((await tool('get_task', { board_id: id, task_id: logo })).you_follow_it).toBe(false)
    expect(await tool('follow_task', { board_id: id, task_id: logo })).toMatchObject({ task: 'Logo', you_follow_it: true })
    expect((await tool('get_task', { board_id: id, task_id: logo })).you_follow_it).toBe(true)
    expect((await tool('find_tasks', { following: true, text: 'logo' })).tasks.map((x: { title: string }) => x.title)).toEqual(['Logo'])
    await tool('follow_task', { board_id: id, task_id: logo, follow: false })
    expect((await tool('find_tasks', { following: true, text: 'logo' })).tasks).toEqual([])
    // The board's own fields: listed with the board, read and set by name (a choice by its option's name).
    const { id: stage } = await ann.ok('POST', '/api/fields', {
      name: 'Stage',
      type: 'choice',
      options: [
        { name: 'Lead', color: 'gray' },
        { name: 'Won', color: 'green' },
      ],
    })
    const { id: value } = await ann.ok('POST', '/api/fields', { name: 'Value', type: 'number', unit: '฿' })
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: stage }, { id: value }] })
    expect((await tool('get_board', { board_id: id, tasks: false })).fields).toEqual([
      { id: stage, name: 'Stage', type: 'choice', options: ['Lead', 'Won'] },
      { id: value, name: 'Value', type: 'number', unit: '฿' },
    ])
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { stage: 'won', Value: '12,000' } })).fields).toEqual({
      Stage: 'Won',
      Value: 12000,
    })
    expect((await tool('get_task', { board_id: id, task_id: logo })).fields).toEqual({ Stage: 'Won', Value: 12000 })
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Value: null } })).fields).toEqual({ Stage: 'Won' })
    // A wrong name or value changes nothing, and says what there is.
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Stage: 'Lost' } })).error).toMatch(
      /no option “Lost”. The options are: Lead, Won/,
    )
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Budget: 1 } })).error).toMatch(
      /no field “Budget”. The fields are: Stage, Value/,
    )
    const refused = await tool('create_tasks', { board_id: id, tasks: [{ title: 'Fine' }, { title: 'Not fine', fields: { Value: 'lots' } }] })
    expect(refused.error).toMatch(/Value: That isn’t a number/)
    expect((await tool('find_tasks', { board_id: id, text: 'fine' })).tasks).toEqual([])
    const deal = await tool('create_tasks', { board_id: id, tasks: [{ title: 'New deal', fields: { Stage: 'Lead' } }] })
    expect((await tool('get_task', { board_id: id, task_id: deal.created[0].id })).fields).toEqual({ Stage: 'Lead' })

    // Finding tasks by a field, by name: on the boards that have it, the others are skipped.
    const titles = (r: { tasks: { title: string }[] }) => r.tasks.map((x) => x.title).sort()
    expect(titles(await tool('find_tasks', { fields: { stage: 'WON' } }))).toEqual(['Logo'])
    expect(titles(await tool('find_tasks', { board_id: id, fields: { Stage: 'Lead' } }))).toEqual(['New deal'])
    await tool('update_task', { board_id: id, task_id: logo, fields: { Value: 12000 } })
    expect(titles(await tool('find_tasks', { fields: { Stage: 'Won', Value: '12,000' } }))).toEqual(['Logo'])
    expect((await tool('find_tasks', { fields: { Stage: 'Won', Value: 5 } })).tasks).toEqual([])
    // null: nothing for the field. Only this board is looked at, since only it has the field.
    const other = await ann.ok('POST', '/api/boards', { name: 'No fields here' })
    await ann.ok('POST', `/api/boards/${other.id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.create', id: 'n1', parentId: null, fields: { title: 'Elsewhere' } },
    })
    const empty = await tool('find_tasks', { fields: { Stage: null } })
    expect(empty.tasks.length).toBeGreaterThan(0)
    expect(empty.tasks.every((x: { board_id: string; fields?: object }) => x.board_id === id && !(x.fields && 'Stage' in x.fields))).toBe(true)
    // An archived task keeps its fields, and is found by them.
    await tool('archive_task', { board_id: id, task_id: deal.created[0].id })
    const put = await tool('find_tasks', { fields: { Stage: 'Lead' }, include_archived: true })
    expect(put.tasks).toMatchObject([{ title: 'New deal', fields: { Stage: 'Lead' } }])
    expect(put.tasks[0].archived).toBeTruthy()
    // A value that can't be read, and a field no board has, say what there is.
    expect((await tool('find_tasks', { fields: { Stage: 'Lost' } })).error).toMatch(/no option “Lost” for Stage. The options are: Lead, Won/)
    expect((await tool('find_tasks', { fields: { Budget: 1 } })).error).toMatch(
      /None of these boards has a field “Budget”. The fields there are: Stage, Value/,
    )
    expect((await tool('find_tasks', { board_id: other.id, fields: { Stage: 'Won' } })).error).toMatch(
      /This board has no field “Stage”. There are no fields there/,
    )
    // More than an exact value: criteria, read the way the Filter menu reads a filter.
    expect(titles(await tool('find_tasks', { board_id: id, fields: { Value: { min: 10000 } } }))).toEqual(['Logo'])
    expect((await tool('find_tasks', { board_id: id, fields: { Value: { max: 5 } } })).tasks).toEqual([])
    expect(titles(await tool('find_tasks', { board_id: id, fields: { Stage: { none_of: ['lead'] }, Value: { empty: false } } }))).toEqual(['Logo'])
    expect(titles(await tool('find_tasks', { board_id: id, fields: { Stage: { any_of: ['Won', 'Lead'] } } }))).toEqual(['Logo'])
    // What a field's kind can't be asked, and a name that isn't there, are refused with what can be said.
    expect((await tool('find_tasks', { board_id: id, fields: { Stage: { min: 3 } } })).error).toMatch(/Stage is a .*“any_of”.*not “min”/)
    expect((await tool('find_tasks', { board_id: id, fields: { Stage: { any_of: ['Lost'] } } })).error).toMatch(/no option “Lost” for Stage/)
    // A part that's misspelt is refused too: left out, it would answer a wider question than the one asked.
    const misspelt = await rpc(mcp, 'tools/call', { name: 'find_tasks', arguments: { board_id: id, fields: { Value: { minimum: 10 } } } })
    expect(JSON.stringify(misspelt.body)).toMatch(/minimum|[Uu]nrecognized/)
    expect(JSON.stringify(misspelt.body)).not.toMatch(/"Logo"/)

    // Links to other cards: listed with the board, read as the cards' titles, set and found by title.
    const firms = await ann.ok('POST', '/api/boards', { name: 'Companies' })
    const firm = (cardId: string, title: string) =>
      ann.ok('POST', `/api/boards/${firms.id}/mutations`, {
        mutationId: mid(),
        command: { type: 'task.create', id: cardId, parentId: null, fields: { title } },
      })
    await firm('c1', 'Acme')
    await firm('c2', 'Globex')
    await firm('c3', 'Globex')
    const { id: companyField } = await ann.ok('POST', '/api/fields', { name: 'Client', type: 'link', linkTo: 'board', board: firms.id })
    const { id: alsoField } = await ann.ok('POST', '/api/fields', { name: 'See also', type: 'link', linkTo: 'same', many: true })
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: stage }, { id: value }, { id: companyField }, { id: alsoField }] })
    expect((await tool('get_board', { board_id: id, tasks: false })).fields.slice(2)).toEqual([
      { id: companyField, name: 'Client', type: 'link', cards_from: { board_id: firms.id }, several: false },
      { id: alsoField, name: 'See also', type: 'link', cards_from: 'this board', several: true },
    ])
    const linkedTo = await tool('update_task', { board_id: id, task_id: logo, fields: { client: 'acme', 'See also': ['Homepage', 'Deploy'] } })
    expect(linkedTo.fields.Client).toEqual([{ title: 'Acme', board: 'Companies', board_id: firms.id, task_id: 'c1' }])
    expect(linkedTo.fields['See also'].map((c: { title: string }) => c.title)).toEqual(['Homepage', 'Deploy'])
    expect((await tool('get_task', { board_id: id, task_id: logo })).fields.Client[0].title).toBe('Acme')
    expect(titles(await tool('find_tasks', { fields: { Client: 'ACME' } }))).toEqual(['Logo'])
    expect(titles(await tool('find_tasks', { board_id: id, fields: { 'See also': 'Deploy' } }))).toEqual(['Logo'])
    expect((await tool('find_tasks', { board_id: id, fields: { Client: 'Nobody' } })).error).toMatch(/Client: there’s no card called “Nobody”/)
    // A title two cards share has to be said by its link; one that isn't there names what's close.
    const twice = await tool('update_task', { board_id: id, task_id: logo, fields: { Client: 'Globex' } })
    expect(twice.error).toMatch(
      new RegExp(`Client: more than one card is called “Globex”. Say which by its link: ${firms.id}:c2 \\(on Companies\\); ${firms.id}:c3`),
    )
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Client: `${firms.id}:c3` } })).fields.Client[0]).toMatchObject({
      task_id: 'c3',
    })
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Client: 'Glob' } })).error).toMatch(
      /there’s no card called “Glob” to link \(close: “Globex”, “Globex”\)/,
    )
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { 'See also': 'Logo' } })).error).toMatch(/no card called “Logo”/)
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Client: null } })).fields.Client).toBeUndefined()
    // People: listed with the board, read as names, set and found by name or "me".
    await Person.signUp(t.app, 'Bobby')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bobby@example.com', role: 'editor' })
    const { id: reviewer } = await ann.ok('POST', '/api/fields', { name: 'Reviewer', type: 'person' })
    const { id: crew } = await ann.ok('POST', '/api/fields', { name: 'Crew', type: 'person', many: true })
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: stage }, { id: value }, { id: reviewer }, { id: crew }] })
    expect((await tool('get_board', { board_id: id, tasks: false })).fields.slice(2)).toEqual([
      { id: reviewer, name: 'Reviewer', type: 'person', several: false },
      { id: crew, name: 'Crew', type: 'person', several: true },
    ])
    const staffed = await tool('update_task', { board_id: id, task_id: logo, fields: { reviewer: 'bobby', Crew: ['me', 'Bobby'] } })
    expect(staffed.fields).toMatchObject({ Reviewer: 'Bobby', Crew: ['Ann', 'Bobby'] })
    expect(JSON.stringify(staffed)).not.toContain(ann.user.id)
    expect(titles(await tool('find_tasks', { board_id: id, fields: { Reviewer: 'Bobby' } }))).toEqual(['Logo'])
    expect(titles(await tool('find_tasks', { board_id: id, fields: { Crew: 'me' } }))).toEqual(['Logo'])
    expect((await tool('find_tasks', { board_id: id, fields: { Reviewer: 'Zed' } })).error).toMatch(/Reviewer: no one called “Zed” is on that board/)
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Reviewer: 'Zed' } })).error).toMatch(/Zed/)
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Reviewer: ['me', 'Bobby'] } })).error).toMatch(
      /Reviewer holds one person/,
    )
    expect((await tool('update_task', { board_id: id, task_id: logo, fields: { Reviewer: null, Crew: 'me' } })).fields).toMatchObject({
      Crew: ['Ann'],
    })
    // (Back to the fields the rest of this test expects.)
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: stage }, { id: value }] })
    await ann.ok('DELETE', `/api/boards/${firms.id}`)

    const found = toolResult(await rpc(mcp, 'tools/call', { name: 'find_tasks', arguments: { text: 'logo' } }))
    expect(found.tasks.map((x: { title: string }) => x.title)).toEqual(['Logo'])
    const made = toolResult(
      await rpc(mcp, 'tools/call', {
        name: 'create_tasks',
        arguments: {
          board_id: id,
          parent_id: 'A3',
          tasks: [{ title: 'Staging deploy', assignee: 'me', list: 'doing' }, { title: 'Production deploy' }],
        },
      }),
    )
    expect(made.created.map((x: { title: string }) => x.title)).toEqual(['Staging deploy', 'Production deploy'])
    const board = (await ann.ok('GET', `/api/boards/${id}`)).data
    const staging = board.tasks[made.created[0].id]
    expect(staging).toMatchObject({ parentId: 'A3', assigneeId: ann.user.id, status: 'doing' })

    const bad = toolResult(await rpc(mcp, 'tools/call', { name: 'update_task', arguments: { board_id: id, task_id: 'A3', list: 'Nowhere' } }))
    expect(bad.isError).toBe(true)
    expect(bad.error).toContain('There’s no list “Nowhere”')

    toolResult(await rpc(mcp, 'tools/call', { name: 'add_comment', arguments: { board_id: id, task_id: 'A3', text: 'Split into two steps' } }))
    const task = toolResult(await rpc(mcp, 'tools/call', { name: 'get_task', arguments: { board_id: id, task_id: 'A3' } }))
    expect(task.subtasks).toHaveLength(2)
    expect(task.comments.at(-1)).toMatchObject({ author: 'Ann', text: 'Split into two steps' })
  })

  it('boards say where they live; the workspace filter; what’s new, and who did it', async () => {
    const { ann, id: personal } = await site({ apiTokens: true })
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const { id: work } = await ann.ok('POST', '/api/boards', { name: 'Launch', template: 'example', workspaceId: ws })
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))

    const { boards } = await call('list_boards', {})
    expect(boards.map((b: { name: string; workspace: string }) => [b.name, b.workspace])).toEqual([
      ['Launch', 'Acme'],
      ['My first board', 'Personal'],
    ])
    const inAcme = await call('find_tasks', { workspace: 'acme', text: 'deploy' })
    expect(inAcme.tasks.map((x: { board_id: string; workspace: string }) => [x.board_id, x.workspace])).toEqual([[work, 'Acme']])
    const nowhere = await call('find_tasks', { workspace: 'Home' })
    expect(nowhere.error).toContain('The places are: Acme, Personal')
    // Searching everywhere by list: a board without that list just has nothing to show.
    await ann.ok('POST', `/api/boards/${personal}/mutations`, {
      mutationId: mid(),
      command: { type: 'column.update', id: 'doing', fields: { name: 'In progress' } },
    })
    const doing = await call('find_tasks', { list: 'Doing' })
    expect(doing.isError).toBe(false)
    expect(new Set(doing.tasks.map((x: { board_id: string }) => x.board_id))).toEqual(new Set([work]))

    // What's new: changes (with who) and comments (marked when they mention you).
    await ann.ok('POST', `/api/boards/${work}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A3', fields: { status: 'done' } },
    })
    await bob.ok('POST', `/api/boards/${work}/tasks/A3/comments`, { body: '@Ann shipped!', mentions: [ann.user.id] })
    const news = await call('recent_activity', { workspace: 'Acme' })
    expect(news.activity.map((e: { who: string; what: string; mentions_you?: boolean }) => [e.who, e.what, !!e.mentions_you])).toEqual([
      ['Bob', 'commented on “Deploy”: @Ann shipped!', true],
      ['you', 'moved “Deploy” to Done', false],
    ])
    const mine = await call('recent_activity', { workspace: 'Personal', since: '2h' })
    expect(mine.activity.map((e: { what: string }) => e.what)).toEqual(['renamed the list “Doing” to “In progress”'])
    expect((await call('recent_activity', { since: 'last tuesday' })).error).toContain('since looks like')
  })

  it('the Inbox, what boards are for, priorities, the team overview, time filters, and what an app changed', async () => {
    const { ann, id: personal } = await site({ apiTokens: true })
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: bobs } = (await bob.ok('GET', '/api/boards')).boards[0]
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))

    await ann.ok('POST', `/api/boards/${personal}/mutations`, {
      mutationId: mid(),
      command: { type: 'board.update', fields: { description: 'Home and errands' } },
    })
    const [board] = (await call('list_boards', {})).boards
    expect(board).toMatchObject({ id: personal, about: 'Home and errands' })
    expect(board.inbox).toBeUndefined()

    await new Promise((r) => setTimeout(r, 5))
    const mark = new Date().toISOString()
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const added = await call('create_tasks', { board_id: personal, tasks: [{ title: 'Buy groceries', priority: 'urgent', due: yesterday }] })
    expect(added.board).toEqual({ id: personal, name: 'My first board' })
    await call('update_task', { board_id: personal, task_id: 'A3', priority: 'high' })

    // Priorities: "high" finds urgent and high, most important first.
    const important = await call('find_tasks', { priority: 'high', sort: 'priority' })
    expect(important.tasks.map((x: { title: string; priority: string }) => [x.title, x.priority])).toEqual([
      ['Buy groceries', 'urgent'],
      ['Deploy', 'high'],
    ])
    // Time filters: made after the mark; paging.
    expect((await call('find_tasks', { created_after: mark })).tasks.map((x: { title: string }) => x.title)).toEqual(['Buy groceries'])
    expect((await call('find_tasks', { created_before: '1h' })).total).toBe(0)
    const page = await call('find_tasks', { limit: 2 })
    expect(page.next_offset).toBe(2)
    expect((await call('find_tasks', { limit: 2, offset: 2 })).tasks[0].id).not.toBe(page.tasks[0].id)

    // The outline: top level only, or inside one task.
    const top = await call('get_board', { board_id: personal, depth: 1 })
    expect(top.tasks.every((x: { depth: number }) => x.depth === 0)).toBe(true)
    expect(top.board.about).toBe('Home and errands')
    const inside = await call('get_board', { board_id: personal, parent_id: 'A' })
    expect(inside.tasks[0]).toMatchObject({ depth: 0, id: 'A2' }) // (A1 is done)

    // The team overview: what needs attention.
    const [overview] = (await call('team_overview', { board_id: personal })).boards
    expect(overview.overdue.tasks.map((x: { title: string }) => x.title)).toContain('Buy groceries')
    expect(overview.urgent_or_high.tasks.map((x: { title: string }) => x.title)).toEqual(['Buy groceries', 'Deploy'])
    expect(overview.people[0]).toMatchObject({ name: 'Ann', you: true })

    // Activity: a time band, one person, and what came through an app.
    const byMe = await call('recent_activity', { person: 'me', since: mark })
    expect(byMe.activity.map((e: { via?: string; what: string }) => [e.via, e.what])).toEqual([
      ['API', 'set the priority of “Deploy” to high'],
      ['API', 'added “Buy groceries”'],
    ])
    expect((await call('recent_activity', { until: mark })).activity.map((e: { what: string }) => e.what)).toEqual(['changed what the board is for'])
    expect((await call('recent_activity', { person: 'Zed' })).error).toContain('no one called')
    const rest = await ann.ok('GET', `/api/boards/${personal}/activity?since=${encodeURIComponent(mark)}&limit=1`)
    expect(rest.activity).toMatchObject([{ kind: 'change', via: 'API', items: [{ taskId: 'A3', text: 'set the priority of “Deploy” to high' }] }])
    expect(rest.nextUntil).toBe(rest.activity[0].at)
    expect((await bob.request('GET', `/api/boards/${personal}/activity`)).status).toBe(404)

    // A reminder, set by Claude: it shows on the task and in "what's coming up".
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    const set = await call('set_reminder', { board_id: personal, task_id: 'A3', at: soon })
    expect(set.reminders).toEqual([expect.objectContaining({ fires: expect.any(String) })])
    expect((await call('get_task', { board_id: personal, task_id: 'A3' })).reminders).toHaveLength(1)
    expect((await call('reminders', {})).upcoming.map((r: { task_id: string }) => r.task_id)).toEqual(['A3'])
    expect((await call('set_reminder', { board_id: personal, task_id: 'A3', remove: 'all' })).reminders).toEqual([])

    // The Inbox: a task with no board named goes there. Everyone has one, made the first time it's needed.
    const noted = await call('create_tasks', { tasks: [{ title: 'Call the bank', priority: 'urgent' }] })
    expect(noted.board).toMatchObject({ name: 'Inbox', inbox: true })
    const inbox = noted.board.id
    expect((await call('create_tasks', { tasks: [{ title: 'Milk' }] })).board.id).toBe(inbox)
    const mine = (await call('list_boards', {})).boards.filter((b: { inbox?: boolean }) => b.inbox)
    expect(mine).toMatchObject([{ id: inbox, name: 'Inbox', workspace: 'Personal', tasks: 2 }])
    expect((await call('get_board', { board_id: inbox })).board).toMatchObject({ inbox: true, your_role: 'owner' })
    expect((await bob.request('GET', `/api/boards/${inbox}`)).status).toBe(404)

    // Filing it away: from the Inbox to where it belongs.
    const { id: errands } = await ann.ok('POST', '/api/boards', { name: 'Errands' })
    const filed = await call('move_to_board', { board_id: inbox, task_id: noted.created[0].id, to_board_id: errands, list: 'doing' })
    expect(filed).toMatchObject({ board: { id: errands, name: 'Errands' }, moved: { title: 'Call the bank', subtasks: 0 } })
    const there = await call('get_task', { board_id: errands, task_id: filed.task_id })
    expect(there).toMatchObject({ title: 'Call the bank', list: 'Doing', priority: 'urgent' })
    expect((await call('move_to_board', { board_id: errands, task_id: filed.task_id, to_board_id: bobs })).error).toContain('doesn’t exist')
    // …and back to the Inbox, like to any board.
    expect((await call('move_to_board', { board_id: errands, task_id: filed.task_id, to_board_id: inbox })).board.id).toBe(inbox)
  })

  it('manages fields: a library’s fields, a choice’s options by name, and which of them a board uses', async () => {
    const { ann } = await site({ apiTokens: true })
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Deals', workspaceId: ws, template: 'example' })
    const as = async (p: Person) => {
      const mcp = withToken(await makeToken(p, 'write'))
      return async (args: object) => toolResult(await rpc(mcp, 'tools/call', { name: 'manage_fields', arguments: args }))
    }
    const fields = await as(ann)
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))

    // A workspace's library, by its name. Asked for twice, a field is made once.
    const made = await fields({ action: 'add', workspace: 'acme', name: 'Stage', type: 'choice', options: ['Lead', 'Won', 'Lost'] })
    expect(made).toMatchObject({ library: 'Acme', field: { name: 'Stage', type: 'choice', options: ['Lead', 'Won', 'Lost'], on_boards: 0 } })
    expect(await fields({ action: 'add', workspace: 'Acme', name: 'stage', type: 'choice', options: ['Other'] })).toMatchObject({
      already_there: true,
      field: { id: made.field.id, options: ['Lead', 'Won', 'Lost'] },
    })
    const value = await fields({ action: 'add', board_id: id, name: 'Value', type: 'number', unit: '$', adds_up: true })
    expect(value).toMatchObject({ library: 'Acme', field: { type: 'number', unit: '$', adds_up: true } })
    expect((await fields({ action: 'add', name: 'X' })).error).toBe('add needs a type.')
    expect((await fields({ action: 'add', workspace: 'Acme', name: 'Priority', type: 'text' })).error).toMatch(/Every card already has “Priority”/)

    // On a board: one field at a time, so a field someone else put there in between stays.
    expect((await fields({ action: 'put_on_board', board_id: id, field: 'Stage', on_card: true })).fields).toEqual([
      { name: 'Stage', type: 'choice', on_card: true },
    ])
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: made.field.id, front: true }, { id: value.field.id }] })
    const again = await fields({ action: 'put_on_board', board_id: id, field: 'Value', total_in_lists: true })
    expect(again.fields).toEqual([
      { name: 'Stage', type: 'choice', on_card: true },
      { name: 'Value', type: 'number', total_in_lists: true },
    ])
    expect((await fields({ action: 'put_on_board', board_id: id, field: 'Stage', total_in_lists: true })).error).toMatch(
      /isn’t a number that adds up/,
    )

    // A choice's options by name: one left out is put away, and the card that has it keeps it.
    await call('update_task', { board_id: id, task_id: 'A3', fields: { Stage: 'Won', Value: 5 } })
    const fewer = await fields({ action: 'change', board_id: id, field: 'Stage', options: ['Lead', 'Qualified', 'Lost'] })
    expect(fewer.field).toMatchObject({ options: ['Lead', 'Qualified', 'Lost'], archived_options: ['Won'], on_boards: 1 })
    expect((await call('get_task', { board_id: id, task_id: 'A3' })).fields).toMatchObject({ Stage: 'Won', Value: 5 })
    // Named again, it's back in use; and an option is renamed by its name.
    const back = await fields({ action: 'change', workspace: 'Acme', field: 'stage', options: ['Lead', 'Qualified', 'Won', 'Lost'] })
    expect(back.field.archived_options).toBeUndefined()
    const renamed = await fields({ action: 'rename_option', workspace: 'Acme', field: 'Stage', option: 'qualified', name: 'Contacted' })
    expect(renamed.field.options).toEqual(['Lead', 'Contacted', 'Won', 'Lost'])
    expect((await fields({ action: 'rename_option', workspace: 'Acme', field: 'Stage', option: 'Nope', name: 'X' })).error).toBe(
      'There’s no option “Nope”. The options are: Lead, Contacted, Won, Lost.',
    )
    expect((await fields({ action: 'change', workspace: 'Acme', field: 'Stage', options: ['A', 'a'] })).error).toMatch(/two options called/)
    expect((await fields({ action: 'change', workspace: 'Acme', field: 'Value', options: ['A'] })).error).toBe('Only a choice has options.')

    // Its name and settings; archived and back; the whole library.
    expect((await fields({ action: 'change', workspace: 'Acme', field: 'Value', name: 'Deal value', unit: '€' })).field).toMatchObject({
      name: 'Deal value',
      unit: '€',
      adds_up: true,
    })
    expect((await fields({ action: 'archive', workspace: 'Acme', field: 'Deal value' })).field).toMatchObject({ archived: true })
    expect((await call('get_board', { board_id: id, tasks: false })).fields.map((f: { name: string }) => f.name)).toEqual(['Stage'])
    expect((await fields({ action: 'restore', workspace: 'Acme', field: 'Deal value' })).field.archived).toBeUndefined()
    expect((await call('get_task', { board_id: id, task_id: 'A3' })).fields).toMatchObject({ 'Deal value': 5 })
    const listed = await fields({ action: 'list', workspace: 'Acme' })
    expect(listed).toMatchObject({ library: 'Acme', you_can_change_it: true })
    expect(listed.fields.map((f: { name: string; on_boards: number }) => [f.name, f.on_boards])).toEqual([
      ['Stage', 1],
      ['Deal value', 1],
    ])

    // Off the board: its values stay, hidden.
    expect((await fields({ action: 'take_off_board', board_id: id, field: 'Stage' })).fields.map((f: { name: string }) => f.name)).toEqual([
      'Deal value',
    ])
    expect((await fields({ action: 'take_off_board', board_id: id, field: 'Stage' })).error).toBe('That field isn’t on this board.')
    expect((await fields({ action: 'put_on_board', board_id: id, field: 'Nope' })).error).toMatch(
      /There’s no field “Nope”. The fields are: Deal value, Stage/,
    )

    // Their own library (the default), and the kinds that point at people and cards.
    expect(await fields({ action: 'add', name: 'Reviewer', type: 'person', several: true })).toMatchObject({
      library: 'Personal',
      field: { type: 'person', several: true },
    })
    expect(
      (await fields({ action: 'add', workspace: 'Acme', name: 'Related', type: 'link', cards_from: 'this board', several: true })).field,
    ).toMatchObject({
      cards_from: 'this board',
      several: true,
    })
    expect((await fields({ action: 'add', workspace: 'Acme', name: 'Deal', type: 'link', cards_from: 'deals' })).field.cards_from).toEqual({
      board_id: id,
    })
    expect((await fields({ action: 'add', workspace: 'Acme', name: 'Other', type: 'link', cards_from: 'Nowhere' })).error).toMatch(
      /no board “Nowhere”/,
    )

    // Someone who isn't an admin of the workspace reads its library, and that's all; a board's fields are its owners'.
    const his = await as(bob)
    expect(await his({ action: 'list', workspace: 'Acme' })).toMatchObject({ you_can_change_it: false })
    expect((await his({ action: 'add', workspace: 'Acme', name: 'X', type: 'text' })).error).toBe('Only the admins of Acme can change its fields.')
    expect((await his({ action: 'archive', board_id: id, field: 'Stage' })).error).toBe('Only the admins of Acme can change its fields.')
    expect((await his({ action: 'put_on_board', board_id: id, field: 'Stage' })).isError).toBe(true)
    expect((await his({ action: 'list', workspace: 'Elsewhere' })).error).toMatch(/You’re not in a workspace called “Elsewhere”/)
    expect((await ann.ok('GET', `/api/workspaces/${ws}/fields`)).fields.map((f: { name: string }) => f.name)).toEqual([
      'Stage',
      'Deal value',
      'Related',
      'Deal',
    ])
  })

  it('sets up a board: creates it, changes its settings, lists and labels, and makes it the Inbox', async () => {
    const { ann } = await site({ apiTokens: true })
    await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))

    const made = await call('create_board', { name: 'Q4 launch', about: 'Launching the new site', workspace: 'acme' })
    expect(made.board).toMatchObject({ name: 'Q4 launch', workspace: 'acme' })
    expect(made.lists.map((l: { name: string }) => l.name)).toEqual(['Backlog', 'To Do', 'Doing', 'Done'])
    const id = made.board.id
    expect((await call('list_boards', {})).boards.find((b: { id: string }) => b.id === id)).toMatchObject({
      workspace: 'Acme',
      about: 'Launching the new site',
    })
    expect((await call('create_board', { name: 'X', workspace: 'Nope' })).error).toContain('Yours: Acme')
    // From a starter: its own lists and fields, and what it added to the library.
    const desk = await call('create_board', { name: 'Help desk', starter: 'support', workspace: 'Acme' })
    expect(desk.lists.map((l: { name: string }) => l.name)).toEqual(['New', 'In progress', 'Waiting on customer', 'Solved'])
    expect(desk.fields).toEqual(['Severity', 'Client', 'Customer email', 'Channel', 'Reported on'])
    // (With the fields of the board of clients that came with it: what its Client field links to.)
    expect(desk.fields_added_to_the_library).toEqual([...desk.fields, 'Email', 'Phone'])
    expect(desk.clients_board).toMatchObject({ made_with_it: true })
    const secondDesk = await call('create_board', { name: 'Second desk', starter: 'support', workspace: 'Acme' })
    expect(secondDesk.fields_added_to_the_library).toBeUndefined()
    expect(secondDesk.clients_board).toEqual({ id: desk.clients_board.id })
    // A shop's orders and a salon's bookings, in Personal: their own clients there, shared by the two.
    const shop = await call('create_board', { name: 'Shop', starter: 'store' })
    expect(shop.lists.map((l: { name: string }) => l.name)).toEqual(['New', 'Packing', 'Packed', 'Shipped'])
    expect(shop.fields).toEqual(['Order total', 'Shipping', 'Client', 'Tracking number'])
    expect(shop.clients_board.made_with_it).toBe(true)
    expect(shop.clients_board.id).not.toBe(desk.clients_board.id)
    const salon = await call('create_board', { name: 'Salon', starter: 'bookings' })
    expect(salon.lists.map((l: { name: string }) => l.name)).toEqual(['Booked', 'Arrived', 'Done', 'No-show'])
    expect(salon.fields_added_to_the_library).toEqual(['Service', 'Price', 'Deposit paid'])
    expect(salon.clients_board).toEqual({ id: shop.clients_board.id })
    // An assistant finds a client's bookings by the client's name (the no-show among them: it counts as finished).
    const visits = await call('find_tasks', { board_id: salon.board.id, fields: { Client: { any_of: ['Dana Keller'] } }, include_done: true })
    expect(visits.tasks.map((x: { title: string }) => x.title).sort()).toEqual(['Dana Keller: colour', 'Dana Keller: nails'])

    const set = await call('update_board', { board_id: id, name: 'Q4 site launch', background: 'teal', parent_status: 'set_by_hand' })
    expect(set.board).toMatchObject({ name: 'Q4 site launch', background: 'teal', parent_status: 'set_by_hand', about: 'Launching the new site' })

    // Lists: add Review before Done, rename, reorder; an empty list can go, one with tasks can't.
    let lists = (await call('manage_lists', { board_id: id, action: 'add', name: 'Review', counts_as: 'doing', before: 'done' })).lists
    expect(lists.map((l: { name: string }) => l.name)).toEqual(['Backlog', 'To Do', 'Doing', 'Review', 'Done'])
    lists = (await call('manage_lists', { board_id: id, action: 'rename', list: 'review', name: 'In review' })).lists
    lists = (await call('manage_lists', { board_id: id, action: 'move', list: 'Backlog' })).lists
    expect(lists.map((l: { name: string; counts_as: string }) => `${l.name}:${l.counts_as}`)).toEqual([
      'To Do:todo',
      'Doing:doing',
      'In review:doing',
      'Done:done',
      'Backlog:backlog',
    ])
    await call('create_tasks', { board_id: id, tasks: [{ title: 'Copy', list: 'In review' }] })
    expect((await call('manage_lists', { board_id: id, action: 'remove', list: 'In review' })).error).toContain('still has 1 task')
    lists = (await call('manage_lists', { board_id: id, action: 'remove', list: 'Backlog' })).lists
    expect(lists).toHaveLength(4)

    // Labels: add (picking a color), rename, and remove only when unused.
    let labels = (await call('manage_labels', { board_id: id, action: 'add', name: 'design' })).labels
    expect(labels).toEqual([expect.objectContaining({ name: 'design', color: expect.any(String) })])
    labels = (await call('manage_labels', { board_id: id, action: 'rename', label: 'design', name: 'Design' })).labels
    const [task] = (await call('find_tasks', { board_id: id, text: 'copy' })).tasks
    await call('update_task', { board_id: id, task_id: task.id, labels: ['Design'] })
    expect((await call('manage_labels', { board_id: id, action: 'remove', label: 'Design' })).error).toContain('is on 1 task')

    // The Inbox isn't a board you choose: a task with no board named never lands on this one.
    expect((await call('create_tasks', { tasks: [{ title: 'Call the printer' }] })).board).toMatchObject({ name: 'Inbox', inbox: true })
  })

  it('the order made by hand: get_board and find_tasks follow it, list by list; update_task places a card in its list', async () => {
    const { ann } = await site({ apiTokens: true })
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))
    const id = (await call('create_board', { name: 'Roadmap' })).board.id
    await call('update_board', { board_id: id, parent_status: 'set_by_hand' })
    const titles = (r: { tasks: { title: string }[] }) => r.tasks.map((x) => x.title)
    const made = await call('create_tasks', { board_id: id, tasks: ['One', 'Two', 'Three', 'Four'].map((title) => ({ title, list: 'To Do' })) })
    const [one, two, three, four] = made.created.map((x: { id: string }) => x.id)
    await call('create_tasks', { board_id: id, parent_id: one, tasks: [{ title: 'A step', list: 'Doing' }] })
    await call('create_tasks', { board_id: id, tasks: [{ title: 'Idea', list: 'Backlog' }] })

    // Never dragged: lists left to right, each in outline order; subtasks stay under their task.
    expect(titles(await call('get_board', { board_id: id }))).toEqual(['Idea', 'One', 'A step', 'Two', 'Three', 'Four'])
    expect(titles(await call('get_board', { board_id: id, order: 'outline' }))).toEqual(['One', 'A step', 'Two', 'Three', 'Four', 'Idea'])

    // Placed by hand: Four to the top of its list, One after Two. The outline doesn't change.
    await call('update_task', { board_id: id, task_id: four, before_task_id: one })
    await call('update_task', { board_id: id, task_id: one, after_task_id: two })
    expect(titles(await call('get_board', { board_id: id }))).toEqual(['Idea', 'Four', 'Two', 'One', 'A step', 'Three'])
    expect(titles(await call('get_board', { board_id: id, list: 'to do', depth: 1 }))).toEqual(['Four', 'Two', 'One', 'Three'])
    expect(titles(await call('find_tasks', { board_id: id, list: 'To Do' }))).toEqual(['Four', 'Two', 'One', 'Three'])
    expect(titles(await call('find_tasks', { board_id: id }))).toEqual(['Idea', 'Four', 'Two', 'One', 'Three', 'A step'])
    expect(titles(await call('find_tasks', { board_id: id, sort: 'outline' }))).toEqual(['One', 'A step', 'Two', 'Three', 'Four', 'Idea'])
    expect(titles(await call('get_board', { board_id: id, order: 'outline' }))).toEqual(['One', 'A step', 'Two', 'Three', 'Four', 'Idea'])

    // Into another list: at the end, or where you say.
    await call('update_task', { board_id: id, task_id: four, list: 'Doing' })
    await call('update_task', { board_id: id, task_id: three, list: 'Doing', before_task_id: four })
    expect(titles(await call('find_tasks', { board_id: id, list: 'Doing' }))).toEqual(['A step', 'Three', 'Four'])
    await call('update_task', { board_id: id, task_id: two, list: 'Doing' })
    expect(titles(await call('find_tasks', { board_id: id, list: 'Doing' }))).toEqual(['A step', 'Three', 'Four', 'Two'])
    // A done list shows its cards when asked for.
    await call('update_task', { board_id: id, task_id: two, list: 'Done' })
    expect(titles(await call('get_board', { board_id: id, list: 'Done' }))).toEqual(['Two'])

    // The end is the end, in a list nobody ordered by hand too (One comes before Idea in the outline).
    await call('update_task', { board_id: id, task_id: one, list: 'Backlog' })
    expect(titles(await call('find_tasks', { board_id: id, list: 'Backlog' }))).toEqual(['Idea', 'One'])
    await call('update_task', { board_id: id, task_id: one, list: 'To Do' })
    // First or last, without knowing what's there.
    await call('update_task', { board_id: id, task_id: four, position: 'top' })
    expect(titles(await call('find_tasks', { board_id: id, list: 'Doing' }))).toEqual(['Four', 'A step', 'Three'])
    await call('update_task', { board_id: id, task_id: four, position: 'bottom' })
    expect(titles(await call('find_tasks', { board_id: id, list: 'Doing' }))).toEqual(['A step', 'Three', 'Four'])
    expect((await call('update_task', { board_id: id, task_id: four, position: 'top', after_task_id: three })).error).toContain('one of position')
    // Putting cards in order isn't work on them: "changed" doesn't count it.
    await t.db.update(tasks).set({ activeAt: new Date(Date.now() - 30 * 86_400_000) })
    t.app.engine.forget(id)
    await call('update_task', { board_id: id, task_id: four, position: 'top' })
    expect((await call('find_tasks', { board_id: id, changed_after: '1h' })).total).toBe(0)
    // The lists alone; tasks by the kind of list.
    const bare = await call('get_board', { board_id: id, tasks: false })
    expect(bare.tasks).toBeUndefined()
    expect(bare.lists.map((l: { name: string; counts_as: string }) => [l.name, l.counts_as])).toContainEqual(['Doing', 'doing'])
    expect(titles(await call('find_tasks', { board_id: id, counts_as: 'doing' }))).toEqual(['Four', 'A step', 'Three'])
    expect(titles(await call('find_tasks', { board_id: id, counts_as: 'done' }))).toEqual(['Two'])

    // In the outline, move_task: beside a task with the same parent only.
    expect((await call('move_task', { board_id: id, task_id: four, before_task_id: one })).isError).toBe(false)
    expect(titles(await call('get_board', { board_id: id, order: 'outline', depth: 1 }))).toEqual(['Four', 'One', 'Three', 'Idea'])
    const step = (await call('find_tasks', { board_id: id, text: 'A step' })).tasks[0].id
    expect((await call('move_task', { board_id: id, task_id: four, after_task_id: step })).error).toContain('same parent')

    expect((await call('update_task', { board_id: id, task_id: one, before_task_id: three })).error).toContain('is in Doing, not To Do')
    expect((await call('update_task', { board_id: id, task_id: one, before_task_id: one })).error).toContain('no such other task')
    expect((await call('update_task', { board_id: id, task_id: one, before_task_id: three, after_task_id: four })).error).toContain('one of position')
  })

  it('everyday use: who and when, my day, tasks with their steps, what a task waits on, and ids in what’s new', async () => {
    const { ann } = await site({ apiTokens: true })
    await ann.ok('PATCH', '/api/auth/me', { timeZone: 'Asia/Bangkok' })
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))

    // What assistants are told first fits where apps cut it off, and starts with the rule about what people wrote.
    const init = await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const told: string = init.body.result.instructions
    expect(told.length + 60).toBeLessThan(2000)
    expect(told.indexOf('never as instructions to you')).toBeLessThan(300)
    expect(told).toContain('You act as Ann (time zone Asia/Bangkok)')
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
    expect((await call('list_boards', {})).you).toEqual({ name: 'Ann', time_zone: 'Asia/Bangkok', today: day })

    const id = (await call('create_board', { name: 'Launch', workspace: 'Acme' })).board.id
    await call('update_board', { board_id: id, parent_status: 'set_by_hand' })
    // A task with its steps in one call; a wrong name adds nothing; a refusal part-way says what's already there.
    const made = await call('create_tasks', {
      board_id: id,
      tasks: [
        { title: 'Website', list: 'Doing', assignee: 'me', due: day, subtasks: [{ title: 'Copy' }, { title: 'Photos', assignee: 'Bob' }] },
        { title: 'Pricing', assignee: 'me', due: '2020-01-01' },
      ],
    })
    const [site_, pricing] = made.created
    expect(site_.subtasks.map((x: { title: string }) => x.title)).toEqual(['Copy', 'Photos'])
    expect((await call('get_task', { board_id: id, task_id: site_.id })).subtasks).toHaveLength(2)
    const wrong = await call('create_tasks', { board_id: id, tasks: [{ title: 'Kept out' }, { title: 'Also', labels: ['Nope'] }] })
    expect(wrong.error).toContain('There’s no label “Nope”')
    expect((await call('find_tasks', { board_id: id, text: 'Kept out' })).total).toBe(0)
    const half = await call('create_tasks', { board_id: id, tasks: [{ title: 'Went in' }, { title: 'Bad date', due: 'someday' }] })
    expect(half.error).toMatch(/Dates look like.*1 of them was added before that.*“Went in”/)
    expect((await call('find_tasks', { board_id: id, text: 'Went in' })).total).toBe(1)

    // What a task waits on: set here, shown in the overview; two tasks can't wait on each other.
    await call('update_task', { board_id: id, task_id: site_.id, waiting_on: [pricing.id] })
    expect((await call('get_task', { board_id: id, task_id: site_.id })).waiting_on).toEqual([{ id: pricing.id, title: 'Pricing' }])
    expect((await call('team_overview', { board_id: id })).boards[0].blocked.tasks[0]).toMatchObject({
      title: 'Website',
      waiting_on: [{ id: pricing.id, title: 'Pricing' }],
    })
    expect((await call('update_task', { board_id: id, task_id: pricing.id, waiting_on: [site_.id] })).error).toContain('can’t wait on each other')

    // A reminder before a whole due day counts from 9:00 where the person is.
    const reminded = await call('set_reminder', { board_id: id, task_id: site_.id, before_due_minutes: 0 })
    expect(reminded.reminders[0].fires).toBe(`${day}T02:00:00.000Z`)

    // My day, in one answer.
    await bob.ok('POST', `/api/boards/${id}/tasks/${site_.id}/comments`, { body: '@Ann which photos?', mentions: [ann.user.id] })
    const mine = await call('my_day', {})
    expect(mine.today).toBe(day)
    expect(mine.overdue.tasks.map((x: { title: string }) => x.title)).toEqual(['Pricing'])
    expect(mine.due_today.tasks).toEqual([expect.objectContaining({ title: 'Website', board_id: id, board: 'Launch' })])
    expect(mine.in_progress.tasks.filter((x: { board_id: string }) => x.board_id === id).map((x: { title: string }) => x.title)).toEqual(['Website'])
    expect(mine.blocked.tasks[0].waiting_on).toEqual([{ id: pricing.id, title: 'Pricing' }])
    expect(mine.unseen_mentions).toEqual([expect.objectContaining({ who: 'Bob', board_id: id, task_id: site_.id, text: '@Ann which photos?' })])

    // What's new says which board and task each line is about.
    const news = await call('recent_activity', { board_id: id })
    expect(news.activity[0]).toMatchObject({ board_id: id, task_id: site_.id, who: 'Bob' })
    expect(news.activity.find((e: { task_ids?: string[] }) => e.task_ids?.includes(pricing.id))).toBeTruthy()
  })

  it('archives: tasks leave the board (and its counts) but can be found and restored; archived boards are read-only', async () => {
    const { ann, id } = await site({ apiTokens: true })
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))
    const count = async () => (await ann.ok('GET', '/api/boards')).boards[0].taskCount as number
    const before = await count()

    // A task with subtasks, archived through the API: gone from the board, kept apart.
    await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.archive', id: 'A2' } })
    const snap = await ann.ok('GET', `/api/boards/${id}`)
    expect(snap.data.tasks.A2).toBeUndefined()
    // (Archived cards aren't sent with the board: they're asked for.)
    expect(snap.data.archived).toBeUndefined()
    const put = await ann.ok('GET', `/api/boards/${id}/archived`)
    expect(put.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['A2', 'A2a', 'A2b'])
    expect(await count()).toBe(before - 3)
    expect((await ann.ok('GET', `/api/boards/${id}/activity`)).activity[0].items[0].text).toMatch(/^archived “/)

    // Assistants find it only when asked, and can bring it back.
    const title = put.tasks.find((t: { id: string }) => t.id === 'A2').title
    const ids = (r: { tasks: { id: string }[] }) => r.tasks.map((x) => x.id)
    expect(ids(await call('find_tasks', { board_id: id, text: title }))).not.toContain('A2')
    const found = await call('find_tasks', { board_id: id, text: title, include_archived: true })
    expect(found.tasks.find((x: { id: string }) => x.id === 'A2')).toMatchObject({ archived: expect.any(String) })
    expect((await call('get_task', { board_id: id, task_id: 'A2' })).subtasks).toHaveLength(2)
    expect(await call('archive_task', { board_id: id, task_id: 'A2', restore: true })).toMatchObject({ archived: false })
    expect((await ann.ok('GET', `/api/boards/${id}`)).data.tasks.A2a.parentId).toBe('A2')
    expect(await call('archive_task', { board_id: id, task_id: 'A3' })).toMatchObject({ archived: true, completed: false })
    await call('archive_task', { board_id: id, task_id: 'A1', completed: true }).then((r) =>
      expect(r).toMatchObject({ completed: true, archived_from: 'Done' }),
    )
    await call('archive_task', { board_id: id, task_id: 'A1', restore: true })

    // The Cards page: archived cards across boards, searchable, in pages; each says where it lives.
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Other' })
    await ann.ok('POST', `/api/boards/${other}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.create', id: 'x1', parentId: null, fields: { title: 'Old idea' } },
    })
    await ann.ok('POST', `/api/boards/${other}/mutations`, { mutationId: mid(), command: { type: 'task.archive', id: 'x1', complete: true } })
    const all = await ann.ok('GET', '/api/cards?state=archived')
    expect(all.cards.map((c: { title: string }) => c.title)).toEqual(['Old idea', 'Deploy'])
    expect(all.cards[1]).toMatchObject({ board: { id }, path: ['Launch website'], canEdit: true })
    expect((await ann.ok('GET', `/api/cards?board=${id}`)).total).toBe(1)
    expect((await ann.ok('GET', '/api/cards?q=idea')).cards.map((c: { id: string }) => c.id)).toEqual(['x1'])
    expect(await ann.ok('GET', '/api/cards?limit=1')).toMatchObject({ total: 2, nextOffset: 1 })
    // Archived as completed or not, kept from then (and filterable).
    expect(all.cards[0]).toMatchObject({ completed: true, list: 'Done' })
    expect(all.cards[1]).toMatchObject({ completed: false })
    expect((await ann.ok('GET', '/api/cards?completed=true')).cards.map((c: { id: string }) => c.id)).toEqual(['x1'])
    expect((await ann.ok('GET', '/api/cards?completed=false')).total).toBe(1)
    await ann.ok('DELETE', `/api/boards/${other}`)

    // An archived board: off the list, read-only (comments too), until restored; it can still be deleted.
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: true })
    expect((await ann.ok('GET', `/api/boards/${id}`)).access.archivedAt).toEqual(expect.any(String))
    expect((await call('list_boards', {})).boards).toEqual([])
    expect((await call('list_boards', { include_archived: true })).boards[0]).toMatchObject({ id, archived: expect.any(String) })
    const refused = await ann.request('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A1', fields: { title: 'x' } },
    })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toContain('archived')
    expect((await ann.request('POST', `/api/boards/${id}/tasks/A1/comments`, { body: 'hi' })).status).toBe(403)
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: false })
    await ann.ok('POST', `/api/boards/${id}/tasks/A1/comments`, { body: 'hi' })
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: true })
    await ann.ok('DELETE', `/api/boards/${id}`)
  })

  it('time: log it, see it on the task, in the board’s week and in my week; plans are read, not changed', async () => {
    const { ann, id } = await site({ apiTokens: true })
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))
    const today = new Date().toISOString().slice(0, 10)
    expect(await call('log_time', { board_id: id, task_id: 'A3', time: '1:30', note: 'review' })).toMatchObject({
      logged: '1h 30m',
      day: today,
      note: 'review',
      isError: false,
    })
    expect(await call('log_time', { board_id: id, task_id: 'A3', time: '20' })).toMatchObject({
      isError: true,
      error: '20 hours? Type 20m for minutes.',
    })
    expect(await call('log_time', { board_id: id, task_id: 'A3', time: '45m', day: 'tomorrow' })).toMatchObject({ isError: true })
    const task = await call('get_task', { board_id: id, task_id: 'A3' })
    expect(task.time).toEqual({
      total: '1h 30m',
      by_person: [{ name: 'Ann', time: '1h 30m' }],
      latest: [{ who: 'Ann', time: '1h 30m', day: today, note: 'review' }],
    })
    expect((await call('team_overview', { board_id: id })).boards[0].logged_this_week).toEqual([{ name: 'Ann', time: '1h 30m' }])
    const week = await call('my_week', {})
    expect(week.total).toBe('1h 30m')
    expect(week.tasks).toEqual([expect.objectContaining({ task_id: 'A3', total: '1h 30m', days: { [today]: '1h 30m' } })])

    // A workspace plan with this board's project: readable, with the logged time as man-days; nothing changes it here.
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('PUT', `/api/boards/${id}/workspace`, { workspaceId: ws })
    const run = (command: object) => ann.ok('POST', `/api/workspaces/${ws}/planning/mutations`, { mutationId: mid(), command })
    const project = (await run({ type: 'project.add', name: 'Launch', plannedMd: 10 })).changes[0].id
    await run({ type: 'project.update', id: project, fields: { boardId: id } })
    const annId = (await ann.ok('GET', `/api/workspaces/${ws}/planning`)).plan.people[0].id
    await run({ type: 'block.add', projectId: project, personId: annId, start: '2026-10-05', end: '2026-10-09', pct: 50 })
    const plan = await call('plan_overview', { workspace: 'Acme' })
    expect(plan.projects[0]).toMatchObject({
      name: 'Launch',
      state: 'running',
      planned_md: 10,
      scheduled_md: 2.5,
      against_plan: 'under',
      logged_md: 0.2,
      people: [{ name: 'Ann', booked_md: 2.5, logged_md: 0.2, blocks: [{ from: '2026-10-05', until: '2026-10-09', pct: 50 }] }],
    })
    expect(plan.people[0]).toMatchObject({ name: 'Ann', hours_per_day: 8 })
    expect((await call('plan_overview', { workspace: 'Nowhere' })).isError).toBe(true)
    expect(
      ((await rpc(mcp, 'tools/list')).body.result.tools as { name: string }[]).some((x) => /plan/.test(x.name) && x.name !== 'plan_overview'),
    ).toBe(false)
  })

  it('read-only tokens get the reading tools only', async () => {
    const { ann, id } = await site({ apiTokens: true })
    const mcp = withToken(await makeToken(ann, 'read'))
    const tools = (await rpc(mcp, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name)
    expect(tools).toEqual([
      'list_boards',
      'get_board',
      'find_tasks',
      'team_overview',
      'recent_activity',
      'reminders',
      'my_day',
      'get_task',
      'read_file',
      'my_week',
      'plan_overview',
    ])
    const r = await rpc(mcp, 'tools/call', { name: 'create_tasks', arguments: { board_id: id, tasks: [{ title: 'x' }] } })
    expect(r.body.result?.isError ?? !!r.body.error).toBe(true)
    // The same over the plain API: your own fields can be read with such a token, not changed.
    expect((await mcp('GET', '/api/fields')).status).toBe(200)
    expect((await mcp('POST', '/api/fields', { name: 'Stage', type: 'text' })).status).toBe(403)
  })

  it('worked on in a stretch of time: find_tasks finds what was made or changed then, and says what happened', async () => {
    const { ann, id } = await site({ apiTokens: true })
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000)
    // Everything on the board is 200 days old, except: A3 was made 100 days ago, and C1 last changed then.
    await t.db.update(tasks).set({ createdAt: ago(200), activeAt: ago(200), updatedAt: ago(200) })
    await t.db
      .update(tasks)
      .set({ doneAt: ago(200) })
      .where(eq(tasks.id, 'A1'))
    await t.db
      .update(tasks)
      .set({ createdAt: ago(100) })
      .where(eq(tasks.id, 'A3'))
    await t.db
      .update(tasks)
      .set({ activeAt: ago(100), updatedAt: ago(100) })
      .where(eq(tasks.id, 'C1'))
    // B1 was commented on 100 days ago; time was logged on A2a for a day then; B2 was changed 85 days ago (and again
    // since: only the activity log remembers).
    await call('add_comment', { board_id: id, task_id: 'B1', text: 'Sent the first batch' })
    await t.db.update(comments).set({ createdAt: ago(100) })
    await call('log_time', { board_id: id, task_id: 'A2a', time: '2h', day: ago(100).toISOString().slice(0, 10) })
    await t.db.insert(boardActivity).values({
      id: '00000000-0000-4000-8000-000000000085',
      boardId: id,
      actorId: ann.user.id,
      at: ago(85),
      command: 'task.update',
      items: [{ taskId: 'B2', text: 'renamed “Book a photographer”' }],
    })

    const then = { board_id: id, worked_after: ago(120).toISOString(), worked_before: ago(80).toISOString() }
    const found = await call('find_tasks', then)
    const why = Object.fromEntries(found.tasks.map((x: { id: string; worked: string[] }) => [x.id, x.worked]))
    expect(why).toEqual({ A3: ['made'], C1: ['changed'], B1: ['commented on'], A2a: ['time logged'], B2: ['changed'] })
    // It combines with the other filters, and a stretch nothing happened in finds nothing.
    expect((await call('find_tasks', { ...then, text: 'photographer' })).tasks.map((x: { id: string }) => x.id)).toEqual(['B2'])
    expect((await call('find_tasks', { board_id: id, worked_after: ago(60).toISOString(), worked_before: ago(30).toISOString() })).total).toBe(0)
    // Lately: the task the time was logged on isn't there (the time was for a day long ago); nor is the commented one.
    expect((await call('find_tasks', { board_id: id, worked_after: '1h' })).total).toBe(0)

    // Done and archived tasks are found too: A3 is finished and put away today, and still was made back then.
    await call('archive_task', { board_id: id, task_id: 'A3', completed: true })
    const after = await call('find_tasks', then)
    expect(after.tasks.find((x: { id: string }) => x.id === 'A3')).toMatchObject({ archived: expect.any(String), worked: ['made'] })
    const today = await call('find_tasks', { board_id: id, worked_after: '1h' })
    expect(today.tasks.find((x: { id: string }) => x.id === 'A3').worked).toEqual(['changed', 'done', 'archived'])
    expect((await call('find_tasks', { board_id: id, worked_after: 'last spring' })).error).toMatch(/worked_after looks like/)
  })

  it('stale work: find_tasks idle_days and sort, counting comments and subtasks; favourites in list_boards', async () => {
    const { ann, id } = await site({ apiTokens: true })
    const mcp = withToken(await makeToken(ann, 'write'))
    const call = async (name: string, args: object) => toolResult(await rpc(mcp, 'tools/call', { name, arguments: args }))
    // Everything on the starter board is weeks old; make A3 look fresh through a comment, and A1 through an edit.
    await t.db.update(tasks).set({ activeAt: new Date(Date.now() - 30 * 86_400_000), updatedAt: new Date(Date.now() - 30 * 86_400_000) })
    await t.db
      .update(tasks)
      .set({ doneAt: new Date(Date.now() - 30 * 86_400_000) })
      .where(eq(tasks.id, 'A1'))
    await call('add_comment', { board_id: id, task_id: 'A3', text: 'Still on it' })
    await call('update_task', { board_id: id, task_id: 'A1', title: 'Pick a logo' })
    const stale = await call('find_tasks', { board_id: id, idle_days: 7, sort: 'idle' })
    const ids = stale.tasks.map((x: { id: string }) => x.id)
    expect(ids).not.toContain('A3')
    expect(ids).not.toContain('A1')
    // A1's parent counts its subtask's activity.
    expect(ids).not.toContain('A')
    expect(stale.tasks[0].idle_days).toBeGreaterThanOrEqual(29)

    // What got done, and when: asking by the done date finds done tasks, the ones archived since too (they're
    // what a board's finished work becomes).
    await call('update_task', { board_id: id, task_id: 'B1', list: 'Done' })
    const finished = await call('find_tasks', { board_id: id, done_after: '1h' })
    expect(finished.tasks.map((x: { id: string }) => x.id)).toEqual(['B1'])
    expect(finished.tasks[0]).toMatchObject({ done: true, done_at: expect.any(String) })
    expect((await call('find_tasks', { board_id: id, done_before: '1h' })).tasks.map((x: { id: string }) => x.id)).toEqual(['A1'])
    await call('archive_task', { board_id: id, task_id: 'B1' })
    const since = await call('find_tasks', { board_id: id, done_after: '1h' })
    expect(since.total).toBe(1)
    expect(since.tasks[0]).toMatchObject({ id: 'B1', archived: expect.any(String), completed: true, done_at: finished.tasks[0].done_at })
    // Other searches still leave archived tasks out, unless asked.
    expect((await call('find_tasks', { board_id: id, text: since.tasks[0].title, include_done: true })).total).toBe(0)

    // By when tasks were archived: only archived ones.
    const put = await call('find_tasks', { board_id: id, archived_after: '1h' })
    expect(put.tasks.map((x: { id: string }) => x.id)).toEqual(['B1'])
    expect((await call('find_tasks', { board_id: id, archived_before: '1h' })).total).toBe(0)
    expect((await call('find_tasks', { board_id: id, archived_after: 'soon' })).error).toMatch(/archived_after looks like/)

    // A done list's older cards, all at once: first what would go, then for real.
    await call('create_tasks', { board_id: id, tasks: [{ title: 'Shipped', list: 'Done' }] })
    const would = await call('archive_done_tasks', { board_id: id, older_than_days: 0, dry_run: true })
    expect(would).toMatchObject({ would_archive: 1, with_subtasks: 1, lists: ['Done'], tasks: [{ title: 'Shipped' }] })
    expect((await call('find_tasks', { board_id: id, text: 'Shipped', include_done: true })).total).toBe(1)
    expect((await call('archive_done_tasks', { board_id: id, older_than_days: 365 })).archived).toBe(0)
    expect(await call('archive_done_tasks', { board_id: id, older_than_days: 0 })).toMatchObject({ archived: 1 })
    // A1 is done too, but under "Launch website", which isn't: it stays.
    expect((await call('find_tasks', { board_id: id, include_done: true })).tasks.map((x: { id: string }) => x.id)).toContain('A1')
    const away = await call('find_tasks', { board_id: id, archived_after: '1h' })
    expect(away.tasks.map((x: { title: string }) => x.title).sort()).toEqual(['Send invites', 'Shipped'])
    expect((await call('archive_done_tasks', { board_id: id, older_than_days: 0, list: 'To Do' })).error).toMatch(/isn’t a list for finished work/)

    expect((await call('list_boards', {})).boards[0].favorite).toBeUndefined()
    await ann.ok('PUT', `/api/boards/${id}/favorite`, { favorite: true })
    expect((await call('list_boards', {})).boards[0].favorite).toBe(true)
  })
})

describe('webhook events', () => {
  it('each webhook gets only the events it was set to (all of them, unless chosen)', async () => {
    const { ann, id } = await site({ webhooks: 'any' })
    const all = await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: 'http://127.0.0.1:9/all' })
    const some = await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: 'http://127.0.0.1:9/comments', events: ['comment.added'] })
    const list = (await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks
    expect(list.find((h: { id: string }) => h.id === all.id).events).toEqual(['board.changed', 'comment.added', 'reminder.due'])
    expect(list.find((h: { id: string }) => h.id === some.id).events).toEqual(['comment.added'])
    expect((await ann.request('PATCH', `/api/boards/${id}/webhooks/${some.id}`, { events: [] })).status).toBe(400)

    await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.update', id: 'A3', fields: { title: 'Ship' } } })
    await ann.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'done' })
    await new Promise((r) => setTimeout(r, 100))
    const queued = await t.db.select({ webhookId: webhookDeliveries.webhookId, event: webhookDeliveries.event }).from(webhookDeliveries)
    const events = (hook: string) =>
      queued
        .filter((d) => d.webhookId === hook)
        .map((d) => d.event)
        .sort()
    expect(events(all.id)).toEqual(['board.changed', 'comment.added'])
    expect(events(some.id)).toEqual(['comment.added'])

    // The log: each delivery in full (what was sent and what came back), only the failed ones, and sending one again.
    await t.app.webhooks.process()
    const log = (await ann.ok('GET', `/api/boards/${id}/webhooks/${some.id}/deliveries`)).deliveries
    expect(log[0]).toMatchObject({ event: 'comment.added', status: 'pending', payload: { event: 'comment.added' } })
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks/${some.id}/deliveries?failed=1`)).deliveries).toHaveLength(1)
    const again = await ann.ok('POST', `/api/boards/${id}/webhooks/${some.id}/deliveries/${log[0].id}/resend`)
    expect(again.ok).toBe(false)
    const after = (await ann.ok('GET', `/api/boards/${id}/webhooks/${some.id}/deliveries`)).deliveries
    expect(after).toHaveLength(2)
    expect(after[0].payload).toMatchObject({ resent_from: log[0].id })
  })
})

describe('webhooks that send to a chat app', () => {
  it('get each change as words, unsigned, after a first message; a reorder says nothing', async () => {
    const { ann, id } = await site({ webhooks: 'any' })
    const r = await receiver()
    try {
      const added = await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: r.url, format: 'slack' })
      // No signing secret: nothing at a chat app checks one.
      expect(added).toEqual({ id: added.id })
      expect(JSON.parse(r.got[0].body)).toEqual({ text: 'Kanbanto will post news from My first board here.' })
      expect((await ann.request('GET', `/api/boards/${id}/webhooks/${added.id}/secret`)).status).toBe(400)
      expect((await ann.request('POST', `/api/boards/${id}/webhooks/${added.id}/secret`)).status).toBe(400)
      const [hook] = (await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks
      expect(hook).toMatchObject({ url: r.url, format: 'slack', events: ['board.changed', 'comment.added', 'reminder.due'] })

      const change = (command: object) => ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
      await change({ type: 'task.update', id: 'A', fields: { title: 'Launch!' } })
      // Only its place among the others changes: the activity log has no line for that, and nor has the channel.
      await change({ type: 'task.move', id: 'A3', place: { before: 'A1' } })
      await ann.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'Looks good' })
      expect(await deliver()).toBe(2)

      const [, renamed, comment] = r.got
      expect(renamed.headers['x-kanbanto-signature']).toBeUndefined()
      expect(renamed.headers['x-kanbanto-event']).toBeUndefined()
      expect(JSON.parse(renamed.body).text).toMatch(/^Ann renamed “Launch website” to <http[^|]+\/#\/b\/[^|]+\?task=A\|“Launch!”> on My first board$/)
      expect(JSON.parse(comment.body).text).toMatch(/^Ann commented on <[^|]+\|“Launch!”> on My first board: Looks good$/)

      // The log shows the message as it went, and sending it again sends the same.
      const log = (await ann.ok('GET', `/api/boards/${id}/webhooks/${added.id}/deliveries`)).deliveries
      expect(log.map((d: { event: string }) => d.event)).toEqual(['comment.added', 'board.changed'])
      expect(log[1].payload).toEqual(JSON.parse(renamed.body))
      expect(await ann.ok('POST', `/api/boards/${id}/webhooks/${added.id}/deliveries/${log[1].id}/resend`)).toMatchObject({ ok: true })
      expect(r.got.at(-1)!.body).toBe(renamed.body)
      await ann.ok('POST', `/api/boards/${id}/webhooks/${added.id}/test`)
      expect(JSON.parse(r.got.at(-1)!.body)).toEqual({ text: 'A test from Kanbanto for My first board.' })
    } finally {
      await r.close()
    }
  })

  it('follow the same switches, beside a webhook that gets the data', async () => {
    const { ann, id } = await site({ webhooks: 'any' })
    const chat = await receiver()
    const data = await receiver()
    try {
      const hook = await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: chat.url, format: 'discord', events: ['comment.added'] })
      const { secret } = await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: data.url })
      await ann.ok('POST', `/api/boards/${id}/mutations`, {
        mutationId: mid(),
        command: { type: 'task.update', id: 'A', fields: { title: 'Launch!' } },
      })
      await ann.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'hello @everyone' })
      await deliver()
      // The chat: its first message, then the comment only (card changes are switched off for it).
      expect(chat.got).toHaveLength(2)
      expect(JSON.parse(chat.got[1].body)).toMatchObject({
        content: expect.stringMatching(/commented on .*: hello @everyone$/),
        allowed_mentions: { parse: [] },
      })
      // The data webhook is as it always was: both events, signed, in Kanbanto's own shape.
      expect(data.got.map((g) => g.headers['x-kanbanto-event'])).toEqual(['board.changed', 'comment.added'])
      const [, time, sig] = String(data.got[0].headers['x-kanbanto-signature']).match(/^t=(\d+),v1=([0-9a-f]+)$/)!
      expect(createHmac('sha256', secret).update(`${time}.${data.got[0].body}`).digest('hex')).toBe(sig)
      expect(Object.keys(JSON.parse(data.got[0].body)).sort()).toEqual(['actor', 'at', 'board', 'changes', 'command', 'delivery', 'event', 'seq'])
      // A format is what a webhook is made with.
      expect((await ann.request('PATCH', `/api/boards/${id}/webhooks/${hook.id}`, { format: 'slack' })).status).toBe(400)
      expect((await ann.request('POST', `/api/boards/${id}/webhooks`, { url: chat.url, format: 'carrier-pigeon' })).status).toBe(400)
    } finally {
      await chat.close()
      await data.close()
    }
  })

  it('where only public addresses are allowed: the chat app’s own address, and a first message it takes', async () => {
    const { ann, id } = await site({ webhooks: 'public' })
    const posted: { url: string; body: string; headers: Record<string, string> }[] = []
    let status = 404
    const { post, ask } = t.app.webhooks
    t.app.webhooks.post = async (url, body, headers) => {
      posted.push({ url, body, headers })
      return { status, text: 'ok' }
    }
    // A chat app is never asked for the code: it couldn't answer.
    t.app.webhooks.ask = async () => {
      throw new Error('asked')
    }
    try {
      const slack = 'https://hooks.slack.com/services/T0/B0/abc'
      const elsewhere = await ann.request('POST', `/api/boards/${id}/webhooks`, { url: 'https://example.com/hook', format: 'slack' })
      expect(elsewhere).toMatchObject({ status: 400, body: { error: expect.stringMatching(/isn’t a Slack address/) } })
      expect(posted).toHaveLength(0)

      const refused = await ann.request('POST', `/api/boards/${id}/webhooks`, { url: slack, format: 'slack' })
      expect(refused).toMatchObject({
        status: 400,
        body: { error: expect.stringMatching(/Slack didn’t take a message at that address \(it answered 404\)/) },
      })
      expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks).toHaveLength(0)

      status = 200
      const { id: hookId } = await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: slack, format: 'slack' })
      expect(posted.at(-1)).toMatchObject({ url: slack, body: JSON.stringify({ text: 'Kanbanto will post news from My first board here.' }) })
      expect(Object.keys(posted.at(-1)!.headers).sort()).toEqual(['content-type', 'user-agent'])

      // Its address can change to another of the chat app's, which is greeted too; never to somewhere else.
      const count = posted.length
      expect((await ann.request('PATCH', `/api/boards/${id}/webhooks/${hookId}`, { url: 'https://example.com/hook' })).status).toBe(400)
      await ann.ok('PATCH', `/api/boards/${id}/webhooks/${hookId}`, { url: `${slack}d` })
      expect(posted).toHaveLength(count + 1)

      await ann.ok('POST', `/api/boards/${id}/mutations`, {
        mutationId: mid(),
        command: { type: 'task.update', id: 'A', fields: { title: 'Launch!' } },
      })
      expect(await deliver()).toBe(1)
      expect(posted.at(-1)!.url).toBe(`${slack}d`)
      expect(JSON.parse(posted.at(-1)!.body).text).toMatch(/^Ann renamed “Launch website” to /)
    } finally {
      t.app.webhooks.post = post
      t.app.webhooks.ask = ask
    }
  })
})

describe('API reference', () => {
  it('describes the API (with every command) and shows it at /api/docs', async () => {
    const spec = await new Person(t.app).ok('GET', '/api/openapi.json')
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.components.schemas.Command.oneOf).toHaveLength(18)
    expect(spec.components.schemas.PlanCommand.oneOf).toHaveLength(22)
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/api/boards/{id}/archived',
        '/api/boards/{id}/tasks/{taskId}/time',
        '/api/time/week',
        '/api/workspaces/{id}/planning/mutations',
        '/api/boards/{id}/plan',
      ]),
    )
    expect(Object.keys(spec.webhooks)).toEqual(['board.changed', 'reminder.due', 'comment.added', 'ping'])
    expect((await new Person(t.app).request('GET', '/api/docs')).headers.location).toBe('/api/docs/')
    const page = await new Person(t.app).request('GET', '/api/docs/')
    expect(page.status).toBe(200)
    expect(String(page.headers['content-type'])).toContain('text/html')
  })
})
