import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { fetch } from 'undici'
import { attachments, storageBackends, users } from '../src/db/schema'
import { env } from '../src/env'
import { isPublicAddress, PrivateAddressError, publicLookup, publicOnly } from '../src/storage/egress'
import { S3Store } from '../src/storage/stores'
import { sendDigests } from '../src/mail/digest'
import { sendReminders } from '../src/reminders'
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

/** The storage page's data (the site's or a person's), once any move of files has ended. */
async function afterMove(p: Person, url: '/api/admin/storage' | '/api/account/storage') {
  for (;;) {
    const s = await p.ok('GET', url)
    if (!s.move?.running) return s
    await new Promise((r) => setTimeout(r, 10))
  }
}
const inBucket = (s3: { objects: Map<string, Buffer> }, bucket: string) =>
  [...s3.objects.keys()].filter((k) => k.startsWith(`/${bucket}/boards/`)).length
const fileRow = async (id: string) => (await t.db.select().from(attachments).where(eq(attachments.id, id)))[0]

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

  it('the morning summary: around 8:00 in each person’s time zone, once a day, only when there’s something, and it can be turned off', async () => {
    const { ann, bob, vic, id } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PUT', '/api/admin/email/sender', { apiKey: 're_platform_1234567890abcd', from: 'Kanbanto <noreply@kanbanto.example>' })
    await t.db.update(users).set({ emailVerifiedAt: new Date() })
    await ann.ok('PATCH', '/api/auth/me', { timeZone: 'Asia/Bangkok' })
    expect((await ann.request('PATCH', '/api/auth/me', { timeZone: 'Mars/Olympus' })).status).toBe(400)
    await vic.ok('PATCH', '/api/auth/me', { mentionEmails: false })
    const run = (command: object) => ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })

    // Thu 1 Oct 2026, 08:05 in Bangkok = 01:05 UTC. Ann: one due today, one overdue, a reminder at 15:00, a mention.
    const morning = new Date('2026-10-01T01:05:00Z')
    await run({ type: 'task.update', id: 'A3', fields: { assigneeId: ann.user.id, due: '2026-10-01' } })
    await run({ type: 'task.update', id: 'A1', fields: { assigneeId: ann.user.id, due: '2026-09-28', status: 'todo' } })
    await run({ type: 'task.update', id: 'B1', fields: { assigneeId: ann.user.id, reminders: [{ id: 'r', at: '2026-10-01T08:00:00Z' }] } })
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: '@Ann please review', mentions: [ann.user.id] })

    // Too early (07:30 there): nothing. Then the morning: one, once.
    expect(await sendDigests(t.app, new Date('2026-10-01T00:30:00Z'))).toBe(0)
    expect(await sendDigests(t.app, morning)).toBe(1)
    expect(await sendDigests(t.app, new Date('2026-10-01T02:00:00Z'))).toBe(0)
    await flushMail(t.app)
    const email = t.mail.last('ann@example.com')!
    expect(email.subject).toBe('Your day, Thu 1 Oct: 1 due today, 1 overdue, 1 reminder, 1 mention')
    expect(email.text).toContain('was due Mon 28 Sep')
    expect(email.text).toContain('15:00')
    expect(email.text).toContain('please review')
    // Bob has nothing (no time zone: UTC, so it's 01:05 for him anyway); Vic turned it off.
    expect(t.mail.last('bob@example.com')).toBeUndefined()
    expect(t.mail.last('vic@example.com')).toBeUndefined()
  })
})

