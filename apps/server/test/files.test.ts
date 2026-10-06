import { createServer, type Server } from 'node:http'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { redactUrl } from '../src/app'
import { attachments, boardActivity, users, webhookDeliveries } from '../src/db/schema'
import { env } from '../src/env'
import { dropDraft } from '../src/routes/files'
import { uploadLinks } from '../src/routes/uploads'
import { downloads, fetchFile } from '../src/storage/download'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => {
  await reset(t.db)
  uploadLinks.forget()
  downloads.forget()
})
const realGet = downloads.get
afterEach(() => {
  downloads.get = realGet
  env.filesFromUrl = true
})
afterAll(async () => t.close())

// oxlint-disable-next-line typescript/no-explicit-any
type Answer = { status: number; body: any; headers: Record<string, unknown>; raw: Buffer }
type Call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, headers?: Record<string, string>) => Promise<Answer>
/** Requests with an API token instead of a session. */
const withToken = (token: string): Call => {
  const p = new Person(t.app)
  return (method, url, body, headers = {}) => p.request(method, url, body, { authorization: `Bearer ${token}`, ...headers })
}
const makeToken = async (p: Person, scope: 'read' | 'write') =>
  (await p.ok('POST', '/api/account/tokens', { name: 'script', scope, expiresInDays: null })).token as string

