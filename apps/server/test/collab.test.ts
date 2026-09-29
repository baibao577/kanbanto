import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { fetch } from 'undici'
import { attachments, notifications, users } from '../src/db/schema'
import { env } from '../src/env'
import { isPublicAddress, PrivateAddressError, publicLookup, publicOnly } from '../src/storage/egress'
import { S3Store } from '../src/storage/stores'
import { sendDigests } from '../src/mail/digest'
import { tidyFiles } from '../src/routes/files'
import { flushMail, mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** A tiny in-memory S3 (path-style: /bucket/key). Signatures aren't checked; the app's side of S3 is. */
async function fakeS3() {
  const objects = new Map<string, Buffer>()
  const server: Server = createServer((req, res) => {
    const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'PUT') objects.set(key, Buffer.concat(chunks))
      else if (req.method === 'DELETE') objects.delete(key)
      else if (req.method === 'GET' && objects.has(key)) return res.end(objects.get(key))
      else if (req.method === 'GET') res.statusCode = 404
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { endpoint: `http://127.0.0.1:${port}`, objects, close: () => new Promise((r) => server.close(r)) }
}

/** Ann owns a board; Bob (editor) and Vic (viewer) are on it. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  return { ann, bob, vic, id }
}

const upload = (p: Person, board: string, task: string, name: string, bytes: Buffer, type = 'application/octet-stream', forComment = false) =>
  p.request('POST', `/api/boards/${board}/tasks/${task}/attachments`, bytes, {
    'content-type': 'application/octet-stream',
    'x-file-name': encodeURIComponent(name),
    'x-file-type': type,
    ...(forComment ? { 'x-attach-to': 'comment' } : {}),
  })

describe('comments', () => {
  it('everyone on the board comments (viewers too); visitors of a public board only read', async () => {
    const { ann, vic, id } = await team()
    expect((await vic.request('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'a\u0000b' })).status).toBe(400)
    const c = await vic.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'Looks good to me' })
    expect(c.comment).toMatchObject({ body: 'Looks good to me', author: { name: 'Vic' } })
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const anon = new Person(t.app)
    expect((await anon.ok('GET', `/api/boards/${id}/tasks/A3/comments`)).comments).toHaveLength(1)
    expect((await anon.request('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'hi' })).status).toBe(401)
    const snap = await ann.ok('GET', `/api/boards/${id}`)
    expect(snap.counts.comments).toEqual({ A3: 1 })
    expect(snap.canComment).toBe(true)
    expect((await anon.ok('GET', `/api/boards/${id}`)).canComment).toBe(false)
  })

  it('only the author edits; the author or an owner deletes', async () => {
    const { ann, bob, vic, id } = await team()
    const { comment } = await vic.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'First' })
    expect((await bob.request('PATCH', `/api/boards/${id}/comments/${comment.id}`, { body: 'Hacked' })).status).toBe(403)
    const edited = await vic.ok('PATCH', `/api/boards/${id}/comments/${comment.id}`, { body: 'First (edited)' })
    expect(edited.comment.editedAt).not.toBeNull()
    expect((await bob.request('DELETE', `/api/boards/${id}/comments/${comment.id}`)).status).toBe(403)
    await ann.ok('DELETE', `/api/boards/${id}/comments/${comment.id}`)
    expect((await ann.ok('GET', `/api/boards/${id}/tasks/A3/comments`)).comments).toEqual([])
  })

  it('@mentions tell the people mentioned (members only, not yourself)', async () => {
    const { ann, bob, vic, id } = await team()
    const stranger = await Person.signUp(t.app, 'Sid')
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, {
      body: '@Ann @Vic can you check this?',
      mentions: [ann.user.id, vic.user.id, bob.user.id, stranger.user.id],
    })
    const annBell = await ann.ok('GET', '/api/notifications')
    expect(annBell.unread).toBe(1)
    expect(annBell.notifications[0]).toMatchObject({ actor: 'Bob', task: { id: 'A3', title: 'Deploy' }, read: false })
    // Not for mentioning yourself, or someone not on the board. (Bob's bell does say Ann added him to the board.)
    const mentions = async (p: Person) =>
      (await p.ok('GET', '/api/notifications')).notifications.filter((n: { kind: string }) => n.kind === 'mention')
    expect(await mentions(bob)).toEqual([])
    expect(await mentions(stranger)).toEqual([])
    await ann.ok('POST', '/api/notifications/read', {})
    expect((await ann.ok('GET', '/api/notifications')).unread).toBe(0)
  })

  it('the daily email summary: once a day at most, and people can turn it off', async () => {
    const { ann, bob, vic, id } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PUT', '/api/admin/email/sender', { apiKey: 're_platform_1234567890abcd', from: 'Kanbanto <noreply@kanbanto.example>' })
    await vic.ok('PATCH', '/api/auth/me', { mentionEmails: false })
    // Now that the site sends email, Bob has to have confirmed his.
    await t.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, 'bob@example.com'))
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: '@Ann and @Vic please review', mentions: [ann.user.id, vic.user.id] })
    // Nothing yet: mentions wait an hour so people can see them in the app first.
    expect(await sendDigests(t.app)).toBe(0)
    await t.db.update(notifications).set({ createdAt: sql`now() - interval '2 hours'` })
    expect(await sendDigests(t.app)).toBe(1)
    await flushMail(t.app)
    const email = t.mail.last('ann@example.com')!
    expect(email.subject).toBe('Bob mentioned you on Kanbanto')
    expect(email.text).toContain('please review')
    expect(t.mail.last('vic@example.com')).toBeUndefined()
    // Another mention the same day waits for tomorrow's summary.
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: '@Ann ping', mentions: [ann.user.id] })
    await t.db.update(notifications).set({ createdAt: sql`now() - interval '2 hours'` })
    expect(await sendDigests(t.app)).toBe(0)
  })
})

describe('attachments', () => {
  it('editors attach files; everyone on the board can open them; viewers can’t attach', async () => {
    const { bob, vic, id } = await team()
    const r = await upload(bob, id, 'A3', 'notes.txt', Buffer.from('hello'), 'text/plain')
    expect(r.status).toBe(200)
    expect(r.body.attachment).toMatchObject({ name: 'notes.txt', size: 5, image: false, uploader: 'Bob' })
    expect((await upload(vic, id, 'A3', 'x.txt', Buffer.from('x'))).status).toBe(403)
    const file = await vic.request('GET', r.body.attachment.url)
    expect(file.raw.toString()).toBe('hello')
    // Not a picture: it downloads (it can never run as a page on this site).
    expect(file.headers['content-type']).toBe('application/octet-stream')
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="notes.txt"/)
    expect(file.headers['content-security-policy']).toContain('sandbox')
    const png = await upload(bob, id, 'A3', 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')
    expect(png.body.attachment.image).toBe(true)
    expect((await vic.request('GET', png.body.attachment.url)).headers['content-disposition']).toMatch(/^inline/)
    expect((await bob.ok('GET', `/api/boards/${id}`)).counts.attachments).toEqual({ A3: 2 })
  })

  it('refuses programs, files over the size limit, and anything over the owner’s space', async () => {
    const { ann, bob, id } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    expect((await upload(bob, id, 'A3', 'setup.exe', Buffer.from('MZ'))).body.error).toMatch(/Programs/)
    await ann.ok('PATCH', '/api/admin/storage/settings', { maxFileMb: 1, quotaMb: 1 })
    const big = await upload(bob, id, 'A3', 'big.bin', Buffer.alloc(1.5 * 1024 * 1024))
    expect(big).toMatchObject({ status: 413, body: { error: 'Files can be up to 1 MB.' } })
    const first = await upload(bob, id, 'A3', 'a.bin', Buffer.alloc(600 * 1024))
    expect(first.status).toBe(200)
    const second = await upload(bob, id, 'A3', 'b.bin', Buffer.alloc(600 * 1024))
    expect(second.status).toBe(413)
    expect(second.body.error).toMatch(/owner is out of file space/)
    expect((await upload(ann, id, 'A3', 'b.bin', Buffer.alloc(600 * 1024))).body.error).toMatch(/your 1 MB of file space.*connect your own storage/)
    // The trash doesn't count, and a trashed file can be restored.
    await bob.ok('DELETE', `/api/boards/${id}/attachments/${first.body.attachment.id}`)
    expect((await ann.ok('GET', '/api/account/storage')).used).toBe(0)
    expect((await upload(bob, id, 'A3', 'b.bin', Buffer.alloc(600 * 1024))).status).toBe(200)
    await bob.ok('POST', `/api/boards/${id}/attachments/${first.body.attachment.id}/restore`)
    expect((await bob.ok('GET', `/api/boards/${id}/tasks/A3/attachments`)).attachments).toHaveLength(2)
  })

  it('a board owner’s own bucket: files go there with no limit, and open through a signed link', async () => {
    const s3 = await fakeS3()
    try {
      const { ann, bob, id } = await team()
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      await ann.ok('PATCH', '/api/admin/storage/settings', { quotaMb: 0 })
      const saved = await ann.ok('PUT', '/api/account/storage/bucket', {
        endpoint: s3.endpoint,
        bucket: 'anns-files',
        accessKeyId: 'AKIDEXAMPLE',
        secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      })
      expect(saved).toMatchObject({ bucket: 'anns-files', keyHint: '…EKEY' })
      expect(JSON.stringify(saved)).not.toContain('wJalrXUtnFEMI')
      const r = await upload(bob, id, 'A3', 'plan.pdf', Buffer.from('%PDF'), 'application/pdf')
      expect(r.status).toBe(200) // quota is 0, but it's Ann's own storage
      expect([...s3.objects.keys()].some((k) => k.startsWith('/anns-files/boards/'))).toBe(true)
      const open = await bob.request('GET', r.body.attachment.url)
      expect(open.status).toBe(302)
      expect(open.headers.location).toMatch(/X-Amz-Signature=.*|X-Amz-Expires=300/)
      expect(open.headers.location).toContain('response-content-disposition=attachment')
    } finally {
      await s3.close()
    }
  })

  it('switching the site’s storage keeps old files opening from where they were saved', async () => {
    const s3 = await fakeS3()
    try {
      const { ann, bob, id } = await team()
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      const onDisk = await upload(bob, id, 'A3', 'old.txt', Buffer.from('old'))
      expect((await ann.ok('GET', '/api/admin/storage')).bucket).toBeNull()
      await ann.ok('PUT', '/api/admin/storage/bucket', { endpoint: s3.endpoint, bucket: 'site', accessKeyId: 'AK', secret: 'SECRET1234' })
      const inBucket = await upload(bob, id, 'A3', 'new.txt', Buffer.from('new'))
      expect([...s3.objects.keys()].some((k) => k.includes('new.txt'))).toBe(true)
      expect((await bob.request('GET', onDisk.body.attachment.url)).raw.toString()).toBe('old')
      expect((await bob.request('GET', inBucket.body.attachment.url)).status).toBe(302)
      // A bad key is caught by the test before anything is saved.
      const bad = await ann.request('PUT', '/api/admin/storage/bucket', {
        endpoint: 'http://127.0.0.1:1',
        bucket: 'x',
        accessKeyId: 'AK',
        secret: 'S',
      })
      expect(bad.body.error).toMatch(/storage test failed/)
      expect((await ann.ok('GET', '/api/admin/storage')).bucket).toMatchObject({ bucket: 'site' })
    } finally {
      await s3.close()
    }
  })

  it('files of a deleted card go to the trash, and come back if the card is restored', async () => {
    const { ann, bob, id } = await team()
    const r = await upload(bob, id, 'A3', 'x.txt', Buffer.from('x'))
    const start = (await ann.ok('GET', `/api/boards/${id}`)).data
    const del = await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.delete', id: 'A3' } })
    await tidyFiles(t.app)
    const [row] = await t.db.select().from(attachments).where(eq(attachments.id, r.body.attachment.id))
    expect(row).toMatchObject({ orphaned: true })
    expect(row.deletedAt).not.toBeNull()
    const { applyChanges, invertChanges } = await import('@kanbanto/model/changes')
    const now = applyChanges(start, del.changes)
    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'records.restore', changes: invertChanges(now, del.changes, new Date().toISOString()) },
    })
    expect((await ann.ok('GET', `/api/boards/${id}/tasks/A3/attachments`)).attachments).toHaveLength(1)
  })

  it('files in comments: viewers attach them to their own comments; they go with the comment', async () => {
    const { ann, bob, vic, id } = await team()
    // Viewers can't attach to the card itself, but can for a comment.
    expect((await upload(vic, id, 'A3', 'shot.png', Buffer.from('png'), 'image/png')).status).toBe(403)
    const draft = await upload(vic, id, 'A3', 'shot.png', Buffer.from('png'), 'image/png', true)
    expect(draft.status).toBe(200)
    // Not visible on the card until the comment is posted.
    expect((await ann.ok('GET', `/api/boards/${id}/tasks/A3/attachments`)).attachments).toEqual([])
    // Someone else can't attach Vic's upload to their comment.
    const bobs = await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'mine', attachments: [draft.body.attachment.id] })
    expect(bobs.comment.attachments).toEqual([])
    const { comment } = await vic.ok('POST', `/api/boards/${id}/tasks/A3/comments`, {
      body: 'See 📎shot.png',
      attachments: [draft.body.attachment.id],
    })
    expect(comment.attachments).toMatchObject([{ name: 'shot.png', commentId: comment.id, image: true }])
    // Listed with the card's files (for # references), marked as a comment's; not counted on the card's badge.
    expect((await ann.ok('GET', `/api/boards/${id}/tasks/A3/attachments`)).attachments).toMatchObject([{ name: 'shot.png', commentId: comment.id }])
    expect((await ann.ok('GET', `/api/boards/${id}`)).counts.attachments).toEqual({})
    // Deleting the comment takes its files with it.
    await ann.ok('DELETE', `/api/boards/${id}/comments/${comment.id}`)
    expect((await ann.ok('GET', `/api/boards/${id}/tasks/A3/attachments`)).attachments).toEqual([])
  })

  it('files uploaded for a comment that is never posted are removed after a day', async () => {
    const { vic, id } = await team()
    const draft = await upload(vic, id, 'A3', 'x.txt', Buffer.from('x'), 'text/plain', true)
    await tidyFiles(t.app)
    expect(await t.db.select().from(attachments).where(eq(attachments.id, draft.body.attachment.id))).toHaveLength(1)
    await t.db
      .update(attachments)
      .set({ createdAt: sql`now() - interval '2 days'` })
      .where(eq(attachments.id, draft.body.attachment.id))
    await tidyFiles(t.app)
    expect(await t.db.select().from(attachments).where(eq(attachments.id, draft.body.attachment.id))).toHaveLength(0)
  })

  it('people’s own storage must be on the public internet; the site’s may be anywhere', async () => {
    const s3 = await fakeS3()
    env.allowPrivateBuckets = false
    try {
      const ann = await Person.signUp(t.app, 'Ann')
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      const save = (endpoint: string) =>
        ann.request('PUT', '/api/account/storage/bucket', { endpoint, bucket: 'b', accessKeyId: 'AK', secret: 'SECRET1234' })
      expect((await save(s3.endpoint)).body.error).toMatch(/must start with https/)
      for (const endpoint of [
        'https://127.0.0.1:9',
        'https://[::1]',
        'https://169.254.169.254',
        'https://10.1.2.3',
        'https://[::ffff:127.0.0.1]',
        'https://localhost',
        'https://metadata.google.internal',
      ])
        expect((await save(endpoint)).body.error, endpoint).toMatch(/can’t be used.*public internet/)
      expect(s3.objects.size).toBe(0)
      // The site's storage (set by its admins) may be a MinIO on the local network.
      expect(
        (await ann.request('PUT', '/api/admin/storage/bucket', { endpoint: s3.endpoint, bucket: 'site', accessKeyId: 'AK', secret: 'SECRET1234' }))
          .status,
      ).toBe(200)
    } finally {
      env.allowPrivateBuckets = true
      await s3.close()
    }
  })

  it('a name that points somewhere private is refused when connecting, so changing DNS doesn’t get around it', async () => {
    const s3 = await fakeS3()
    try {
      // `localhost` stands in for any name whose address turns out to be private when it's looked up.
      const addresses = await new Promise<unknown>((resolve) => publicLookup('localhost', {}, (err, ...rest) => resolve(err ?? rest)))
      expect(addresses).toBeInstanceOf(PrivateAddressError)
      const port = new URL(s3.endpoint).port
      const res = await fetch(`http://localhost:${port}/x`, { dispatcher: publicOnly }).catch((e: Error) => e)
      expect((res as Error & { cause?: unknown }).cause).toBeInstanceOf(PrivateAddressError)
      expect(s3.objects.size).toBe(0)
      expect(isPublicAddress('1.1.1.1')).toBe(true)
      expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false)
      expect(isPublicAddress('64:ff9b::7f00:1')).toBe(false)
      expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
      // The old IPv4-compatible form (::a.b.c.d) counts as private too.
      expect(isPublicAddress('::127.0.0.1')).toBe(false)
      expect(isPublicAddress('::7f00:1')).toBe(false)
    } finally {
      await s3.close()
    }
  })

  it('storage that redirects somewhere else isn’t followed', async () => {
    const target = await fakeS3()
    const redirect = createServer((_req, res) => {
      res.writeHead(307, { location: `${target.endpoint}/stolen/key` })
      res.end()
    })
    await new Promise<void>((r) => redirect.listen(0, '127.0.0.1', r))
    try {
      const store = new S3Store({
        endpoint: `http://127.0.0.1:${(redirect.address() as { port: number }).port}`,
        region: 'auto',
        bucket: 'b',
        accessKeyId: 'AK',
        secret: 'S',
      })
      await expect(store.check()).rejects.toThrow(/answered 307/)
      expect(target.objects.size).toBe(0)
    } finally {
      await new Promise((r) => redirect.close(r))
      await target.close()
    }
  })

  it('uploads are checked before the file is read: who’s asking, and its declared size', async () => {
    const { vic, id } = await team()
    const anon = new Person(t.app)
    expect((await upload(anon, id, 'A3', 'x.txt', Buffer.from('x'))).status).toBe(401)
    // Without a declared size (streamed in chunks), there's no way to refuse a huge one up front.
    const chunked = await t.app.inject({
      method: 'POST',
      url: `/api/boards/${id}/tasks/A3/attachments`,
      headers: { cookie: vic.cookie, 'content-type': 'application/octet-stream', 'x-attach-to': 'comment', 'x-file-name': 'x.txt' },
      payload: Readable.from([Buffer.from('x')]),
    })
    expect(chunked.statusCode).toBe(411)
  })

  it('files waiting in unposted comments: a few per person, not counted until posted, and private to their uploader', async () => {
    const { ann, bob, vic, id } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/storage/settings', { maxFileMb: 1, quotaMb: 1 })
    const drafts = []
    for (let i = 0; i < 3; i++) drafts.push(await upload(vic, id, 'A3', `d${i}.bin`, Buffer.alloc(900 * 1024), 'application/octet-stream', true))
    expect(drafts.map((d) => d.status)).toEqual([200, 200, 200])
    // Three times the largest file is the most that can wait.
    expect(await upload(vic, id, 'A3', 'd3.bin', Buffer.alloc(900 * 1024), 'application/octet-stream', true)).toMatchObject({ status: 429 })
    // Waiting files don't use up Ann's space, and only Vic can open them.
    expect((await ann.ok('GET', '/api/account/storage')).used).toBe(0)
    expect((await bob.request('GET', drafts[0].body.attachment.url)).status).toBe(404)
    expect((await vic.request('GET', drafts[0].body.attachment.url)).status).toBe(200)
    // Posting counts them: one fits in Ann's 1 MB, a second doesn't.
    await vic.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'one', attachments: [drafts[0].body.attachment.id] })
    const over = await vic.request('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'two', attachments: [drafts[1].body.attachment.id] })
    expect(over).toMatchObject({ status: 413, body: { error: expect.stringMatching(/out of file space/) } })
  })

  it('deleting a board deletes its files', async () => {
    const { ann, bob, id } = await team()
    const r = await upload(bob, id, 'A3', 'x.txt', Buffer.from('x'))
    const [row] = await t.db.select().from(attachments).where(eq(attachments.id, r.body.attachment.id))
    const file = path.resolve(process.env.UPLOADS_DIR!, row.storageKey)
    expect(existsSync(file)).toBe(true)
    await ann.ok('DELETE', `/api/boards/${id}`)
    expect(existsSync(file)).toBe(false)
  })
})