describe('attachments', () => {
  it('editors attach files; everyone on the board can open them; viewers can’t attach', async () => {
    const { bob, vic, id } = await team()
    const r = await upload(bob, id, 'A3', 'notes.txt', Buffer.from('hello'), 'text/plain')
    expect(r.status).toBe(200)
    expect(r.body.attachment).toMatchObject({ name: 'notes.txt', size: 5, image: false, uploader: 'Bob' })
    expect((await upload(vic, id, 'A3', 'x.txt', Buffer.from('x'))).status).toBe(403)
    // The share dialog counts it (anyone with a public link could open it).
    expect((await vic.ok('GET', `/api/boards/${id}/sharing`)).fileCount).toBe(1)
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

  it('ordinary files (and a zipped program) are fine; only runnable names are refused', async () => {
    const { bob, id } = await team()
    for (const name of ['notes.json', 'report.pdf', 'tool.zip', 'script.js.txt', 'data.bin'])
      expect((await upload(bob, id, 'A3', name, Buffer.from('x'))).status, name).toBe(200)
  })

  it('refuses programs, files over the size limit, and anything over the owner’s space', async () => {
    const { ann, bob, id } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    for (const name of ['setup.exe', 'run.JS', 'install.sh', 'app.apk', 'Open me.lnk', 'fix.hta'])
      expect((await upload(bob, id, 'A3', name, Buffer.from('x'))).body.error, name).toMatch(/Programs and scripts/)
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

  it('going back to a bucket used before brings its setting back, with the keys given now', async () => {
    const s3 = await fakeS3()
    try {
      const { ann, bob, id } = await team()
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      const bucket = (name: string, more = {}) => ({ endpoint: s3.endpoint, bucket: name, accessKeyId: 'AK', secret: 'SECRET1234', ...more })
      const a = await ann.ok('PUT', '/api/admin/storage/bucket', bucket('a'))
      const first = await upload(bob, id, 'A3', 'first.txt', Buffer.from('1'))
      const b = await ann.ok('PUT', '/api/admin/storage/bucket', bucket('b'))
      await upload(bob, id, 'A3', 'second.txt', Buffer.from('22'))
      expect((await ann.ok('GET', '/api/admin/storage')).elsewhere).toMatchObject([
        { id: a.id, kind: 'bucket', bucket: { bucket: 'a' }, files: 1, bytes: 1 },
      ])
      // Back to A with new keys: the same setting, so the file from the first time opens with them too.
      const again = await ann.ok('PUT', '/api/admin/storage/bucket', bucket('a', { accessKeyId: 'AK2', secret: 'NEWSECRET99' }))
      expect(again).toMatchObject({ id: a.id, accessKeyId: 'AK2', keyHint: '…ET99' })
      expect(await t.db.select().from(storageBackends)).toHaveLength(2)
      expect((await bob.request('GET', first.body.attachment.url)).headers.location).toContain('Credential=AK2')
      expect((await ann.ok('GET', '/api/admin/storage')).elsewhere).toMatchObject([{ id: b.id, files: 1, bytes: 2 }])
      // "Use again": an earlier bucket's saved secret is used when the access key is the same.
      expect(await ann.ok('PUT', '/api/admin/storage/bucket', { endpoint: s3.endpoint, bucket: 'b', accessKeyId: 'AK' })).toMatchObject({ id: b.id })
      expect(
        (await ann.request('PUT', '/api/admin/storage/bucket', { endpoint: s3.endpoint, bucket: 'a', accessKeyId: 'OTHER' })).body.error,
      ).toMatch(/Paste the secret/)
      // The same bucket saved twice (from before settings were brought back) becomes one again.
      const [rowA] = await t.db.select().from(storageBackends).where(eq(storageBackends.id, a.id))
      const twin = '00000000-0000-4000-8000-000000000001'
      await t.db.insert(storageBackends).values({ ...rowA, id: twin, retiredAt: new Date() })
      await t.db.update(attachments).set({ backendId: twin }).where(eq(attachments.id, first.body.attachment.id))
      await ann.ok('PUT', '/api/admin/storage/bucket', bucket('a'))
      expect(await t.db.select().from(storageBackends)).toHaveLength(2)
      expect((await fileRow(first.body.attachment.id)).backendId).toBe(a.id)
    } finally {
      await s3.close()
    }
  })

  it('an earlier bucket can get new keys (tested first); only by whose bucket it is', async () => {
    const [old, now] = [await fakeS3(), await fakeS3()]
    let oldOpen = true
    try {
      const { ann, bob } = await team()
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      const a = await ann.ok('PUT', '/api/admin/storage/bucket', { endpoint: old.endpoint, bucket: 'a', accessKeyId: 'AK', secret: 'SECRET1234' })
      await ann.ok('PUT', '/api/admin/storage/bucket', { endpoint: now.endpoint, bucket: 'b', accessKeyId: 'AK', secret: 'SECRET1234' })
      const keys = { accessKeyId: 'ROTATED', secret: 'ROTATEDSECRET' }
      expect((await bob.request('PUT', `/api/admin/storage/buckets/${a.id}/keys`, keys)).status).toBe(403)
      expect((await ann.request('PUT', `/api/account/storage/buckets/${a.id}/keys`, keys)).status).toBe(404)
      expect(await ann.ok('PUT', `/api/admin/storage/buckets/${a.id}/keys`, keys)).toMatchObject({
        id: a.id,
        accessKeyId: 'ROTATED',
        keyHint: '…CRET',
      })
      // Still the earlier bucket: new files keep going to B.
      expect((await ann.ok('GET', '/api/admin/storage')).bucket).toMatchObject({ bucket: 'b' })
      await old.close()
      oldOpen = false
      const bad = await ann.request('PUT', `/api/admin/storage/buckets/${a.id}/keys`, { accessKeyId: 'X', secret: 'Y' })
      expect(bad.body.error).toMatch(/storage test failed/)
      expect((await t.db.select().from(storageBackends).where(eq(storageBackends.id, a.id)))[0].accessKeyId).toBe('ROTATED')
    } finally {
      if (oldOpen) await old.close()
      await now.close()
    }
  })

  it('the site’s files kept elsewhere move to the storage in use: disk to a bucket, bucket to bucket, and back to disk', async () => {
    const s3 = await fakeS3()
    try {
      const { ann, bob, id } = await team()
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      const old = await upload(bob, id, 'A3', 'old.txt', Buffer.from('old'))
      const onDisk = async () => existsSync(path.join(env.uploadsDir, (await fileRow(old.body.attachment.id)).storageKey))
      expect((await ann.ok('GET', '/api/admin/storage')).elsewhere).toEqual([])
      const site = await ann.ok('PUT', '/api/admin/storage/bucket', {
        endpoint: s3.endpoint,
        bucket: 'site',
        accessKeyId: 'AK',
        secret: 'SECRET1234',
      })
      expect((await ann.ok('GET', '/api/admin/storage')).elsewhere).toEqual([{ id: 'disk', kind: 'disk', bucket: null, files: 1, bytes: 3 }])
      expect((await bob.request('POST', '/api/admin/storage/move', { place: 'disk' })).status).toBe(403)
      expect((await ann.request('POST', '/api/admin/storage/move', { place: 'site' })).status).toBe(404)
      await ann.ok('POST', '/api/admin/storage/move', { place: 'disk' })
      let page = await afterMove(ann, '/api/admin/storage')
      expect(page).toMatchObject({ elsewhere: [], move: { running: false, total: 1, moved: 1, failed: 0 } })
      expect(await onDisk()).toBe(false)
      expect(inBucket(s3, 'site')).toBe(1)
      expect((await bob.request('GET', old.body.attachment.url)).status).toBe(302)

      // On to another bucket. A file that has gone missing is counted, and doesn't hold up the rest.
      const lost = await upload(bob, id, 'A3', 'lost.txt', Buffer.from('lost'))
      s3.objects.delete(`/site/${(await fileRow(lost.body.attachment.id)).storageKey}`)
      await ann.ok('PUT', '/api/admin/storage/bucket', { endpoint: s3.endpoint, bucket: 'site2', accessKeyId: 'AK', secret: 'SECRET1234' })
      await ann.ok('POST', '/api/admin/storage/move', { place: site.id })
      page = await afterMove(ann, '/api/admin/storage')
      expect(page.move).toMatchObject({ total: 2, moved: 1, failed: 1, lastError: expect.stringMatching(/isn’t in its storage/) })
      expect(page.elsewhere).toMatchObject([{ id: site.id, files: 1 }])
      expect([inBucket(s3, 'site'), inBucket(s3, 'site2')]).toEqual([0, 1])

      // And back to the server's disk.
      await ann.ok('DELETE', '/api/admin/storage/bucket')
      // The bucket replaced last comes first.
      const [site2] = (await ann.ok('GET', '/api/admin/storage')).elsewhere
      expect(site2).toMatchObject({ kind: 'bucket', bucket: { bucket: 'site2' }, files: 1 })
      await ann.ok('POST', '/api/admin/storage/move', { place: site2.id })
      await afterMove(ann, '/api/admin/storage')
      expect(await onDisk()).toBe(true)
      expect(inBucket(s3, 'site2')).toBe(0)
      expect((await bob.request('GET', old.body.attachment.url)).raw.toString()).toBe('old')
    } finally {
      await s3.close()
    }
  })

  it('a person moves their files into their own bucket, and back only as far as their space allows', async () => {
    const s3 = await fakeS3()
    try {
      const { ann, bob, id } = await team()
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      await ann.ok('PATCH', '/api/admin/storage/settings', { maxFileMb: 1, quotaMb: 1 })
      const big = await upload(bob, id, 'A3', 'a.bin', Buffer.alloc(600 * 1024))
      expect((await ann.ok('GET', '/api/account/storage')).elsewhere).toEqual([])
      const own = await ann.ok('PUT', '/api/account/storage/bucket', {
        endpoint: s3.endpoint,
        bucket: 'anns',
        accessKeyId: 'AK',
        secret: 'SECRET1234',
      })
      expect(await ann.ok('GET', '/api/account/storage')).toMatchObject({
        used: 600 * 1024,
        elsewhere: [{ id: 'site', kind: 'site', bucket: null, files: 1 }],
      })
      await ann.ok('POST', '/api/account/storage/move', { place: 'site' })
      expect(await afterMove(ann, '/api/account/storage')).toMatchObject({ used: 0, elsewhere: [], move: { moved: 1 } })
      expect(inBucket(s3, 'anns')).toBe(1)
      expect(await fileRow(big.body.attachment.id)).toMatchObject({ backend: 's3', backendId: own.id, ownStorage: true })
      // Her bucket is hers: it isn't among the site's places, and nobody else can move its files.
      expect((await ann.ok('GET', '/api/admin/storage')).elsewhere).toEqual([])

      // Without her bucket, new files use the site's storage again; the one in her bucket only fits if there's room.
      await ann.ok('DELETE', '/api/account/storage/bucket')
      const other = await upload(bob, id, 'A3', 'b.bin', Buffer.alloc(600 * 1024))
      expect((await ann.ok('GET', '/api/account/storage')).elsewhere).toMatchObject([{ id: own.id, kind: 'bucket', files: 1 }])
      expect((await bob.request('POST', '/api/account/storage/move', { place: own.id })).status).toBe(404)
      expect((await ann.request('POST', '/api/admin/storage/move', { place: own.id })).status).toBe(404)
      await ann.ok('POST', '/api/account/storage/move', { place: own.id })
      expect((await afterMove(ann, '/api/account/storage')).move).toMatchObject({ total: 1, moved: 0, noSpace: 1 })
      expect(inBucket(s3, 'anns')).toBe(1)
      await bob.ok('DELETE', `/api/boards/${id}/attachments/${other.body.attachment.id}`)
      await ann.ok('POST', '/api/account/storage/move', { place: own.id })
      expect(await afterMove(ann, '/api/account/storage')).toMatchObject({ used: 600 * 1024, elsewhere: [], move: { moved: 1, noSpace: 0 } })
      expect(inBucket(s3, 'anns')).toBe(0)
      expect((await bob.request('GET', big.body.attachment.url)).raw).toHaveLength(600 * 1024)
    } finally {
      await s3.close()
    }
  })

  it('an earlier bucket with no files left is forgotten (its keys too); one that still holds files stays', async () => {
    const s3 = await fakeS3()
    try {
      const { ann, bob, id } = await team()
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      const bucket = (name: string) => ({ endpoint: s3.endpoint, bucket: name, accessKeyId: 'AK', secret: 'SECRET1234' })
      const empty = await ann.ok('PUT', '/api/admin/storage/bucket', bucket('empty'))
      const used = await ann.ok('PUT', '/api/admin/storage/bucket', bucket('used'))
      await upload(bob, id, 'A3', 'x.txt', Buffer.from('x'))
      await ann.ok('PUT', '/api/admin/storage/bucket', bucket('now'))
      await tidyFiles(t.app)
      // Not straight away: an upload may still be on its way to a bucket that was just replaced.
      expect(await t.db.select().from(storageBackends)).toHaveLength(3)
      await t.db
        .update(storageBackends)
        .set({ retiredAt: sql`now() - interval '2 hours'` })
        .where(sql`retired_at is not null`)
      await tidyFiles(t.app)
      const left = (await t.db.select().from(storageBackends)).map((r) => r.id)
      expect(left).toContain(used.id)
      expect(left).not.toContain(empty.id)
      expect(left).toHaveLength(2)
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

describe('moving a task to another board', () => {
  it('takes its subtasks, comments and files; both boards must be yours to edit', async () => {
    const { ann, bob, vic, id } = await team()
    const { id: home } = await ann.ok('POST', '/api/boards', { name: 'Home' })
    await upload(bob, id, 'A2', 'plan.txt', Buffer.from('plan'), 'text/plain')
    await bob.ok('POST', `/api/boards/${id}/tasks/A2a/comments`, { body: '@Ann first draft', mentions: [ann.user.id] })

    // Bob can edit the first board but can't open Home; Vic only views the first one.
    expect((await bob.request('POST', `/api/boards/${id}/tasks/A2/move`, { boardId: home })).status).toBe(404)
    expect((await vic.request('POST', `/api/boards/${id}/tasks/A2/move`, { boardId: home })).status).toBe(403)

    const moved = await ann.ok('POST', `/api/boards/${id}/tasks/A2/move`, { boardId: home })
    expect(moved).toMatchObject({ board: { id: home, name: 'Home' }, summary: { subtasks: 2 } })
    const before = (await ann.ok('GET', `/api/boards/${id}`)).data
    expect(before.tasks.A2).toBeUndefined()
    expect(before.tasks.A2a).toBeUndefined()

    const after = await ann.ok('GET', `/api/boards/${home}`)
    const root = after.data.tasks[moved.id]
    expect(root.parentId).toBe(null)
    expect(Object.values(after.data.tasks).filter((x) => (x as { parentId: string }).parentId === moved.id)).toHaveLength(2)
    expect(after.counts.attachments).toEqual({ [moved.id]: 1 })
    const kidId = Object.keys(after.counts.comments)[0]
    expect(after.data.tasks[kidId].parentId).toBe(moved.id)
    const { comments } = await ann.ok('GET', `/api/boards/${home}/tasks/${kidId}/comments`)
    expect(comments.map((c: { body: string }) => c.body)).toEqual(['@Ann first draft'])
    const [mention] = (await ann.ok('GET', '/api/notifications')).notifications
    expect(mention).toMatchObject({ board: { id: home }, task: { id: kidId } })

    // Both logs say it moved, without naming the other board.
    const log = async (b: string) =>
      (await ann.ok('GET', `/api/boards/${b}/activity`)).activity.map((e: { items?: { text: string }[] }) => e.items?.[0]?.text)
    expect((await log(id))[0]).toMatch(/^moved “.+” with 2 subtasks to another board$/)
    expect((await log(home))[0]).toMatch(/here from another board$/)
    // A move to the same board is refused.
    expect((await ann.request('POST', `/api/boards/${home}/tasks/${moved.id}/move`, { boardId: home })).status).toBe(422)
  })
})

describe('reminders', () => {
  it('go off once, to whoever is assigned (bell and email), follow the due date, and wait while archived', async () => {
    const { ann, bob, vic, id } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PUT', '/api/admin/email/sender', { apiKey: 're_platform_1234567890abcd', from: 'Kanbanto <noreply@kanbanto.example>' })
    await t.db.update(users).set({ emailVerifiedAt: new Date() })
    await vic.ok('PATCH', '/api/auth/me', { reminderEmails: false })
    const run = (command: object) => ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
    const now = Date.now()
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

    // Assigned to Bob, set by Ann, a minute ago: Bob gets it (not Ann), once.
    await run({
      type: 'task.update',
      id: 'A3',
      fields: { assigneeId: bob.user.id, reminders: [{ id: 'r1', at: iso(now - 60_000), by: ann.user.id }] },
    })
    expect(await sendReminders(t.app)).toBe(1)
    expect(await sendReminders(t.app)).toBe(0)
    const [n] = (await bob.ok('GET', '/api/notifications')).notifications
    expect(n).toMatchObject({ kind: 'reminder', actor: 'Ann', task: { id: 'A3' } })
    expect((await ann.ok('GET', '/api/notifications')).notifications.some((x: { kind: string }) => x.kind === 'reminder')).toBe(false)
    await flushMail(t.app)
    expect(t.mail.last('bob@example.com')?.subject).toMatch(/^Reminder: /)

    // Nobody assigned: it goes to whoever set it; Vic turned emails off, so only the bell.
    await run({ type: 'task.update', id: 'A1', fields: { assigneeId: null, reminders: [{ id: 'r2', at: iso(now - 60_000), by: vic.user.id }] } })
    // (Vic can only view, but that's enough to be reminded.)
    expect(await sendReminders(t.app)).toBe(1)
    expect((await vic.ok('GET', '/api/notifications')).notifications[0]).toMatchObject({ kind: 'reminder', task: { id: 'A1' } })
    await flushMail(t.app)
    expect(t.mail.last('vic@example.com')).toBeUndefined()

    // "An hour before it's due": moving the due date moves it; archived cards wait.
    await run({
      type: 'task.update',
      id: 'A2a',
      fields: { assigneeId: bob.user.id, due: iso(now + 3 * 3_600_000), reminders: [{ id: 'r3', beforeDue: 60 }] },
    })
    expect(await sendReminders(t.app)).toBe(0)
    await run({ type: 'task.update', id: 'A2a', fields: { due: iso(now + 30 * 60_000) } })
    await run({ type: 'task.archive', id: 'A2' })
    expect(await sendReminders(t.app)).toBe(0)
    await run({ type: 'task.restore', id: 'A2' })
    expect(await sendReminders(t.app)).toBe(1)
  })
})

describe('desktop notifications', () => {
  it('reach the browsers people turned them on in, for reminders and mentions (if they want), and forget gone ones', async () => {
    const { ann, bob, id } = await team()
    const sent: { endpoint: string; body: { title: string; url: string } }[] = []
    let gone = false
    t.app.push.transport = async (sub, payload) => {
      if (gone) throw Object.assign(new Error('Gone'), { statusCode: 410 })
      sent.push({ endpoint: sub.endpoint, body: JSON.parse(payload) })
    }
    const sub = { endpoint: 'https://push.example.com/ann-1', keys: { p256dh: 'BPk', auth: 'aa' }, label: 'Chrome on Mac' }
    expect((await ann.ok('GET', '/api/push/key')).publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    await ann.ok('POST', '/api/push/devices', sub)
    await ann.ok('POST', '/api/push/devices', sub) // the same browser again: still one
    expect((await ann.ok('GET', '/api/push/devices')).devices).toMatchObject([{ label: 'Chrome on Mac' }])
    expect((await ann.request('POST', '/api/push/devices', { ...sub, endpoint: 'http://evil.example/x' })).status).toBe(400)

    expect(await ann.ok('POST', '/api/push/test')).toEqual({ sent: 1 })
    // A mention, and a reminder.
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: '@Ann look', mentions: [ann.user.id] })
    await new Promise((r) => setTimeout(r, 100))
    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: {
        type: 'task.update',
        id: 'A3',
        fields: { assigneeId: ann.user.id, reminders: [{ id: 'r', at: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z') }] },
      },
    })
    await sendReminders(t.app)
    expect(sent.map((s) => s.body.title)).toEqual(['Desktop notifications work', 'Bob mentioned you', expect.stringMatching(/^⏰ /)])
    expect(sent[2].body.url).toBe(`/#/b/${id}?task=A3`)

    // Mentions switched off: no push for them.
    await ann.ok('PATCH', '/api/auth/me', { pushMentions: false })
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: '@Ann again', mentions: [ann.user.id] })
    await new Promise((r) => setTimeout(r, 100))
    expect(sent).toHaveLength(3)
    // The browser unsubscribed: it's forgotten.
    gone = true
    await ann.ok('POST', '/api/push/test')
    expect((await ann.ok('GET', '/api/push/devices')).devices).toEqual([])
  })
})
