/**
 * TRUST_PROXY: which proxies to believe about the client's address and protocol (X-Forwarded-For/-Proto/-Host).
 * Unset or false: none (Kanbanto faces the network directly). A number: that many proxies in front (the HTTPS add-on
 * and a single nginx are 1). Or the proxies' addresses: 10.0.0.2,172.16.0.0/12. Never `true` by default: then
 * anyone could claim any address, dodging rate limits.
 */
function trustProxy(value: string | undefined): boolean | number | string {
  const v = value?.trim()
  if (!v || v === 'false' || v === '0') return false
  if (v === 'true') return true
  if (/^\d+$/.test(v)) return Number(v)
  return v
}

/** Settings from the environment, checked once at startup. */
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://kankan:kankan@localhost:5433/kankan',
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  production: process.env.NODE_ENV === 'production',
  test: process.env.NODE_ENV === 'test',
  /** Folder of the built web app to serve (production). Unset in development, where Vite serves it. */
  webDist: process.env.WEB_DIST,
  /**
   * Master key that encrypts stored secrets (email keys, mail server and storage passwords): 32 bytes, base64. Kept
   * out of the database on purpose, so a copy of the database alone can't reveal them. Optional: without it, a key
   * is made on first start and kept in `keyFile` (see src/crypto.ts).
   */
  encryptionKey: process.env.ENCRYPTION_KEY || undefined,
  /** Where the generated master key is kept (a Docker volume in production). */
  keyFile: process.env.KEY_FILE ?? './data/config/encryption.key',
  /**
   * The address people use to open Kanbanto (https://kanbanto.example.com), for links in emails. Required in
   * production: links are never built from request headers, which anyone can fake.
   */
  appUrl: process.env.APP_URL?.trim().replace(/\/+$/, '') || undefined,
  trustProxy: trustProxy(process.env.TRUST_PROXY),
  /**
   * People's own storage must be a public https address (so nobody can make the server reach its private network).
   * Development and tests may use a bucket on this machine (MinIO, a fake S3) with ALLOW_PRIVATE_BUCKETS=true.
   */
  allowPrivateBuckets: process.env.ALLOW_PRIVATE_BUCKETS === 'true',
  /** 'json': one JSON object per line (for log collectors). Default: short readable lines. */
  logFormat: process.env.LOG_FORMAT === 'json' ? ('json' as const) : ('pretty' as const),
  /** Folder for attachments kept on the server's disk (a Docker volume in production). */
  uploadsDir: process.env.UPLOADS_DIR ?? './data/uploads',
  /**
   * The site's email through an SMTP server, set here instead of in the Platform console (smtp://user:pass@host:587,
   * see src/mail/senders.ts). SMTP_FROM is the sender. When set, it replaces the console's setting.
   */
  smtpUrl: process.env.SMTP_URL || undefined,
  smtpFrom: process.env.SMTP_FROM || undefined,
  /**
   * A folder of the site's own pages (an about page, a privacy policy, terms), served next to the app: see
   * src/pages.ts. The Docker image looks in /app/pages, filled from a `pages` folder beside the Dockerfile.
   */
  pagesDir: process.env.PAGES_DIR || undefined,
  /** 'log' prints emails to the terminal instead of sending them (development). Default: send them. */
  mailTransport: process.env.MAIL_TRANSPORT === 'log' ? ('log' as const) : ('resend' as const),
}
