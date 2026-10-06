import { fetch, type Dispatcher } from 'undici'
import { HttpError } from '../http'
import { assertPublicEndpoint, PrivateAddressError, publicOnly } from './egress'

/**
 * Fetching a file from a web address somebody gave (an assistant attaching "the PDF at this link"). The server makes
 * the request, so the address is treated as hostile: https only, a public address only (checked on the address
 * actually connected to, as for people's own storage), no sign-in in it, redirects not followed (one could lead
 * anywhere), a limit on how long it may take and on how much is read, and nothing of the answer repeated in an error.
 */

const TIMEOUT_MS = 20_000
/** Downloads one person may have going at once, and may start in an hour. */
const AT_ONCE = 1
const PER_HOUR = 60

export interface Downloaded {
  bytes: Buffer
  /** The last step of the address's path, for a name when none was given. */
  name: string
}

/** Why an address can't be fetched (refused before any connection), or the address parsed. */
export function checkAddress(address: string): URL {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new HttpError(400, 'That isn’t a web address. It looks like https://example.com/report.pdf.')
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'Only https addresses can be fetched.')
  if (url.username || url.password) throw new HttpError(400, 'An address with a sign-in in it can’t be fetched.')
  try {
    assertPublicEndpoint(url.href)
  } catch (e) {
    throw new HttpError(400, privateSentence(e))
  }
  return url
}

const privateSentence = (e: unknown) =>
  `${e instanceof PrivateAddressError ? e.message.replace(/^./, (c) => c.toUpperCase()) : 'That address is on a private network'}: only public addresses can be fetched.`

const nameIn = (url: URL) => {
  try {
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
  } catch {
    return ''
  }
}

/**
 * Reads the file at `address`, up to `maxBytes` (more is refused, whether or not the other side said how big it is).
 * `opts` are for tests only: a server on this machine can't be reached through the public-only connection.
 */
export async function fetchFile(
  address: string,
  maxBytes: number,
  opts: { dispatcher?: Dispatcher; anyAddress?: boolean; timeoutMs?: number } = {},
): Promise<Downloaded> {
  const url = opts.anyAddress ? new URL(address) : checkAddress(address)
  const tooBig = () => new HttpError(413, `That file is bigger than the ${Math.floor(maxBytes / (1024 * 1024))} MB that can be fetched.`)
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      dispatcher: opts.anyAddress ? opts.dispatcher : (opts.dispatcher ?? publicOnly),
      signal,
      // (As it is stored on the other side: the size limit is about what arrives.)
      headers: { 'accept-encoding': 'identity', 'user-agent': 'Kanbanto-Files' },
    })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      throw new HttpError(400, 'That address sends you on to another one. Give the address of the file itself.')
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new HttpError(400, `That address answered ${res.status}, not a file.`)
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {})
      throw tooBig()
    }
    const reader = res.body?.getReader()
    if (!reader) throw new HttpError(400, 'That address answered with nothing.')
    const parts: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw tooBig()
        parts.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (!size) throw new HttpError(400, 'That address answered with nothing.')
    return { bytes: Buffer.concat(parts), name: nameIn(url) }
  } catch (e) {
    if (e instanceof HttpError) throw e
    const cause = e instanceof PrivateAddressError ? e : (e as { cause?: unknown })?.cause
    if (cause instanceof PrivateAddressError) throw new HttpError(400, privateSentence(cause))
    if (signal.aborted) throw new HttpError(504, `That address didn’t send the file within ${(opts.timeoutMs ?? TIMEOUT_MS) / 1000} seconds.`)
    throw new HttpError(502, 'That address couldn’t be reached.')
  }
}

const going = new Map<string, number>()
const started = new Map<string, number[]>()

/** The door every download goes through. `get` is replaced in tests (a real one only reaches public addresses). */
export const downloads = {
  get: fetchFile as (address: string, maxBytes: number) => Promise<Downloaded>,

  /** One person's download: one at a time, and so many an hour (each holds a whole file in memory, and makes the server call out). */
  async forPerson(userId: string, address: string, maxBytes: number): Promise<Downloaded> {
    const now = Date.now()
    const recent = (started.get(userId) ?? []).filter((at) => now - at < 3_600_000)
    if ((going.get(userId) ?? 0) >= AT_ONCE) throw new HttpError(429, 'A file is still being fetched for you. Wait for it to finish.')
    if (recent.length >= PER_HOUR) throw new HttpError(429, 'That’s a lot of files fetched in an hour. Try again later.')
    started.set(userId, [...recent, now])
    going.set(userId, (going.get(userId) ?? 0) + 1)
    try {
      return await this.get(address, maxBytes)
    } finally {
      const left = (going.get(userId) ?? 1) - 1
      if (left > 0) going.set(userId, left)
      else going.delete(userId)
    }
  },

  /** (Tests start from nothing.) */
  forget() {
    going.clear()
    started.clear()
  },
}
