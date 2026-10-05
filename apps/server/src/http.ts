import type { z } from 'zod'
import { env } from './env'

/** An error with an HTTP status and a message that's safe (and meant) to show to the person. */
export class HttpError extends Error {
  readonly status: number
  /** A stable name the app can act on (e.g. 'verify-email' → show "confirm your email"). */
  readonly code?: string
  /** More for the app to show with it (sent beside `error` and `code`). */
  readonly details?: Record<string, unknown>
  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Checks a request body (or params) against a schema; a mismatch is a 400 with a readable reason. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  const issue = r.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  throw new HttpError(400, `${where}${issue?.message ?? 'Invalid request.'}`)
}

/**
 * The site's address, for links in emails. In production it's always APP_URL (checked at startup): links are never
 * built from request headers, which anyone can fake. In development, the address the request came to.
 */
export function siteUrl(req: { protocol: string; host: string }) {
  return env.appUrl ?? `${req.protocol}://${req.host}`.replace(/\/+$/, '')
}
