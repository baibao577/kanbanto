import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback'
/** The site's address as the server sees it in tests (injected requests). */
const SITE = 'http://localhost:80'

/** Ann (a platform admin), with apps allowed to connect as given. */
async function site(oauthApps: 'off' | 'known' | 'any' = 'known') {
  const ann = await Person.signUp(t.app, 'Ann')
  await setPlatformAdmin(t.db, 'ann@example.com', true)
  await ann.ok('PATCH', '/api/admin/settings', { oauthApps })
  return ann
}

/** An app's own requests: no cookies. */
const anon = () => new Person(t.app)
const form = (p: Person, url: string, body: Record<string, string>) =>
  p.request('POST', url, new URLSearchParams(body).toString(), { 'content-type': 'application/x-www-form-urlencoded' })

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** Claude registers, and Ann approves it (as the consent page would). Returns the code and what it needs. */
async function connect(ann: Person, opts: { choice?: 'read' | 'write'; scope?: string } = {}) {
  const reg = await anon().request('POST', '/oauth/register', { client_name: 'Claude', redirect_uris: [CLAUDE] })
  expect(reg.status).toBe(201)
  const clientId = reg.body.client_id as string
  const { verifier, challenge } = pkce()
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${SITE}/api/mcp`,
    ...(opts.scope && { scope: opts.scope }),
  }
  const { redirect } = await ann.ok('POST', '/api/oauth/approve', { ...params, choice: opts.choice ?? 'write' })
  const back = new URL(redirect)
  expect(back.origin + back.pathname).toBe(CLAUDE)
  expect(back.searchParams.get('state')).toBe('xyz')
  return { clientId, verifier, code: back.searchParams.get('code')!, params }
}

const rpc = (token: string, method: string, params: object = {}) =>
  anon().request(
    'POST',
    '/api/mcp',
    { jsonrpc: '2.0', id: 1, method, params },
    {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
  )

describe('apps connecting with sign-in (OAuth, for MCP)', () => {
  it('say where to sign in: the 401 from /api/mcp, and the discovery documents', async () => {
    await site()
    const r = await anon().request('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r.status).toBe(401)
    expect(r.headers['www-authenticate']).toBe(`Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/api/mcp"`)
    const resource = await anon().ok('GET', '/.well-known/oauth-protected-resource/api/mcp')
    expect(resource).toMatchObject({ resource: `${SITE}/api/mcp`, authorization_servers: [SITE] })
    const server = await anon().ok('GET', '/.well-known/oauth-authorization-server')
    expect(server).toMatchObject({ issuer: SITE, registration_endpoint: `${SITE}/oauth/register`, code_challenge_methods_supported: ['S256'] })
  })

  it('the whole flow: register, approve, exchange with PKCE, use MCP, refresh, disconnect', async () => {
    const ann = await site()
    const { clientId, verifier, code } = await connect(ann)
    const got = await form(anon(), '/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLAUDE,
    })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'kanbanto:write' })
    const { access_token, refresh_token } = got.body

    const tools = (await rpc(access_token, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name)
    expect(tools).toContain('create_tasks')
    // What it changes is marked with the app's name.
    const [{ id: boardId }] = (await ann.ok('GET', '/api/boards')).boards
    await rpc(access_token, 'tools/call', { name: 'create_tasks', arguments: { board_id: boardId, tasks: [{ title: 'From Claude' }] } })
    const { activity } = await ann.ok('GET', `/api/boards/${boardId}/activity`)
    expect(activity[0]).toMatchObject({ via: 'Claude', items: [{ text: 'added “From Claude”' }] })
    // Only for MCP: not the rest of the API.
    expect((await anon().request('GET', '/api/boards', undefined, { authorization: `Bearer ${access_token}` })).status).toBe(403)

    // The code works once.
    expect(
      (await form(anon(), '/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })).body.error,
    ).toBe('invalid_grant')

    // Refreshing replaces both tokens; the old ones stop working.
    const fresh = await form(anon(), '/oauth/token', { grant_type: 'refresh_token', refresh_token, client_id: clientId })
    expect(fresh.status).toBe(200)
    expect((await rpc(access_token, 'tools/list')).status).toBe(401)
    expect((await form(anon(), '/oauth/token', { grant_type: 'refresh_token', refresh_token, client_id: clientId })).body.error).toBe('invalid_grant')
    expect((await rpc(fresh.body.access_token, 'tools/list')).status).toBe(200)

    // Account settings lists it; disconnecting ends it.
    const { apps } = await ann.ok('GET', '/api/account/apps')
    expect(apps).toEqual([expect.objectContaining({ clientId, name: 'Claude', sendsBackTo: 'claude.ai', scope: 'write' })])
    await ann.ok('DELETE', `/api/account/apps/${clientId}`)
    expect((await rpc(fresh.body.access_token, 'tools/list')).status).toBe(401)
  })

  it('refuses a wrong PKCE verifier, and a read-only approval gets the reading tools only', async () => {
    const ann = await site()
    const bad = await connect(ann)
    const r = await form(anon(), '/oauth/token', {
      grant_type: 'authorization_code',
      code: bad.code,
      code_verifier: pkce().verifier,
      client_id: bad.clientId,
    })
    expect(r.body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('PKCE') })

    const ro = await connect(ann, { choice: 'read' })
    const got = await form(anon(), '/oauth/token', {
      grant_type: 'authorization_code',
      code: ro.code,
      code_verifier: ro.verifier,
      client_id: ro.clientId,
    })
    expect(got.body.scope).toBe('kanbanto:read')
    const tools = (await rpc(got.body.access_token, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name)
    expect(tools).toEqual([
      'list_boards',
      'get_board',
      'find_tasks',
      'team_overview',
      'recent_activity',
      'reminders',
      'my_day',
      'get_task',
      'my_week',
      'plan_overview',
    ])
  })

  it('known AI apps only: Claude and apps on the computer yes, other sites no; any app: yes', async () => {
    const ann = await site('known')
    const register = (uri: string) => anon().request('POST', '/oauth/register', { client_name: 'X', redirect_uris: [uri] })
    expect((await register(CLAUDE)).status).toBe(201)
    expect((await register('http://127.0.0.1:33418/callback')).status).toBe(201)
    expect((await register('cursor://anysphere.cursor-mcp/oauth/callback')).status).toBe(201)
    const evil = await register('https://evil.example/callback')
    expect(evil.body.error).toBe('invalid_redirect_uri')
    expect((await register('http://evil.example/callback')).status).toBe(400)

    await ann.ok('PATCH', '/api/admin/settings', { oauthApps: 'any' })
    expect((await register('https://evil.example/callback')).status).toBe(201)
    expect((await register('http://evil.example/callback')).status).toBe(400) // never plain http off this computer
  })

  it('the consent page shows where you’re sent back to; an unregistered address is refused', async () => {
    const ann = await site()
    const reg = await anon().request('POST', '/oauth/register', { client_name: 'Claude', redirect_uris: [CLAUDE] })
    const base = { response_type: 'code', client_id: reg.body.client_id, code_challenge: pkce().challenge, code_challenge_method: 'S256' }
    const q = (extra: Record<string, string> = {}) => new URLSearchParams({ ...base, ...extra }).toString()
    expect(await ann.ok('GET', `/api/oauth/request?${q({ redirect_uri: CLAUDE, scope: 'kanbanto:read' })}`)).toEqual({
      app: 'Claude',
      sendsBackTo: 'claude.ai',
      maxScope: 'read',
    })
    expect((await ann.request('GET', `/api/oauth/request?${q({ redirect_uri: 'https://claude.ai/elsewhere' })}`)).status).toBe(400)
    expect((await ann.request('POST', '/api/oauth/approve', { ...base, redirect_uri: 'https://evil.example/cb', choice: 'write' })).status).toBe(400)
    // The authorize link itself goes on to the consent page in the web app.
    const go = await anon().request('GET', `/oauth/authorize?${q({ redirect_uri: CLAUDE })}`)
    expect(go.status).toBe(302)
    expect(go.headers.location).toMatch(/^\/#\/authorize\?/)
  })

  it('turning it off stops sign-in and every connected app', async () => {
    const ann = await site()
    const { clientId, verifier, code } = await connect(ann)
    const { access_token } = (
      await form(anon(), '/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })
    ).body
    await ann.ok('PATCH', '/api/admin/settings', { oauthApps: 'off' })
    expect((await rpc(access_token, 'tools/list')).status).toBe(401)
    expect((await anon().request('GET', '/.well-known/oauth-authorization-server')).status).toBe(404)
    expect((await anon().request('POST', '/oauth/register', { redirect_uris: [CLAUDE] })).status).toBe(403)
    const r = await anon().request('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r.headers['www-authenticate']).toBe('Bearer')
  })
})
