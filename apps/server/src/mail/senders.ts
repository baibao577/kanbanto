import { decrypt } from '../crypto'
import type { emailSenders, SmtpSettings } from '../db/schema'
import type { Credentials } from './transport'

/** How one email account sends: the platform's (Platform console, or SMTP_URL on the server) or someone's own. */
export interface Sender {
  /** The row's id, or 'server' for the one set with SMTP_URL. */
  id: string
  userId: string | null
  provider: 'resend' | 'smtp'
  from: string
  /** What people see instead of the secret: re_…a1b2, or the SMTP server's address. */
  keyHint: string
  smtp: SmtpSettings | null
  failingSince: Date | null
  lastError: string | null
  updatedAt: Date
  /** Set on the server (SMTP_URL and SMTP_FROM), so it can't be changed in the console. */
  fromServer: boolean
  /** Decrypts the secret when it's needed to send. */
  credentials(): Credentials
}

export const smtpHint = (s: Pick<SmtpSettings, 'host' | 'port'>) => `${s.host}:${s.port}`

export function senderFromRow(row: typeof emailSenders.$inferSelect): Sender {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    from: row.fromAddress,
    keyHint: row.keyHint,
    smtp: row.smtp,
    failingSince: row.failingSince,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
    fromServer: false,
    credentials: () => {
      const secret = decrypt(row.apiKeyEncrypted)
      if (row.provider === 'resend') return { provider: 'resend', apiKey: secret }
      if (!row.smtp) throw new Error('SMTP settings are missing')
      return { provider: 'smtp', ...row.smtp, password: secret || null }
    },
  }
}

const DEFAULT_PORT = { tls: 465, starttls: 587, none: 25 } as const

/**
 * Reads SMTP_URL:
 *   smtp://user:password@smtp.example.com:587      STARTTLS (the default for smtp://)
 *   smtps://user:password@smtp.example.com:465     TLS from the start
 *   smtp://relay.internal:25?security=none         no encryption and no sign-in (internal relays)
 * Add `allow_self_signed=true` for a server with a self-signed certificate. Special characters in the username or
 * password must be URL-encoded (@ → %40).
 */
export function parseSmtpUrl(value: string): SmtpSettings & { password: string | null } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('SMTP_URL isn’t a valid address. Use smtp://user:password@smtp.example.com:587.')
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new Error('SMTP_URL must start with smtp:// or smtps://.')
  if (!url.hostname) throw new Error('SMTP_URL has no host name.')
  const security = url.searchParams.get('security') ?? (url.protocol === 'smtps:' ? 'tls' : 'starttls')
  if (security !== 'tls' && security !== 'starttls' && security !== 'none') throw new Error('SMTP_URL: security must be tls, starttls or none.')
  const flag = url.searchParams.get('allow_self_signed')
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORT[security],
    security,
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
    allowSelfSigned: flag === 'true' || flag === '1',
  }
}

/** The platform's sender from SMTP_URL and SMTP_FROM, if they're set. Throws with a readable reason if they're wrong. */
export function serverSender(env: { smtpUrl?: string; smtpFrom?: string }): Sender | null {
  if (!env.smtpUrl) return null
  const { password, ...smtp } = parseSmtpUrl(env.smtpUrl)
  if (!env.smtpFrom) throw new Error('SMTP_URL is set, but SMTP_FROM isn’t: set the sender, like SMTP_FROM="Kanbanto <noreply@example.com>".')
  return {
    id: 'server',
    userId: null,
    provider: 'smtp',
    from: env.smtpFrom,
    keyHint: smtpHint(smtp),
    smtp,
    failingSince: null,
    lastError: null,
    updatedAt: new Date(),
    fromServer: true,
    credentials: () => ({ provider: 'smtp', ...smtp, password }),
  }
}
