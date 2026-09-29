import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
    expect((await ann.request('POST', `/api/boards/${id}/webhooks`, { url: 'https://example.com/hook' })).status).toBe(200)
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
    expect(tools).toEqual(['list_boards', 'get_board', 'find_tasks', 'get_task', 'create_tasks', 'update_task', 'move_task', 'add_comment'])

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

  it('read-only tokens get the reading tools only', async () => {
    const { ann, id } = await site({ apiTokens: true })
    const mcp = withToken(await makeToken(ann, 'read'))
    const tools = (await rpc(mcp, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name)
    expect(tools).toEqual(['list_boards', 'get_board', 'find_tasks', 'get_task'])
    const r = await rpc(mcp, 'tools/call', { name: 'create_tasks', arguments: { board_id: id, tasks: [{ title: 'x' }] } })
    expect(r.body.result?.isError ?? !!r.body.error).toBe(true)
  })
})

describe('API reference', () => {
  it('describes the API (with every command) and shows it at /api/docs', async () => {
    const spec = await new Person(t.app).ok('GET', '/api/openapi.json')
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.components.schemas.Command.oneOf).toHaveLength(14)
    expect(Object.keys(spec.webhooks)).toEqual(['board.changed', 'comment.added', 'ping'])
    expect((await new Person(t.app).request('GET', '/api/docs')).headers.location).toBe('/api/docs/')
    const page = await new Person(t.app).request('GET', '/api/docs/')
    expect(page.status).toBe(200)
    expect(String(page.headers['content-type'])).toContain('text/html')
  })
})
