import nodemailer from 'nodemailer'
import type { SmtpSettings } from '../db/schema'

/** A finished email, ready for a provider. */
export interface OutgoingEmail {
  from: string
  to: string
  subject: string
  html: string
  text: string
}

/** What a transport needs to send: a Resend key, or an SMTP server and its password. */
export type Credentials = { provider: 'resend'; apiKey: string } | ({ provider: 'smtp'; password: string | null } & SmtpSettings)

/** Why a provider refused or failed to send. */
export class SendError extends Error {
  readonly status: number
  /** Retrying won't help (bad key or password, unverified domain, invalid address, untrusted certificate). */
  readonly permanent: boolean
  constructor(status: number, message: string, permanent = status === 400 || status === 401 || status === 403 || status === 422) {
    super(message)
    this.status = status
    this.permanent = permanent
  }
}

/** Something that delivers email: Resend or SMTP in production, the terminal in development, a list in tests. */
export interface Transport {
  send(credentials: Credentials, email: OutgoingEmail): Promise<{ id: string }>
}

/** Resend's HTTP API (no SDK needed). https://resend.com/docs/api-reference/emails/send-email */
async function sendWithResend(apiKey: string, email: OutgoingEmail) {
  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: email.from, to: [email.to], subject: email.subject, html: email.html, text: email.text }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new SendError(0, 'Couldn’t reach Resend.')
  }
  const json = (await res.json().catch(() => null)) as { id?: string; message?: string } | null
  if (!res.ok) throw new SendError(res.status, json?.message ?? `Resend answered ${res.status}.`)
  return { id: json?.id ?? '' }
}

/** An SMTP server: a company relay, Microsoft 365, Google Workspace, or any provider's SMTP. */
async function sendWithSmtp(c: Extract<Credentials, { provider: 'smtp' }>, email: OutgoingEmail) {
  const transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.security === 'tls',
    requireTLS: c.security === 'starttls',
    ignoreTLS: c.security === 'none',
    auth: c.username ? { user: c.username, pass: c.password ?? '' } : undefined,
    tls: c.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  })
  try {
    const info = await transporter.sendMail({ from: email.from, to: email.to, subject: email.subject, html: email.html, text: email.text })
    return { id: info.messageId ?? '' }
  } catch (e) {
    throw smtpError(e, c)
  } finally {
    transporter.close()
  }
}

/** Turns nodemailer's errors into a reason an admin can act on, and whether retrying could help. */
export function smtpError(e: unknown, c: Pick<SmtpSettings, 'host' | 'port'>): SendError {
  const err = (e ?? {}) as { code?: string; responseCode?: number; response?: string; message?: string }
  const said = (err.response ?? err.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const where = `${c.host}:${c.port}`
  const message = err.message ?? ''

  if (err.code === 'EAUTH' || err.responseCode === 535 || err.responseCode === 534 || err.responseCode === 530)
    return new SendError(401, `The mail server refused the username or password (${said}).`)
  if (/certificate|self[- ]signed|unable to verify|CERT_|altnames/i.test(message))
    return new SendError(
      0,
      `The mail server’s certificate isn’t trusted (${message}). If it’s an internal server, turn on “Allow a self-signed certificate”.`,
      true,
    )
  if (/wrong version number|ssl3_get_record|packet length too long|unknown protocol/i.test(message))
    return new SendError(
      0,
      `Couldn’t start an encrypted connection to ${where}. Check the encryption matches the port: TLS for 465, STARTTLS for 587.`,
      true,
    )
  if (/STARTTLS/i.test(message) && err.code === 'ETLS')
    return new SendError(0, `${where} doesn’t offer STARTTLS. Choose another encryption setting, or another port.`, true)
  if (err.code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(message))
    return new SendError(0, `Couldn’t find the mail server ${c.host}. Check the host name.`)
  if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || /ECONNREFUSED|ETIMEDOUT|ECONNRESET/.test(message))
    return new SendError(
      0,
      `Couldn’t connect to ${where} (${message || err.code}). Check the host and port. Some hosting providers block outgoing mail ports.`,
    )
  // The server answered with an error: 5xx is final (e.g. 550 relaying denied, 553 sender not allowed), 4xx is "try later".
  if (err.responseCode && err.responseCode >= 500) return new SendError(err.responseCode, `The mail server refused the email: ${said}`, true)
  if (err.responseCode && err.responseCode >= 400) return new SendError(err.responseCode, `The mail server said to try later: ${said}`, false)
  return new SendError(0, said || 'The email couldn’t be sent.')
}

/** Production: sends with whichever provider the credentials are for. */
export const providerTransport: Transport = {
  send: (c, email) => (c.provider === 'resend' ? sendWithResend(c.apiKey, email) : sendWithSmtp(c, email)),
}

/** Development: prints emails (with their links) to the terminal instead of sending them. Accepts any key. */
export function logTransport(print: (text: string) => void = console.log): Transport {
  let n = 0
  return {
    async send(_credentials, email) {
      print(
        [
          '',
          '──────── email (printed, not sent: MAIL_TRANSPORT=log) ────────',
          `From:    ${email.from}`,
          `To:      ${email.to}`,
          `Subject: ${email.subject}`,
          '',
          email.text,
          '────────────────────────────────────────────────────────────────',
        ].join('\n'),
      )
      return { id: `log-${++n}` }
    },
  }
}

/** Keeps emails in memory instead of sending them (tests). Set `fail` to make sends fail. */
export class MemoryTransport implements Transport {
  sent: (OutgoingEmail & { apiKey?: string; credentials: Credentials })[] = []
  fail: SendError | null = null

  async send(credentials: Credentials, email: OutgoingEmail) {
    if (this.fail) throw this.fail
    this.sent.push({ ...email, credentials, ...(credentials.provider === 'resend' && { apiKey: credentials.apiKey }) })
    return { id: `mem-${this.sent.length}` }
  }

  /** The last email sent to `to`. */
  last(to: string) {
    return [...this.sent].reverse().find((e) => e.to === to)
  }
}
