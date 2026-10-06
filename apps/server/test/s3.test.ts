import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { S3Store, StorageError } from '../src/storage/stores'

/** What a failed request says, as the person setting up storage reads it. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'worked',
    (e: unknown) => (e instanceof StorageError ? e.message : `not a storage error: ${String(e)}`),
  )

describe('what an S3-compatible storage’s refusals are turned into', () => {
  let server: Server
  let endpoint: string
  beforeAll(async () => {
    // Answers the way S3 and MinIO do, going by the bucket's name.
    const error = (code: string, more = '') =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>…</Message>${more}</Error>`
    server = createServer((req, res) => {
      req.resume()
      const bucket = req.url!.split('/')[1]
      if (bucket === 'region-said') return res.writeHead(400).end(error('AuthorizationHeaderMalformed', '<Region>eu-central-1</Region>'))
      if (bucket === 'region-unsaid') return res.writeHead(400).end(error('AuthorizationHeaderMalformed'))
      if (bucket === 'missing') return res.writeHead(404).end(error('NoSuchBucket'))
      if (bucket === 'bad-key') return res.writeHead(403).end(error('InvalidAccessKeyId'))
      if (bucket === 'bad-secret') return res.writeHead(403).end(error('SignatureDoesNotMatch'))
      if (bucket === 'odd') return res.writeHead(503).end(error('SlowDown'))
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(async () => new Promise((r) => server.close(r)))
  const store = (bucket: string) => new S3Store({ endpoint, region: 'auto', bucket, accessKeyId: 'key', secret: 'secret' })

  it('a wrong region says which one the storage is set to', async () => {
    expect(await refusal(store('region-said').check())).toBe('The region isn’t right: this storage is set to “eu-central-1”. Put that in Region.')
    expect(await refusal(store('region-unsaid').check())).toBe('The region isn’t right. Put the storage’s own region in Region.')
  })

  it('a missing bucket, wrong keys and anything else each say so', async () => {
    expect(await refusal(store('missing').check())).toBe('That bucket doesn’t exist.')
    expect(await refusal(store('bad-key').check())).toBe('The access key or secret isn’t right, or it can’t write to this bucket.')
    expect(await refusal(store('bad-secret').check())).toBe('The access key or secret isn’t right, or it can’t write to this bucket.')
    expect(await refusal(store('odd').check())).toBe('The storage answered 503 (SlowDown).')
    expect(await refusal(store('fine').check())).toBe('worked')
    expect(
      await refusal(new S3Store({ endpoint: 'http://127.0.0.1:1', region: 'auto', bucket: 'b', accessKeyId: 'k', secret: 's' }).check()),
    ).toMatch(/^Couldn’t reach the storage \(.+\)\. Check the endpoint address\.$/)
  })
})

/**
 * Against a real S3-compatible storage (a MinIO, an R2 bucket): only when asked, since the usual tests stand in for
 * one with a server that doesn't check signatures. The bucket has to exist; what's written is removed again.
 *
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_BUCKET=kanbanto-test S3_TEST_KEY=… S3_TEST_SECRET=… \
 *     pnpm --filter @kanbanto/server exec vitest run test/s3.test.ts
 *
 * S3_TEST_REGION: the storage's region, when it has one (left out: "auto", as when the Region box is left empty).
 */
const real = process.env.S3_TEST_ENDPOINT
describe.skipIf(!real)('a real S3-compatible storage', () => {
  const config = {
    endpoint: real ?? '',
    region: process.env.S3_TEST_REGION || 'auto',
    bucket: process.env.S3_TEST_BUCKET ?? '',
    accessKeyId: process.env.S3_TEST_KEY ?? '',
    secret: process.env.S3_TEST_SECRET ?? '',
  }
  const store = new S3Store(config)
  const key = `boards/test/${Date.now()}/ภาพ หน้าจอ (1).png`
  const bytes = Buffer.from('not really a picture')

  it('passes the check "Test and save" makes', async () => {
    expect(await refusal(store.check())).toBe('worked')
  })

  it('keeps a file, gives it back, signs a link that opens it under its name, and deletes it', async () => {
    await store.put(key, bytes, 'image/png')
    expect((await store.get(key))?.equals(bytes)).toBe(true)
    const link = await store.signedUrl(key, { name: 'ภาพ หน้าจอ (1).png', mime: 'image/png', inline: true })
    const opened = await fetch(link)
    expect(opened.status).toBe(200)
    expect(Buffer.from(await opened.arrayBuffer()).equals(bytes)).toBe(true)
    expect(opened.headers.get('content-type')).toBe('image/png')
    expect(opened.headers.get('content-disposition')).toMatch(/^inline; filename=/)
    // Without its signature the link opens nothing.
    expect((await fetch(link.split('?')[0])).status).toBe(403)
    await store.delete(key)
    expect(await store.get(key)).toBeNull()
    // (Deleting what's already gone isn't an error.)
    await store.delete(key)
  })

  it('says so when the keys, the bucket or the region are wrong', async () => {
    expect(await refusal(new S3Store({ ...config, secret: 'not-the-secret' }).check())).toBe(
      'The access key or secret isn’t right, or it can’t write to this bucket.',
    )
    expect(await refusal(new S3Store({ ...config, bucket: `no-such-bucket-${Date.now()}` }).check())).toBe('That bucket doesn’t exist.')
  })
})