/** Ann owns the example board, with API tokens on; Bob can edit it and Vic can only look. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  await setPlatformAdmin(t.db, 'ann@example.com', true)
  await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  return { ann, bob, vic, id }
}

const send = (call: Call, board: string, task: string, name: string, bytes: Buffer | string, more: Record<string, string> = {}) =>
  call('POST', `/api/boards/${board}/tasks/${task}/attachments`, Buffer.from(bytes), {
    'content-type': 'application/octet-stream',
    'x-file-name': encodeURIComponent(name),
    ...more,
  })
const filesOf = async (p: Person | Call, board: string, task: string) =>
  (typeof p === 'function'
    ? (await p('GET', `/api/boards/${board}/tasks/${task}/attachments`)).body
    : await p.ok('GET', `/api/boards/${board}/tasks/${task}/attachments`)
  ).attachments as { id: string; name: string; mime: string; image: boolean; commentId: string | null; size: number }[]
const activity = async (board: string) =>
  (await t.db.select().from(boardActivity).where(eq(boardActivity.boardId, board)))
    .filter((a) => a.command === 'file.attach')
    .map((a) => ({ text: (a.items as { text: string }[])[0].text, via: a.via, actorId: a.actorId }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

// ── The assistant's side (MCP) ──────────────────────────────────────────────

const rpc = (call: Call, method: string, params: object = {}) =>
  call(
    'POST',
    '/api/mcp',
    { jsonrpc: '2.0', id: 1, method, params },
    { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
  )
type Content = { type: string; text?: string; data?: string; mimeType?: string }
const toolWith = (call: Call) => async (name: string, args: object) => {
  const r = (await rpc(call, 'tools/call', { name, arguments: args })) as {
    status: number
    body: { result?: { content: Content[]; isError?: boolean } }
  }
  if (!r.body?.result) return { isError: true, error: `no answer (${r.status})`, content: [] as Content[] }
  const said = r.body.result.content[0].text!
  // (Arguments the tool's own description rules out are refused before it runs, in words rather than JSON.)
  if (!said.startsWith('{')) return { isError: true, error: said, content: r.body.result.content }
  return { ...JSON.parse(said), isError: !!r.body.result.isError, content: r.body.result.content }
}

describe('files with an API token', () => {
  it('a token that may make changes uploads to a card and to a comment, lists, opens and deletes; one that only reads can look', async () => {
    const { ann, bob, id } = await team()
    const write = withToken(await makeToken(bob, 'write'))
    const read = withToken(await makeToken(bob, 'read'))

    const up = await send(write, id, 'A3', 'notes.txt', 'hello', { 'x-file-type': 'text/plain' })
    expect(up.status).toBe(200)
    expect(up.body.attachment).toMatchObject({ name: 'notes.txt', size: 5, mime: 'text/plain', uploader: 'Bob', commentId: null })
    // A text file sent as text (not as "any bytes") is a file too. It used to be refused: "Choose a file to upload."
    const plain = await write('POST', `/api/boards/${id}/tasks/A3/attachments`, 'plain words', {
      'content-type': 'text/plain',
      'x-file-name': 'plain.txt',
    })
    expect(plain.status).toBe(200)
    expect(plain.body.attachment).toMatchObject({ name: 'plain.txt', size: 11 })

    // For a comment: uploaded first, then posted with it. The description points at a file by its name.
    const draft = await send(write, id, 'A3', 'shot.png', PNG, { 'x-file-type': 'image/png', 'x-attach-to': 'comment' })
    const posted = await write('POST', `/api/boards/${id}/tasks/A3/comments`, {
      body: 'Here it is: 📎shot.png',
      attachments: [draft.body.attachment.id],
    })
    expect(posted.body.comment.attachments).toMatchObject([{ name: 'shot.png', image: true, commentId: posted.body.comment.id }])
    const described = await write('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A3', fields: { description: 'See 📎notes.txt' } },
    })
    expect(described.status).toBe(200)

    // Listing and opening: with either token.
    for (const call of [write, read]) {
      expect((await filesOf(call, id, 'A3')).map((f) => f.name)).toEqual(['notes.txt', 'plain.txt', 'shot.png'])
      const got = await call('GET', `/api/attachments/${up.body.attachment.id}`)
      expect(got.status).toBe(200)
      expect(got.raw.toString()).toBe('hello')
    }
    // Changing anything: not with the one that only reads.
    expect((await send(read, id, 'A3', 'no.txt', 'x')).status).toBe(403)
    expect((await read('DELETE', `/api/boards/${id}/attachments/${up.body.attachment.id}`)).status).toBe(403)
    expect((await write('DELETE', `/api/boards/${id}/attachments/${up.body.attachment.id}`)).status).toBe(200)
    expect((await filesOf(ann, id, 'A3')).map((f) => f.name)).toEqual(['plain.txt', 'shot.png'])
  })

  it('a name the card already has gets a number, so 📎name always means one file', async () => {
    const { ann, bob, vic, id } = await team()
    const names = async (p: Person, name: string, more: Record<string, string> = {}) =>
      (await send((m, u, b, h) => p.request(m, u, b, h), id, 'A3', name, 'x', more)).body.attachment.name
    expect(await names(ann, 'report.pdf')).toBe('report.pdf')
    expect(await names(bob, 'report.pdf')).toBe('report (2).pdf')
    // (However it's capitalised; and a file without an ending.)
    expect(await names(ann, 'REPORT.PDF')).toBe('REPORT (3).PDF')
    expect(await names(ann, 'notes')).toBe('notes')
    expect(await names(ann, 'notes')).toBe('notes (2)')
    // A file waiting in a comment someone is writing takes its name for them; a file in a posted comment, for everyone.
    expect(await names(vic, 'shot.png', { 'x-attach-to': 'comment' })).toBe('shot.png')
    expect(await names(vic, 'shot.png', { 'x-attach-to': 'comment' })).toBe('shot (2).png')
    expect(await names(bob, 'shot.png')).toBe('shot.png')
    // Another card has names of its own; a deleted file gives its name back.
    expect(await names(ann, 'report.pdf')).toBe('report (4).pdf')
    const other = (await send((m, u, b, h) => ann.request(m, u, b, h), id, 'A2', 'report.pdf', 'x')).body.attachment
    expect(other.name).toBe('report.pdf')
    await ann.ok('DELETE', `/api/boards/${id}/attachments/${other.id}`)
    expect((await send((m, u, b, h) => ann.request(m, u, b, h), id, 'A2', 'report.pdf', 'x')).body.attachment.name).toBe('report.pdf')
  })

  it('a file attached to a card is a line in the board’s activity, with the app it came through; a comment’s isn’t', async () => {
    const { ann, bob, id } = await team()
    const title = (await ann.ok('GET', `/api/boards/${id}`)).data.tasks.A3.title
    await send((m, u, b, h) => ann.request(m, u, b, h), id, 'A3', 'plan.pdf', 'x')
    await send(withToken(await makeToken(bob, 'write')), id, 'A3', 'data.csv', 'a,b')
    await send((m, u, b, h) => bob.request(m, u, b, h), id, 'A3', 'draft.png', 'x', { 'x-attach-to': 'comment' })
    expect(await activity(id)).toEqual([
      { text: `attached “plan.pdf” to “${title}”`, via: null, actorId: ann.user.id },
      { text: `attached “data.csv” to “${title}”`, via: 'API', actorId: bob.user.id },
    ])
  })

  it('a comment.added webhook lists the comment’s files', async () => {
    const { ann, bob, id } = await team()
    await ann.ok('PATCH', '/api/admin/settings', { webhooks: 'any' })
    await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: 'http://127.0.0.1:9/hook', events: ['comment.added'] })
    const call: Call = (m, u, b, h) => bob.request(m, u, b, h)
    const draft = (await send(call, id, 'A3', 'log.txt', 'line', { 'x-attach-to': 'comment' })).body.attachment
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'The log', attachments: [draft.id] })
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'And a word' })
    await new Promise((r) => setTimeout(r, 150))
    const sent = (await t.db.select().from(webhookDeliveries)).map((d) => (d.payload as { comment: { body: string; files: unknown[] } }).comment)
    expect(sent.find((c) => c.body === 'The log')!.files).toEqual([{ id: draft.id, name: 'log.txt', size: 4 }])
    expect(sent.find((c) => c.body === 'And a word')!.files).toEqual([])
  })
})

describe('a file saved for a comment that then can’t be posted', () => {
  it('is taken away again: its record and what was stored', async () => {
    const { bob, id } = await team()
    const draft = (await send((m, u, b, h) => bob.request(m, u, b, h), id, 'A3', 'log.txt', 'line', { 'x-attach-to': 'comment' })).body.attachment
    expect((await bob.request('GET', `/api/attachments/${draft.id}`)).status).toBe(200)
    await dropDraft(t.db, draft.id)
    expect(await t.db.select().from(attachments).where(eq(attachments.id, draft.id))).toEqual([])
    expect((await bob.request('GET', `/api/attachments/${draft.id}`)).status).toBe(404)
    // Only a draft: a file that's on a card or in a comment isn't touched.
    const kept = (await send((m, u, b, h) => bob.request(m, u, b, h), id, 'A3', 'kept.txt', 'x')).body.attachment
    await dropDraft(t.db, kept.id)
    expect((await bob.request('GET', `/api/attachments/${kept.id}`)).status).toBe(200)
  })
})

describe('files for assistants', () => {
  it('a task lists its files, and read_file opens text and pictures of the board it was asked on', async () => {
    const { ann, bob, vic, id } = await team()
    const call: Call = (m, u, b, h) => ann.request(m, u, b, h)
    const notes = (await send(call, id, 'A3', 'notes.md', '# Plan\n\n' + 'word '.repeat(20_000), { 'x-file-type': 'text/markdown' })).body.attachment
    const shot = (await send(call, id, 'A3', 'shot.png', PNG, { 'x-file-type': 'image/png' })).body.attachment
    const zip = (await send(call, id, 'A3', 'pack.zip', Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 0xfe, 0]))).body.attachment
    const draft = (await send((m, u, b, h) => vic.request(m, u, b, h), id, 'A3', 'log.txt', 'in a comment', { 'x-attach-to': 'comment' })).body
      .attachment
    const waiting = (await send((m, u, b, h) => vic.request(m, u, b, h), id, 'A3', 'unposted.txt', 'nobody sees this', { 'x-attach-to': 'comment' }))
      .body.attachment
    const { comment } = await vic.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'See 📎log.txt', attachments: [draft.id] })

    // With a token that only reads.
    const tool = toolWith(withToken(await makeToken(bob, 'read')))
    const task = await tool('get_task', { board_id: id, task_id: 'A3' })
    expect(task.files).toEqual([
      { id: notes.id, name: 'notes.md', size: '101 kB', kind: 'text/markdown', by: 'Ann', at: notes.createdAt },
      { id: shot.id, name: 'shot.png', size: '16 B', kind: 'image/png', by: 'Ann', at: shot.createdAt },
      { id: zip.id, name: 'pack.zip', size: '8 B', kind: 'application/octet-stream', by: 'Ann', at: zip.createdAt },
      { id: draft.id, name: 'log.txt', size: '12 B', kind: 'application/octet-stream', by: 'Vic', at: draft.createdAt, in_comment: comment.id },
    ])
    expect(task.comments).toMatchObject([{ id: comment.id, author: 'Vic', text: 'See 📎log.txt', files: ['log.txt'] }])
    // A task without files says nothing about them.
    expect('files' in (await tool('get_task', { board_id: id, task_id: 'A2' }))).toBe(false)

    // Text, a piece at a time.
    const first = await tool('read_file', { board_id: id, file_id: notes.id })
    expect(first.file).toEqual({ id: notes.id, name: 'notes.md', size: '101 kB', kind: 'text/markdown', task_id: 'A3' })
    expect(first.text).toHaveLength(80_000)
    expect(first.text.startsWith('# Plan')).toBe(true)
    expect(first).toMatchObject({ next_offset: 80_000, characters_in_all: 100_008 })
    const rest = await tool('read_file', { board_id: id, file_id: notes.id, offset: first.next_offset })
    expect(rest.text).toHaveLength(20_008)
    expect('next_offset' in rest).toBe(false)
    expect((await tool('read_file', { board_id: id, file_id: draft.id })).text).toBe('in a comment')
    // A picture comes as a picture, beside what it is.
    const seen = await tool('read_file', { board_id: id, file_id: shot.id })
    expect(seen.file.name).toBe('shot.png')
    expect(seen.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') })
    // Anything else: said, not shown.
    const packed = await tool('read_file', { board_id: id, file_id: zip.id })
    expect(packed.cant_read).toBe('It isn’t text or a picture, so it can’t be read here. It opens in the app, from its task.')
    expect(packed.content).toHaveLength(1)

    // Not: a file waiting in a comment nobody posted, a deleted one, one of another board (by its id alone), nonsense.
    const none = 'There’s no such file on this board. get_task lists a task’s files.'
    expect(await tool('read_file', { board_id: id, file_id: waiting.id })).toMatchObject({ isError: true, error: none })
    await ann.ok('DELETE', `/api/boards/${id}/attachments/${zip.id}`)
    expect(await tool('read_file', { board_id: id, file_id: zip.id })).toMatchObject({ isError: true, error: none })
    const { id: hers } = await ann.ok('POST', '/api/boards', { name: 'Hers alone', template: 'example' })
    const secret = (await send(call, hers, 'A3', 'secret.txt', 'not for Bob')).body.attachment
    expect(await tool('read_file', { board_id: id, file_id: secret.id })).toMatchObject({ isError: true, error: none })
    expect((await tool('read_file', { board_id: hers, file_id: secret.id })).isError).toBe(true)
    expect(await tool('read_file', { board_id: id, file_id: 'nope' })).toMatchObject({ isError: true, error: none })
    // (Ann, on her own board, reads it.)
    const hersTool = toolWith(withToken(await makeToken(ann, 'read')))
    expect((await hersTool('read_file', { board_id: hers, file_id: secret.id })).text).toBe('not for Bob')
  })

  it('attach_file: a file the assistant writes, on the card or in a comment, under the same rules as any upload', async () => {
    const { ann, bob, vic, id } = await team()
    const tool = toolWith(withToken(await makeToken(bob, 'write')))
    const title = (await ann.ok('GET', `/api/boards/${id}`)).data.tasks.A3.title

    const made = await tool('attach_file', { board_id: id, task_id: 'A3', name: 'report.md', text: '# Report\n\nAll good.' })
    expect(made).toMatchObject({ file: { name: 'report.md', size: '19 B', kind: 'text/markdown' }, attached_to: 'the task', mark: '📎report.md' })
    expect(await filesOf(ann, id, 'A3')).toMatchObject([{ id: made.file.id, name: 'report.md', mime: 'text/markdown', commentId: null }])
    expect((await ann.request('GET', `/api/attachments/${made.file.id}`)).raw.toString()).toBe('# Report\n\nAll good.')
    expect(await activity(id)).toEqual([{ text: `attached “report.md” to “${title}”`, via: 'API', actorId: bob.user.id }])
    // An assistant asking what happened on the board is told, with the app it came through.
    const recent = JSON.stringify(await tool('recent_activity', { board_id: id }))
    expect(recent).toContain(`attached “report.md” to “${title}”`)
    expect(recent).toContain('"via":"API"')
    // Again under that name: numbered, and the mark says so.
    expect((await tool('attach_file', { board_id: id, task_id: 'A3', name: 'report.md', text: 'v2' })).mark).toBe('📎report (2).md')

    // In a comment, in one go: the words, the file, and whoever is mentioned.
    const said = await tool('attach_file', {
      board_id: id,
      task_id: 'A3',
      name: 'orders.csv',
      text: 'a,b\n1,2',
      comment: '@Ann the numbers: 📎orders.csv',
    })
    expect(said).toMatchObject({ file: { name: 'orders.csv', kind: 'text/csv' }, attached_to: 'a comment', mark: '📎orders.csv' })
    const { comments } = await ann.ok('GET', `/api/boards/${id}/tasks/A3/comments`)
    expect(comments).toMatchObject([
      {
        id: said.comment_id,
        body: '@Ann the numbers: 📎orders.csv',
        mentions: [ann.user.id],
        attachments: [{ id: said.file.id, name: 'orders.csv', commentId: said.comment_id }],
      },
    ])
    expect((await ann.ok('GET', '/api/notifications')).notifications.some((n: { kind: string }) => n.kind === 'mention')).toBe(true)
    // (A comment's file isn't a line of its own in the activity.)
    expect(await activity(id)).toHaveLength(2)
    // A comment that points at a file says which it found.
    expect(await tool('add_comment', { board_id: id, task_id: 'A3', text: 'Both: 📎report.md and 📎nothing.txt' })).toMatchObject({
      points_at_files: ['report.md'],
    })

    // Someone who can only look: in a comment yes, on the card no.
    const viewer = toolWith(withToken(await makeToken(vic, 'write')))
    expect(await viewer('attach_file', { board_id: id, task_id: 'A3', name: 'x.txt', text: 'x' })).toMatchObject({
      isError: true,
      error: 'You can view this board, but not change it.',
    })
    expect((await viewer('attach_file', { board_id: id, task_id: 'A3', name: 'x.txt', text: 'x', comment: 'From Vic' })).attached_to).toBe(
      'a comment',
    )

    // What's refused, with nothing left behind.
    const before = (await t.db.select().from(attachments)).length
    const refused = async (args: object, error: string | RegExp) =>
      expect(await tool('attach_file', { board_id: id, task_id: 'A3', ...args })).toMatchObject({
        isError: true,
        error: expect.stringMatching(error),
      })
    await refused({ name: 'a.txt' }, /one of the two/)
    await refused({ name: 'a.txt', text: 'x', url: 'https://example.com/a.txt' }, /one of the two/)
    await refused({ text: 'x' }, /Give the file a name/)
    await refused({ name: 'a.txt', text: '' }, /the text is empty/)
    await refused({ name: 'run.sh', text: 'echo hi' }, /Programs and scripts can’t be attached/)
    await refused({ name: 'big.txt', text: 'x'.repeat(500_001) }, /can be up to 500 kB/)
    await refused({ name: 'a.txt', text: 'x', comment: '   ' }, /The comment has no words/)
    expect(await tool('attach_file', { board_id: id, task_id: 'gone', name: 'a.txt', text: 'x' })).toMatchObject({
      isError: true,
      error: 'There’s no such task on this board.',
    })
    await refused({ name: 'a.txt', text: 'x', comment: 'y'.repeat(10_001) }, /./)
    expect((await t.db.select().from(attachments)).length).toBe(before)
    // The space left counts, as for any upload; and nothing goes on an archived board.
    await ann.ok('PATCH', '/api/admin/storage/settings', { maxFileMb: 1, quotaMb: 1 })
    await tool('attach_file', { board_id: id, task_id: 'A3', name: 'most.txt', text: 'x'.repeat(499_000) })
    await tool('attach_file', { board_id: id, task_id: 'A3', name: 'more.txt', text: 'x'.repeat(499_000) })
    await refused({ name: 'over.txt', text: 'x'.repeat(100_000) }, /out of file space/)
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: true })
    await refused({ name: 'late.txt', text: 'x' }, /This board is archived/)

    // A token that only reads doesn't have the tools at all.
    const names = (await rpc(withToken(await makeToken(bob, 'read')), 'tools/list')).body.result.tools.map((x: { name: string }) => x.name)
    expect(names).toContain('read_file')
    expect(names).not.toContain('attach_file')
    expect(names).not.toContain('upload_link')
  })

  it('attach_file from a web address: fetched for the person, kept as what its bytes are, and off when the site says so', async () => {
    const { ann, bob, id } = await team()
    const tool = toolWith(withToken(await makeToken(bob, 'write')))
    const asked: [string, number][] = []
    const HTML = Buffer.from('<html><script>alert(1)</script></html>')
    downloads.get = async (address, max) => {
      asked.push([address, max])
      return address.includes('page') ? { bytes: HTML, name: 'photo.png' } : { bytes: PNG, name: 'chart%20v2.png'.replace('%20', ' ') }
    }
    // Its name comes from the address when none is given; at most 25 MB is asked for, or the site's limit if less.
    const got = await tool('attach_file', { board_id: id, task_id: 'A3', url: 'https://example.com/files/chart%20v2.png' })
    expect(got).toMatchObject({ file: { name: 'chart v2.png', kind: 'image/png' }, attached_to: 'the task', mark: '📎chart v2.png' })
    expect(asked).toEqual([['https://example.com/files/chart%20v2.png', 10 * 1024 * 1024]])
    expect((await filesOf(ann, id, 'A3'))[0]).toMatchObject({ name: 'chart v2.png', image: true })
    await ann.ok('PATCH', '/api/admin/storage/settings', { maxFileMb: 100, quotaMb: 500 })
    await tool('attach_file', { board_id: id, task_id: 'A3', name: 'named.png', url: 'https://example.com/x' })
    expect(asked[1]).toEqual(['https://example.com/x', 25 * 1024 * 1024])
    // A web page that calls itself a picture is kept as a download, never shown in the page.
    const page = await tool('attach_file', { board_id: id, task_id: 'A3', url: 'https://example.com/page' })
    expect(page.file).toMatchObject({ name: 'photo.png', kind: 'application/octet-stream' })
    expect((await filesOf(ann, id, 'A3')).find((f) => f.name === 'photo.png')).toMatchObject({ image: false })
    const served = await ann.request('GET', `/api/attachments/${page.file.id}`)
    expect(served.headers['content-type']).toBe('application/octet-stream')
    expect(String(served.headers['content-disposition'])).toMatch(/^attachment/)
    // A program by name is refused before anything is fetched; so is someone who can't attach here.
    const n = asked.length
    expect(await tool('attach_file', { board_id: id, task_id: 'A3', name: 'tool.exe', url: 'https://example.com/tool' })).toMatchObject({
      isError: true,
    })
    expect(await tool('attach_file', { board_id: id, task_id: 'gone', url: 'https://example.com/x.png' })).toMatchObject({ isError: true })
    expect(asked).toHaveLength(n)
    // One at a time for a person.
    let release!: () => void
    downloads.get = () => new Promise((resolve) => (release = () => resolve({ bytes: PNG, name: 'slow.png' })))
    const slow = tool('attach_file', { board_id: id, task_id: 'A3', url: 'https://example.com/slow.png' })
    await new Promise((r) => setTimeout(r, 100))
    expect(await tool('attach_file', { board_id: id, task_id: 'A3', url: 'https://example.com/other.png' })).toMatchObject({
      isError: true,
      error: 'A file is still being fetched for you. Wait for it to finish.',
    })
    release()
    expect((await slow).file.name).toBe('slow.png')
    // Switched off (FILES_FROM_URL=off): said, with what still works; writing a file does.
    env.filesFromUrl = false
    expect(await tool('attach_file', { board_id: id, task_id: 'A3', url: 'https://example.com/x.png' })).toMatchObject({
      isError: true,
      error: 'Fetching files from web addresses is turned off on this site. Write the file yourself (text), or use upload_link.',
    })
    expect((await tool('attach_file', { board_id: id, task_id: 'A3', name: 'still.txt', text: 'x' })).isError).toBe(false)
  })

  it('upload_link: one file, to one card, once, by whoever holds the link; nothing else', async () => {
    const { ann, bob, id } = await team()
    const tool = toolWith(withToken(await makeToken(bob, 'write')))
    const put = (address: string, bytes: Buffer | string, headers: Record<string, string> = {}) =>
      t.app.inject({
        method: 'POST',
        url: new URL(address).pathname,
        payload: Buffer.from(bytes),
        headers: { 'content-type': 'application/octet-stream', ...headers },
      })
    const GONE = 'This upload link doesn’t work: it was used, ran out, or never existed. Ask for a new one.'

    const link = await tool('upload_link', { board_id: id, task_id: 'A3', name: 'screen.png' })
    expect(link.upload_to).toMatch(/^http:\/\/[^/]+\/api\/uploads\/kbu_[\w-]{43}$/)
    expect(link.command).toBe(`curl -sS -X POST --data-binary @"PATH_TO_THE_FILE" -H "content-type: application/octet-stream" "${link.upload_to}"`)
    expect(link.works).toBe('once, for 10 minutes, for a file up to 10 MB')
    // The address never reaches the log.
    expect(redactUrl(new URL(link.upload_to).pathname)).toBe('/api/uploads/[token]')
    // Nobody is signed in on this request: the link is the key. It answers with what was saved, and nothing more.
    const sent = await put(link.upload_to, PNG)
    expect(sent.statusCode).toBe(200)
    expect(sent.json()).toEqual({ ok: true, file: { name: 'screen.png', size: PNG.length }, attached_to: 'the card' })
    expect(await filesOf(ann, id, 'A3')).toMatchObject([{ name: 'screen.png', mime: 'image/png', image: true, commentId: null }])
    expect((await activity(id))[0]).toMatchObject({ via: 'API', actorId: bob.user.id })
    // Once: used, it's the same as one that never was.
    expect((await put(link.upload_to, PNG)).json()).toEqual({ error: GONE })
    expect((await put(link.upload_to.replace(/.{6}$/, 'aaaaaa'), PNG)).json()).toEqual({ error: GONE })
    expect((await put(link.upload_to.replace('kbu_', 'kbx_'), PNG)).statusCode).toBe(404)
    // It only takes a file: there's nothing to GET.
    expect((await t.app.inject({ method: 'GET', url: new URL(link.upload_to).pathname })).statusCode).toBe(404)

    // With a comment; and a file whose content is JSON is a file, not something to read as a request.
    const withWords = await tool('upload_link', { board_id: id, task_id: 'A3', name: 'build.json', comment: '@Ann the build log' })
    const posted = await put(withWords.upload_to, '{"ok":false}', { 'content-type': 'application/json' })
    expect(posted.json()).toEqual({ ok: true, file: { name: 'build.json', size: 12 }, attached_to: 'a comment' })
    const { comments } = await ann.ok('GET', `/api/boards/${id}/tasks/A3/comments`)
    expect(comments).toMatchObject([
      {
        body: '@Ann the build log',
        author: { name: 'Bob' },
        mentions: [ann.user.id],
        attachments: [{ name: 'build.json', mime: 'application/json' }],
      },
    ])

    // A program is refused when the link is asked for.
    expect(await tool('upload_link', { board_id: id, task_id: 'A3', name: 'setup.exe' })).toMatchObject({ isError: true })
    // Too big, or without its size: refused before it's read, and the link can still be used for a file that fits.
    await ann.ok('PATCH', '/api/admin/storage/settings', { maxFileMb: 1, quotaMb: 50 })
    const small = await tool('upload_link', { board_id: id, task_id: 'A3', name: 'log.txt' })
    expect((await put(small.upload_to, Buffer.alloc(1024 * 1024 + 1))).statusCode).toBe(413)
    expect((await put(small.upload_to, 'fits')).statusCode).toBe(200)
    // Run out.
    const late = await tool('upload_link', { board_id: id, task_id: 'A3', name: 'late.txt' })
    uploadLinks.expire(new URL(late.upload_to).pathname.split('/').pop()!)
    expect((await put(late.upload_to, 'x')).json()).toEqual({ error: GONE })

    // What the person may do is checked again when the link is used: the card gone, the board archived, the account off.
    const count = async () =>
      (
        await t.db
          .select()
          .from(attachments)
          .where(and(eq(attachments.boardId, id), eq(attachments.taskId, 'A2')))
      ).length
    const forGone = await tool('upload_link', { board_id: id, task_id: 'A2', name: 'a.txt' })
    const forArchived = await tool('upload_link', { board_id: id, task_id: 'A2', name: 'b.txt' })
    const forOff = await tool('upload_link', { board_id: id, task_id: 'A2', name: 'c.txt' })
    await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.delete', id: 'A2' } })
    expect((await put(forGone.upload_to, 'x')).statusCode).toBe(404)
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: true })
    expect((await put(forArchived.upload_to, 'x')).json()).toMatchObject({ error: 'This board is archived. Restore it to make changes.' })
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, bob.user.id))
    expect((await put(forOff.upload_to, 'x')).json()).toEqual({ error: GONE })
    expect(await count()).toBe(0)
  })
})

describe('fetching a file from a web address', () => {
  let server: Server
  let base: string
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok.txt') return res.end('the file')
      if (req.url === '/moved') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
      if (req.url === '/missing') return res.writeHead(404).end('no')
      if (req.url === '/empty') return res.end()
      if (req.url === '/big') return res.writeHead(200, { 'content-length': 3_000_000 }).end(Buffer.alloc(3_000_000))
      if (req.url === '/endless') {
        // (No size said, and it never stops.)
        const more = () => res.write(Buffer.alloc(64 * 1024), () => setImmediate(more))
        res.on('close', () => res.destroy())
        return more()
      }
      // /slow: says nothing.
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'fetched',
      (e: { status?: number; message: string }) => `${e.status}: ${e.message}`,
    )

  it('only https, only public addresses, no sign-in in the address', async () => {
    const MB = 1024 * 1024
    expect(await refusal(fetchFile('http://example.com/a.pdf', MB))).toBe('400: Only https addresses can be fetched.')
    expect(await refusal(fetchFile('ftp://example.com/a.pdf', MB))).toBe('400: Only https addresses can be fetched.')
    expect(await refusal(fetchFile('not an address', MB))).toMatch(/^400: That isn’t a web address/)
    expect(await refusal(fetchFile('https://ann:secret@example.com/a.pdf', MB))).toBe('400: An address with a sign-in in it can’t be fetched.')
    for (const inside of [
      'https://127.0.0.1/a',
      'https://10.0.0.8/a',
      'https://169.254.169.254/latest',
      'https://[::1]/a',
      'https://localhost/a',
      'https://db.internal/a',
    ])
      expect(await refusal(fetchFile(inside, MB)), inside).toMatch(
        /^400: .* is a private network (address|name): only public addresses can be fetched\.$/,
      )
    // (A name that points inside is refused when it's connected to: this machine's own name for itself.)
    expect(await refusal(fetchFile(`${base.replace('http:', 'https:').replace('127.0.0.1', 'localtest.me')}/ok.txt`, MB))).toMatch(
      /^(400: .*private network address.*: only public addresses can be fetched\.|502: That address couldn’t be reached\.)$/,
    )
  })

  it('reads the file, and refuses a redirect, an error, nothing, too much (said or not) and too slow', async () => {
    const get = (path: string, max = 1024 * 1024, timeoutMs = 2000) => fetchFile(`${base}${path}`, max, { anyAddress: true, timeoutMs })
    const got = await get('/ok.txt')
    expect(got.bytes.toString()).toBe('the file')
    expect(got.name).toBe('ok.txt')
    expect(await refusal(get('/moved'))).toBe('400: That address sends you on to another one. Give the address of the file itself.')
    expect(await refusal(get('/missing'))).toBe('400: That address answered 404, not a file.')
    expect(await refusal(get('/empty'))).toBe('400: That address answered with nothing.')
    expect(await refusal(get('/big'))).toBe('413: That file is bigger than the 1 MB that can be fetched.')
    expect(await refusal(get('/endless'))).toBe('413: That file is bigger than the 1 MB that can be fetched.')
    expect(await refusal(get('/slow', 1024 * 1024, 300))).toBe('504: That address didn’t send the file within 0.3 seconds.')
  })
})
