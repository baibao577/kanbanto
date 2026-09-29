/** An API error, with a message that's meant to be shown to the person. `status` is 0 when the server can't be reached. */
export class ApiError extends Error {
  readonly status: number
  /** A stable name for errors the app acts on, like 'verify-email'. */
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Fired when the server says you need to confirm your email first (the app then shows how). */
export const VERIFY_EVENT = 'kanbanto:verify-email'

/** How long a request may take before it counts as "can't reach the server" (and may be tried again). */
const TIMEOUT_MS = 30_000

/** Calls the server's JSON API (same origin; the session is a cookie). */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') throw new ApiError(0, 'The server took too long to answer. Try again in a moment.')
    throw new ApiError(0, 'Can’t reach the server. Check your connection and try again.')
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    if (json?.code === 'verify-email') window.dispatchEvent(new Event(VERIFY_EVENT))
    throw new ApiError(res.status, json?.error ?? `Something went wrong (${res.status}).`, json?.code)
  }
  return json as T
}

/** Fetches a page as text (e.g. an email preview). */
export async function apiText(path: string): Promise<string> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' })
  if (!res.ok) throw new ApiError(res.status, `Couldn’t load it (${res.status}).`)
  return res.text()
}

/** The message to show for anything thrown by `api`. */
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')
