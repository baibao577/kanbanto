/**
 * A failed database query carries its SQL and values, which can be people's board text or email addresses. These keep
 * that out of the logs, and tell apart the database refusing the data itself.
 */

const causeOf = (err: unknown) => (err as { cause?: unknown } | null)?.cause

/** The PostgreSQL error code (SQLSTATE) behind an error, if it came from the database. */
export function dbErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = causeOf(e), depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
  }
  return undefined
}

/** An error as it can go in the logs: a failed query is logged with the database's reason, not its SQL and values. */
export function loggable(err: unknown): unknown {
  if (!(err instanceof Error) || !('query' in err) || !('params' in err)) return err
  const cause = err.cause instanceof Error ? err.cause : null
  return { type: 'DatabaseError', message: cause?.message ?? 'A database query failed.', code: dbErrorCode(err), stack: cause?.stack }
}
