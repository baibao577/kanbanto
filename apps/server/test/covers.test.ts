import { createServer, type Server } from 'node:http'
import { invertChanges } from '@kanbanto/model/changes'
import type { Change } from '@kanbanto/model/records'
import { exportFile } from '@kanbanto/model/transfer'
import type { BoardData } from '@kanbanto/model/types'
import { eq, sql } from 'drizzle-orm'
import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { attachments, attachmentThumbs } from '../src/db/schema'
import type { LiveMessage } from '../src/live'
import { THUMB_MAX } from '../src/routes/covers'
import { tidyFiles } from '../src/routes/files'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** (The start of a PNG, as far as where it says its size: 256 by 256.) */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0])
/** (A WebP as far as where it says its size: 640 by 480.) */
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([22, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
  Buffer.from([10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]),
])

type Snapshot = { data: BoardData; seq: number }
const load = (p: Person, id: string) => p.ok<Snapshot>('GET', `/api/boards/${id}`)
const coverOf = async (p: Person, id: string, task: string) => (await load(p, id)).data.tasks[task]?.cover
const mutate = (p: Person, id: string, command: unknown) =>
  p.request<{ seq: number; changes: Change[]; error?: string }>('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
/** Attaches a file to a card (a picture unless said otherwise), as a browser does. */
const attach = async (p: Person, board: string, task: string, name = 'photo.png', type = 'image/png', bytes = PNG, forComment = false) => {
  const r = await p.request('POST', `/api/boards/${board}/tasks/${task}/attachments`, bytes, {
    'content-type': 'application/octet-stream',
    'x-file-name': encodeURIComponent(name),
    'x-file-type': type,
    ...(forComment ? { 'x-attach-to': 'comment' } : {}),
  })
  expect(r.status).toBe(200)
  return r.body.attachment as { id: string; name: string; url: string; thumb?: string }
}
const small = (p: Person, board: string, file: string, bytes = WEBP, type = 'image/webp', more: Record<string, string> = {}) =>
  p.request('PUT', `/api/boards/${board}/attachments/${file}/thumb`, bytes, { 'content-type': type, ...more })
const cover = (p: Person, board: string, task: string, file: string | null) =>
  file
    ? p.request('PUT', `/api/boards/${board}/tasks/${task}/cover`, { attachmentId: file })
    : p.request('DELETE', `/api/boards/${board}/tasks/${task}/cover`)
/** A picture on a card, with its small copy, made that card's cover. */
async function covered(p: Person, board: string, task: string, name = 'photo.png') {
  const file = await attach(p, board, task, name)
  expect((await small(p, board, file.id)).status).toBe(200)
  expect((await cover(p, board, task, file.id)).status).toBe(200)
  return file
}
const history = async (p: Person, board: string, task: string) =>
  (await p.ok('GET', `/api/boards/${board}/tasks/${task}/activity`)).entries.flatMap((e: { lines: { text: string }[] }) =>
    e.lines.map((l) => l.text),
  ) as string[]

/** Ann owns the example board; Bob can edit it and Vic can only look. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  return { ann, bob, vic, id }
}

async function listen(p: Person, boardId: string) {
  const messages: LiveMessage[] = []
  const ws: WebSocket = await t.app.injectWS(`/api/boards/${boardId}/live`, { headers: p.cookie ? { cookie: p.cookie } : {} })
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20))
    return test()
  }
  return { ws, messages, until }
}

describe('a picture’s small copy', () => {
  it('is kept for the file, shown to whoever may open the file, and never changed', async () => {
    const { ann, bob, vic, id } = await team()
    const file = await attach(bob, id, 'A3')
    expect(file.thumb).toBeUndefined()
    expect((await vic.request('GET', `/api/attachments/${file.id}/thumb`)).status).toBe(404)
    const put = await small(bob, id, file.id)
    expect([put.status, put.body]).toEqual([200, { thumb: `/api/attachments/${file.id}/thumb` }])
    // Everyone on the board loads it; a browser keeps it for good, for that person only.
    const got = await vic.request('GET', `/api/attachments/${file.id}/thumb`)
    expect(got.status).toBe(200)
    expect(got.headers['content-type']).toBe('image/webp')
    expect(got.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.compare(got.raw, WEBP)).toBe(0)
    // The card's list of files says it has one.
    const listed = (await ann.ok('GET', `/api/boards/${id}/tasks/A3/attachments`)).attachments
    expect(listed).toMatchObject([{ id: file.id, thumb: `/api/attachments/${file.id}/thumb` }])
    // A second one for the same file changes nothing: what a browser kept stays true.
    expect((await small(ann, id, file.id, PNG, 'image/png')).status).toBe(200)
    expect((await ann.request('GET', `/api/attachments/${file.id}/thumb`)).headers['content-type']).toBe('image/webp')
    // A stranger and someone signed out get what the file itself gives them.
    const carl = await Person.signUp(t.app, 'Carl')
    expect((await carl.request('GET', `/api/attachments/${file.id}/thumb`)).status).toBe(404)
    expect((await new Person(t.app).request('GET', `/api/attachments/${file.id}/thumb`)).status).toBe(401)
    // With the public link on, a visitor sees it.
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    expect((await new Person(t.app).request('GET', `/api/attachments/${file.id}/thumb`)).status).toBe(200)
  })

  it('is taken from editors only, as a picture by its first bytes, and small', async () => {
    const { ann, vic, id } = await team()
    const file = await attach(ann, id, 'A3')
    const doc = await attach(ann, id, 'A3', 'notes.txt', 'text/plain', Buffer.from('hello'))
    expect((await small(vic, id, file.id)).status).toBe(403)
    expect((await small(new Person(t.app), id, file.id)).status).toBe(401)
    // Not a picture, whatever it says it is; and not one of the kinds a browser writes.
    expect((await small(ann, id, file.id, Buffer.from('<svg onload=alert(1)>'), 'image/png')).status).toBe(415)
    expect((await small(ann, id, file.id, Buffer.from('GIF89a........'), 'image/png')).status).toBe(415)
    // A small copy that says it is far more pixels than the app makes one, or doesn't say: not kept.
    const huge = Buffer.from(PNG)
    huge.writeUInt32BE(20_000, 16)
    expect((await small(ann, id, file.id, huge, 'image/png')).status).toBe(413)
    expect((await small(ann, id, file.id, PNG.subarray(0, 16), 'image/png')).status).toBe(415)
    expect((await small(ann, id, file.id, Buffer.from('{}'), 'application/json')).status).toBeGreaterThanOrEqual(400)
    // Too big: said by its declared size, before it's read.
    expect((await small(ann, id, file.id, Buffer.concat([PNG, Buffer.alloc(THUMB_MAX)]), 'image/png')).status).toBe(413)
    // Only a picture has one, and only a file of this board.
    expect((await small(ann, id, doc.id)).status).toBe(415)
    expect((await small(ann, id, '00000000-0000-4000-8000-000000000000')).status).toBe(404)
    const dee = await Person.signUp(t.app, 'Dee')
    const [{ id: hers }] = (await dee.ok('GET', '/api/boards')).boards
    expect((await small(dee, hers, file.id)).status).toBe(404)
    expect(await t.db.select({ id: attachmentThumbs.attachmentId }).from(attachmentThumbs)).toEqual([])
  })

  it('the original is passed on to an editor about to make one, from the disk and from S3-compatible storage', async () => {
    const { ann, vic, id } = await team()
    const file = await attach(ann, id, 'A3')
    const doc = await attach(ann, id, 'A3', 'notes.txt', 'text/plain', Buffer.from('hello'))
    const got = await ann.request('GET', `/api/boards/${id}/attachments/${file.id}/original`)
    expect([got.status, got.headers['content-type'], got.headers['cache-control']]).toEqual([200, 'image/png', 'no-store'])
    expect(Buffer.compare(got.raw, PNG)).toBe(0)
    expect((await vic.request('GET', `/api/boards/${id}/attachments/${file.id}/original`)).status).toBe(403)
    expect((await ann.request('GET', `/api/boards/${id}/attachments/${doc.id}/original`)).status).toBe(415)
    // In a bucket: the file's own address sends the browser to the storage; this one brings the bytes here.
    const objects = new Map<string, Buffer>()
    const server: Server = createServer((req, res) => {
      const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        if (req.method === 'PUT') objects.set(key, Buffer.concat(chunks))
        else if (req.method === 'GET' && objects.has(key)) return res.end(objects.get(key))
        else if (req.method === 'GET') res.statusCode = 404
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      await ann.ok('PUT', '/api/admin/storage/bucket', { endpoint, bucket: 'files', accessKeyId: 'AK', secret: 'SECRET1234' })
      const far = await attach(ann, id, 'A3', 'far.png')
      expect((await ann.request('GET', far.url)).status).toBe(302)
      const through = await ann.request('GET', `/api/boards/${id}/attachments/${far.id}/original`)
      expect(through.status).toBe(200)
      expect(Buffer.compare(through.raw, PNG)).toBe(0)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

describe('a card’s cover', () => {
  it('is one of its pictures, set and removed by editors, and reaches every open copy as a change', async () => {
    const { ann, bob, vic, id } = await team()
    const file = await attach(bob, id, 'A3')
    // The picture needs its small copy first.
    const early = await cover(bob, id, 'A3', file.id)
    expect([early.status, early.body.code]).toEqual([409, 'needs-thumb'])
    await small(bob, id, file.id)
    const before = (await load(ann, id)).data.tasks.A3
    const live = await listen(ann, id)
    const set = await cover(bob, id, 'A3', file.id)
    expect(set.status).toBe(200)
    expect(set.body.changes).toMatchObject([{ entity: 'task', id: 'A3', after: { cover: file.id } }])
    expect(await live.until(() => live.messages.some((m) => m.type === 'changes' && m.seq === set.body.seq))).toBe(true)
    live.ws.close()
    const after = (await load(vic, id)).data.tasks.A3
    // The card isn't counted as edited: what was done to it before can still be undone.
    expect(after).toEqual({ ...before, cover: file.id })
    // (Also what the database holds, not only the server's memory.)
    t.app.engine.forget(id)
    expect(await coverOf(ann, id, 'A3')).toBe(file.id)
    // Asking again changes nothing and says so.
    expect((await cover(bob, id, 'A3', file.id)).body.changes).toEqual([])
    // Viewers and visitors can't; a stranger isn't told the board exists.
    expect((await cover(vic, id, 'A3', null)).status).toBe(403)
    expect((await cover(new Person(t.app), id, 'A3', null)).status).toBe(401)
    expect((await cover(await Person.signUp(t.app, 'Carl'), id, 'A3', null)).status).toBe(404)
    // Removed: the picture stays among the card's files.
    expect((await cover(ann, id, 'A3', null)).status).toBe(200)
    expect(await coverOf(ann, id, 'A3')).toBeUndefined()
    expect((await ann.ok('GET', `/api/boards/${id}/tasks/A3/attachments`)).attachments).toHaveLength(1)
    expect(await history(ann, id, 'A3')).toEqual(expect.arrayContaining(['made “photo.png” the cover', 'removed the cover']))
  })

  it('is a picture of that card, on the board, not in the trash', async () => {
    const { ann, id } = await team()
    const doc = await attach(ann, id, 'A3', 'notes.txt', 'text/plain', Buffer.from('hello'))
    expect((await cover(ann, id, 'A3', doc.id)).status).toBe(415)
    // A picture of another card.
    const other = await attach(ann, id, 'B1')
    await small(ann, id, other.id)
    expect((await cover(ann, id, 'A3', other.id)).status).toBe(404)
    // A picture of another board.
    const { id: second } = await ann.ok('POST', '/api/boards', { name: 'Ops' })
    expect((await cover(ann, second, 'A3', other.id)).status).toBe(404)
    // One in the trash; a card that isn't there; an archived card.
    const gone = await attach(ann, id, 'A3', 'gone.png')
    await small(ann, id, gone.id)
    await ann.ok('DELETE', `/api/boards/${id}/attachments/${gone.id}`)
    expect((await cover(ann, id, 'A3', gone.id)).status).toBe(404)
    expect((await cover(ann, id, 'nothing', other.id)).status).toBe(404)
    await mutate(ann, id, { type: 'task.archive', id: 'B1' })
    expect((await cover(ann, id, 'B1', other.id)).status).toBe(409)
    expect((await cover(ann, id, 'A3', 'not-a-file')).status).toBe(400)
    expect(await coverOf(ann, id, 'A3')).toBeUndefined()
  })

  it('no command sets it, an undo leaves it alone, and an older copy of the card doesn’t wipe it', async () => {
    const { ann, id } = await team()
    const file = await covered(ann, id, 'A3')
    const start = (await load(ann, id)).data
    // A command that tries to carry one, on a card and on a new card.
    await mutate(ann, id, { type: 'task.update', id: 'A1', fields: { title: 'Renamed', cover: file.id } })
    await mutate(ann, id, { type: 'task.create', id: 'n1', parentId: null, fields: { title: 'New', cover: file.id } })
    const then = (await load(ann, id)).data
    expect([then.tasks.A1.cover, then.tasks.n1.cover, then.tasks.A1.title]).toEqual([undefined, undefined, 'Renamed'])
    // Edits to the card keep its cover, in memory and in the database.
    const edit = await mutate(ann, id, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    expect(edit.body.changes[0].after).toMatchObject({ title: 'Ship it', cover: file.id })
    // Undo of that edit, sent by a copy that never knew of the cover: the title goes back, the cover stays.
    const inverse = invertChanges((await load(ann, id)).data, edit.body.changes, new Date().toISOString()).map((c) => {
      if (c.entity !== 'task' || !c.after) return c
      const { cover: _unknown, ...after } = c.after
      return { ...c, after }
    })
    expect((await mutate(ann, id, { type: 'records.restore', changes: inverse })).status).toBe(200)
    t.app.engine.forget(id)
    const back = (await load(ann, id)).data.tasks.A3
    expect([back.title, back.cover]).toEqual([start.tasks.A3.title, file.id])
    // A made-up undo can't give a card another card's picture, nor take a cover away.
    const lie = [
      { entity: 'task', id: 'A1', before: (await load(ann, id)).data.tasks.A1, after: { ...(await load(ann, id)).data.tasks.A1, cover: file.id } },
    ]
    await mutate(ann, id, { type: 'records.restore', changes: lie })
    const strip = [{ entity: 'task', id: 'A3', before: back, after: (({ cover: _c, ...rest }) => rest)(back) }]
    await mutate(ann, id, { type: 'records.restore', changes: strip })
    t.app.engine.forget(id)
    const end = (await load(ann, id)).data
    expect([end.tasks.A1.cover, end.tasks.A3.cover]).toEqual([undefined, file.id])
    // Archived and brought back: still there.
    await mutate(ann, id, { type: 'task.archive', id: 'A3' })
    await mutate(ann, id, { type: 'task.restore', id: 'A3' })
    expect(await coverOf(ann, id, 'A3')).toBe(file.id)
  })

  it('goes when its file is removed and comes back with it; a comment’s picture goes with the comment', async () => {
    const { ann, bob, id } = await team()
    const file = await covered(ann, id, 'A3')
    const other = await attach(ann, id, 'A3', 'other.png')
    // Removing another file leaves the cover.
    expect(await ann.ok('DELETE', `/api/boards/${id}/attachments/${other.id}`)).toEqual({ ok: true })
    expect(await coverOf(bob, id, 'A3')).toBe(file.id)
    // Removing the cover's file says so, and the card has none.
    expect(await ann.ok('DELETE', `/api/boards/${id}/attachments/${file.id}`)).toEqual({ ok: true, wasCover: true })
    expect(await coverOf(bob, id, 'A3')).toBeUndefined()
    expect((await bob.request('GET', `/api/attachments/${file.id}/thumb`)).status).toBe(404)
    // (One line in the card's history for it: the file's.)
    expect((await history(ann, id, 'A3')).filter((l) => /cover/.test(l))).toEqual(['made “photo.png” the cover'])
    // Undo: the file is back with its small copy, and can be the cover again without making another.
    const { attachment } = await ann.ok('POST', `/api/boards/${id}/attachments/${file.id}/restore`)
    expect(attachment.thumb).toBe(`/api/attachments/${file.id}/thumb`)
    expect((await cover(ann, id, 'A3', file.id)).status).toBe(200)
    expect(await coverOf(bob, id, 'A3')).toBe(file.id)
    // A picture posted in a comment, made the cover, then the comment is deleted.
    const posted = await attach(bob, id, 'B1', 'shot.png', 'image/png', PNG, true)
    const { comment } = await bob.ok('POST', `/api/boards/${id}/tasks/B1/comments`, { body: 'Look', attachments: [posted.id] })
    await small(bob, id, posted.id)
    expect((await cover(bob, id, 'B1', posted.id)).status).toBe(200)
    await bob.ok('DELETE', `/api/boards/${id}/comments/${comment.id}`)
    expect(await coverOf(ann, id, 'B1')).toBeUndefined()
  })

  it('a deleted card comes back with its cover, at once and after its files went to the trash; never with another card’s', async () => {
    const { ann, id } = await team()
    const file = await covered(ann, id, 'A3')
    const theirs = await covered(ann, id, 'B1', 'theirs.png')
    const start = (await load(ann, id)).data
    const undoDelete = async () => {
      const del = await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.delete', id: 'A3' } })
      return { del, undo: invertChanges((await load(ann, id)).data, del.changes, new Date().toISOString()) }
    }
    // At once.
    let { undo } = await undoDelete()
    expect((await mutate(ann, id, { type: 'records.restore', changes: undo })).status).toBe(200)
    expect(await coverOf(ann, id, 'A3')).toBe(file.id)
    // After housekeeping put its files in the trash: they come back with it, so the Board can draw the cover.
    ;({ undo } = await undoDelete())
    await tidyFiles(t.app)
    expect((await t.db.select().from(attachments).where(eq(attachments.id, file.id)))[0]).toMatchObject({ orphaned: true })
    expect((await mutate(ann, id, { type: 'records.restore', changes: undo })).status).toBe(200)
    t.app.engine.forget(id)
    expect(await coverOf(ann, id, 'A3')).toBe(file.id)
    const [row] = await t.db.select().from(attachments).where(eq(attachments.id, file.id))
    expect([row.deletedAt, row.orphaned]).toEqual([null, false])
    expect((await ann.request('GET', `/api/attachments/${file.id}/thumb`)).status).toBe(200)
    // An undo that names another card's picture, or one that was never a file: the card comes back without a cover.
    for (const made of [theirs.id, '00000000-0000-4000-8000-000000000000', 'nonsense']) {
      ;({ undo } = await undoDelete())
      const forged = undo.map((c) => (c.entity === 'task' && c.id === 'A3' && c.after ? { ...c, after: { ...c.after, cover: made } } : c))
      expect((await mutate(ann, id, { type: 'records.restore', changes: forged })).status).toBe(200)
      t.app.engine.forget(id)
      const now = (await load(ann, id)).data
      expect([made, now.tasks.A3?.title, now.tasks.A3?.cover]).toEqual([made, start.tasks.A3.title, undefined])
      expect(now.tasks.B1.cover).toBe(theirs.id)
      // (Given back for the next round.)
      expect((await cover(ann, id, 'A3', file.id)).status).toBe(200)
    }
    // Its file removed for good while the card was gone: the card comes back without it.
    ;({ undo } = await undoDelete())
    await t.db.execute(sql`delete from attachments where id = ${file.id}`)
    expect((await mutate(ann, id, { type: 'records.restore', changes: undo })).status).toBe(200)
    expect(await coverOf(ann, id, 'A3')).toBeUndefined()
  })

  it('goes with a card to another board, and stays out of exported and imported boards', async () => {
    const { ann, id } = await team()
    const file = await covered(ann, id, 'A3')
    const { id: ops } = await ann.ok('POST', '/api/boards', { name: 'Ops' })
    const moved = await ann.ok<{ id: string }>('POST', `/api/boards/${id}/tasks/A3/move`, { boardId: ops })
    t.app.engine.forget(ops)
    expect(await coverOf(ann, ops, moved.id)).toBe(file.id)
    expect((await ann.request('GET', `/api/attachments/${file.id}/thumb`)).status).toBe(200)
    // The board's file names no covers (files don't travel in it), and a file that names one is read without it.
    const data = (await load(ann, ops)).data
    expect(Object.values(exportFile(data).data.tasks).some((x) => x.cover)).toBe(false)
    const forged = { app: 'kanbanto', format: 3, exportedAt: new Date().toISOString(), data }
    const made = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file: forged })
    t.app.engine.forget(made.id)
    expect(Object.values((await load(ann, made.id)).data.tasks).some((x) => x.cover)).toBe(false)
  })
})
