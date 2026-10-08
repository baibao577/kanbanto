import { AwsClient } from 'aws4fetch'
import { fetch as request } from 'undici'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { assertPublicEndpoint, PrivateAddressError, publicOnly } from './egress'

/** Where attachment bytes live. */
export interface ObjectStore {
  put(key: string, body: Buffer, mime: string): Promise<void>
  /** The file's bytes (to move it to other storage), or null if it isn't there. */
  get(key: string): Promise<Buffer | null>
  delete(key: string): Promise<void>
  /** The file as it comes, for passing on without holding all of it (`size`: when the storage says). Null if it isn't there. */
  open(key: string): Promise<{ stream: Readable; size: number | null } | null>
}

/** The server's own disk (a Docker volume in production). The server streams downloads itself. */
export class DiskStore implements ObjectStore {
  readonly root: string
  constructor(root: string) {
    this.root = path.resolve(root)
  }

  private file(key: string) {
    const f = path.resolve(this.root, key)
    // Keys are made by the server, but never let one point outside the folder.
    if (!f.startsWith(this.root + path.sep)) throw new Error('Bad storage key')
    return f
  }

  async put(key: string, body: Buffer) {
    const f = this.file(key)
    await mkdir(path.dirname(f), { recursive: true })
    await writeFile(f, body)
  }

  async get(key: string) {
    try {
      return await readFile(this.file(key))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true })
  }

  async open(key: string): Promise<{ stream: Readable; size: number } | null> {
    const f = this.file(key)
    try {
      const { size } = await stat(f)
      return { stream: createReadStream(f), size }
    } catch {
      return null
    }
  }
}

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secret: string
}

/** Why an S3 request failed, in words people can act on. */
export class StorageError extends Error {}

/**
 * Any S3-compatible bucket: Cloudflare R2, AWS S3, MinIO, Backblaze B2… Requests are signed with aws4fetch (small,
 * no AWS SDK). Downloads use short-lived signed links, so files never pass through the server twice.
 */
export class S3Store implements ObjectStore {
  private readonly client: AwsClient
  /** The bucket's address (endpoint/bucket): two stores with the same one hold the same files. */
  readonly base: string
  /** Someone's own storage: only public internet addresses (see egress.ts). The platform's isn't restricted. */
  private readonly publicOnly: boolean

  constructor(c: S3Config, opts: { publicOnly?: boolean } = {}) {
    this.client = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secret, service: 's3', region: c.region || 'auto' })
    // Path-style addressing (endpoint/bucket/key) works with R2, MinIO and S3 alike.
    this.base = `${c.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(c.bucket)}`
    this.publicOnly = !!opts.publicOnly
  }

  private url(key: string) {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  private async call(method: string, key: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}) {
    let res: Awaited<ReturnType<typeof request>>
    try {
      if (this.publicOnly) assertPublicEndpoint(this.base)
      const signed = await this.client.sign(this.url(key), { method, ...init })
      res = await request(signed.url, {
        method,
        headers: [...signed.headers.entries()],
        body: init.body,
        // Storage never needs to send us elsewhere; following would let it point the server anywhere.
        redirect: 'manual',
        dispatcher: this.publicOnly ? publicOnly : undefined,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      const cause = e instanceof PrivateAddressError ? e : (e as { cause?: unknown })?.cause
      if (cause instanceof PrivateAddressError)
        throw new StorageError(`That address can’t be used: ${cause.message}. Your own storage must be on the public internet.`)
      throw new StorageError(`Couldn’t reach the storage (${reasonOf(e)}). Check the endpoint address.`)
    }
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '')
      const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1]
      if (method === 'GET' && res.status === 404 && code !== 'NoSuchBucket') return null
      const why =
        code === 'NoSuchBucket'
          ? 'That bucket doesn’t exist.'
          : code === 'AuthorizationHeaderMalformed'
            ? // (A request signed for another region than the storage is set to: S3 and MinIO both say which they expect.)
              wrongRegion(text.match(/<Region>([^<]+)<\/Region>/)?.[1])
            : code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch' || res.status === 403
              ? 'The access key or secret isn’t right, or it can’t write to this bucket.'
              : `The storage answered ${res.status}${code ? ` (${code})` : ''}.`
      throw new StorageError(why)
    }
    return res
  }

  async put(key: string, body: Buffer, mime: string) {
    const res = await this.call('PUT', key, { body: new Uint8Array(body), headers: { 'content-type': mime } })
    await res?.body?.cancel()
  }

  async get(key: string) {
    const res = await this.call('GET', key)
    return res && Buffer.from(await res.arrayBuffer())
  }

  async delete(key: string) {
    const res = await this.call('DELETE', key)
    await res?.body?.cancel()
  }

  async open(key: string) {
    const res = await this.call('GET', key)
    if (!res?.body) return null
    const size = Number(res.headers.get('content-length'))
    return { stream: Readable.fromWeb(res.body), size: Number.isFinite(size) && size > 0 ? size : null }
  }

  /** A link that works for 5 minutes, telling the browser to show or download the file under its real name. */
  async signedUrl(key: string, opts: { name: string; mime: string; inline: boolean }) {
    const u = new URL(this.url(key))
    u.searchParams.set('X-Amz-Expires', '300')
    u.searchParams.set('response-content-disposition', contentDisposition(opts.name, opts.inline))
    u.searchParams.set('response-content-type', opts.mime)
    const signed = await this.client.sign(u.toString(), { method: 'GET', aws: { signQuery: true } })
    return signed.url
  }

  /** Checks the bucket works: writes a small file and removes it. */
  async check() {
    const key = `.kanbanto-check-${Date.now()}`
    await this.put(key, Buffer.from('ok'), 'text/plain')
    await this.delete(key)
  }
}

const wrongRegion = (expected: string | undefined) =>
  expected
    ? `The region isn’t right: this storage is set to “${expected}”. Put that in Region.`
    : 'The region isn’t right. Put the storage’s own region in Region.'

/** The most useful part of a network error: undici puts the real reason in `cause`. */
function reasonOf(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause
  if (cause?.code) return cause.code
  if (cause?.message) return cause.message
  return e instanceof Error ? e.message : 'network error'
}

/** `attachment; filename="…"` with the name made safe (and the full name for browsers that read filename*). */
export function contentDisposition(name: string, inline: boolean) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
