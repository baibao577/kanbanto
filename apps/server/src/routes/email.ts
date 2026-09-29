import { newId } from '@kanbanto/model/ids'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { SessionUser } from '../auth/sessions'
import { encrypt, encryptionReady, keyHint } from '../crypto'
import { SETTING_DEFAULTS } from '../db/defaults'
import { EMAIL_KINDS, emailSenders, siteSettings, users, type SmtpSettings } from '../db/schema'
import { HttpError, parse, siteUrl } from '../http'
import { getBrand } from '../mail/mailer'
import { emails, renderEmail, sampleEmail } from '../mail/templates'
import { senderFromRow, smtpHint, type Sender } from '../mail/senders'
import { SendError, type Credentials } from '../mail/transport'
import { loadSettings } from '../settings'
import { requireUser } from './auth'

/**
 * Email settings: how the platform sends (Platform console: Resend or an SMTP server) and people's own Resend keys
 * (Account settings → Email sending). Secrets are write-only: they're tested, encrypted and stored, and only a hint
 * (re_…a1b2, or the SMTP server's address) ever comes back.
 */

const from = z
  .string()
  .trim()
  .max(200)
  .regex(/^(?:[^<>@]+<\s*[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+\s*>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/, {
    message: 'Enter a sender like “Kanbanto <noreply@yourdomain.com>”.',
  })
const SaveResend = z.object({
  provider: z.literal('resend'),
  /** Leave out to keep the saved key (e.g. when only the sender changes). */
  apiKey: z.string().trim().min(8, 'Paste your Resend API key.').max(300).optional(),
  from,
})
const SaveSmtp = z.object({
  provider: z.literal('smtp'),
  host: z
    .string()
    .trim()
    .min(1, 'Enter the mail server’s host name.')
    .max(253)
    .regex(/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i, 'Enter a host name like smtp.example.com.'),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'none']),
  /** Empty: the server doesn't ask for a sign-in. */
  username: z.string().trim().max(320).optional(),
  /** Leave out to keep the saved password. */
  password: z.string().max(500).optional(),
  allowSelfSigned: z.boolean().default(false),
  from,
})
/** Without `provider`, it's Resend (what the API took before SMTP). */
const withProvider = (b: unknown) => (b && typeof b === 'object' && !('provider' in b) ? { ...b, provider: 'resend' } : b)
const SavePlatformSender = z.preprocess(withProvider, z.discriminatedUnion('provider', [SaveResend, SaveSmtp]))
/** People's own keys are Resend only: an SMTP server would let anyone make the server connect anywhere. */
const SaveOwnSender = z.preprocess(withProvider, SaveResend)
type SaveSender = z.infer<typeof SavePlatformSender>

/** The limits' defaults (they suit Resend's free plan). */
const DEFAULT_LIMITS = {
  emailDailyBudget: SETTING_DEFAULTS.emailDailyBudget,
  emailMonthlyBudget: SETTING_DEFAULTS.emailMonthlyBudget,
  userMonthlyAllowance: SETTING_DEFAULTS.userMonthlyAllowance,
}

/** Resend's shared test domain only delivers to the Resend account's own address. */
const testingOnly = (address: string) => /@resend\.dev>?\s*$/i.test(address)

const senderView = (s: Sender | null) =>
  s && {
    provider: s.provider,
    keyHint: s.keyHint,
    from: s.from,
    working: !s.failingSince,
    lastError: s.lastError,
    testingOnly: s.provider === 'resend' && testingOnly(s.from),
    smtp: s.smtp,
    fromServer: s.fromServer,
    updatedAt: s.updatedAt.toISOString(),
  }

/** What a save will send with: the new secret, or the saved one when it's left out. */
function credentialsFor(
  body: SaveSender,
  existing: Sender | null,
): { credentials: Credentials; smtp: SmtpSettings | null; secret: string; hint: string } {
  const saved = existing?.provider === body.provider ? existing.credentials() : null
  if (body.provider === 'resend') {
    const apiKey = body.apiKey ?? (saved?.provider === 'resend' ? saved.apiKey : null)
    if (!apiKey) throw new HttpError(400, 'Paste your Resend API key.')
    return { credentials: { provider: 'resend', apiKey }, smtp: null, secret: apiKey, hint: keyHint(apiKey) }
  }
  const username = body.username || null
  const password = !username ? null : body.password !== undefined ? body.password || null : saved?.provider === 'smtp' ? saved.password : null
  const smtp: SmtpSettings = { host: body.host, port: body.port, security: body.security, username, allowSelfSigned: body.allowSelfSigned }
  return { credentials: { provider: 'smtp', ...smtp, password }, smtp, secret: password ?? '', hint: smtpHint(smtp) }
}

/**
 * Tests a key by sending a test email to the person saving it, then stores it encrypted. Nothing is saved if the
 * test fails; the provider's reason is shown (e.g. an unverified domain).
 */
async function saveSender(app: FastifyInstance, me: SessionUser, owner: string | null, body: SaveSender, site: string) {
  if (!owner && app.mail.serverSender) throw new HttpError(409, SET_ON_SERVER)
  if (!encryptionReady()) throw new HttpError(503, 'Keys can’t be saved until the server has an encryption key. Restart Kanbanto to make one.')
  const existing = await app.mail.senderFor(owner)
  const { credentials, smtp, secret, hint } = credentialsFor(body, existing)
  const brand = await getBrand(app.db)
  const test = await renderEmail(brand, emails.test(brand, { from: body.from, to: me.email, site }))
  try {
    await app.mail.transport.send(credentials, { from: body.from, to: me.email, ...test })
  } catch (e) {
    const reason = e instanceof SendError ? e.message : 'The test email couldn’t be sent.'
    if (body.provider === 'smtp') throw new HttpError(400, `The test email couldn’t be sent. ${reason}`)
    const tip = /domain/i.test(reason) ? ' Check that the sender’s domain is verified in Resend (resend.com/domains).' : ''
    throw new HttpError(400, `Resend refused the test email: ${reason}${tip}`)
  }
  const values = {
    provider: body.provider,
    apiKeyEncrypted: encrypt(secret),
    keyHint: hint,
    smtp,
    fromAddress: body.from,
    lastError: null,
    failingSince: null,
    updatedBy: me.id,
    updatedAt: new Date(),
  }
  const [row] = existing
    ? await app.db.update(emailSenders).set(values).where(eq(emailSenders.id, existing.id)).returning()
    : await app.db
        .insert(emailSenders)
        .values({ id: newId(), userId: owner, ...values })
        .returning()
  // Moving the site to its own mail server: the limits were only there for Resend's free plan, so they come off
  // (unless someone already changed them).
  if (!owner && body.provider === 'smtp' && existing?.provider !== 'smtp') {
    const s = await loadSettings(app.db)
    const untouched = Object.entries(DEFAULT_LIMITS).every(([k, v]) => s[k as keyof typeof DEFAULT_LIMITS] === v)
    const off = { emailDailyBudget: null, emailMonthlyBudget: null, userMonthlyAllowance: null }
    if (untouched)
      await app.db
        .insert(siteSettings)
        .values({ id: 1, ...off })
        .onConflictDoUpdate({ target: siteSettings.id, set: off })
  }
  await app.mail.refresh()
  return senderView(senderFromRow(row))
}

const SET_ON_SERVER = 'Email is set on the server (SMTP_URL and SMTP_FROM). Change it there, then restart Kanbanto.'

async function removeSender(app: FastifyInstance, owner: string | null) {
  if (!owner && app.mail.serverSender) throw new HttpError(409, SET_ON_SERVER)
  await app.db.delete(emailSenders).where(owner ? eq(emailSenders.userId, owner) : isNull(emailSenders.userId))
  await app.mail.refresh()
}

const Settings = z
  .object({
    /** Null: no limit. */
    dailyBudget: z.number().int().min(0).max(1_000_000).nullable(),
    monthlyBudget: z.number().int().min(0).max(10_000_000).nullable(),
    userAllowance: z.number().int().min(0).max(100_000).nullable(),
    brandName: z.string().trim().min(1).max(60),
    brandColor: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a colour like #3b5bdb.'),
    footer: z.string().max(500),
  })
  .partial()

export const emailRoutes: FastifyPluginAsync = async (app) => {
  // ── Platform (platform admins) ──────────────────────────────────────────
  const admin = (user: SessionUser | null) => {
    const me = requireUser(user)
    if (!me.isAdmin) throw new HttpError(403, 'Only platform admins can do that.')
    return me
  }

  app.get('/admin/email', async (req) => {
    admin(req.user)
    const s = await loadSettings(app.db)
    const [{ n }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailSenders)
      .where(isNotNull(emailSenders.userId))
    const [{ unconfirmed }] = await app.db
      .select({ unconfirmed: sql<number>`count(*)::int` })
      .from(users)
      .where(and(isNull(users.emailVerifiedAt), eq(users.isAdmin, false), isNull(users.disabledAt)))
    return {
      encryptionReady: encryptionReady(),
      sender: senderView(await app.mail.senderFor(null)),
      settings: {
        dailyBudget: s.emailDailyBudget,
        monthlyBudget: s.emailMonthlyBudget,
        userAllowance: s.userMonthlyAllowance,
        brandName: s.brandName,
        brandColor: s.brandColor,
        footer: s.emailFooter,
      },
      usage: await app.mail.usage(),
      ownKeys: n,
      unconfirmed,
    }
  })

  app.put('/admin/email/sender', async (req) => saveSender(app, admin(req.user), null, parse(SavePlatformSender, req.body), siteUrl(req)))
  app.delete('/admin/email/sender', async (req) => {
    admin(req.user)
    await removeSender(app, null)
    return { ok: true }
  })

  app.patch('/admin/email/settings', async (req) => {
    admin(req.user)
    const b = parse(Settings, req.body)
    const set = {
      ...(b.dailyBudget !== undefined && { emailDailyBudget: b.dailyBudget }),
      ...(b.monthlyBudget !== undefined && { emailMonthlyBudget: b.monthlyBudget }),
      ...(b.userAllowance !== undefined && { userMonthlyAllowance: b.userAllowance }),
      ...(b.brandName !== undefined && { brandName: b.brandName }),
      ...(b.brandColor !== undefined && { brandColor: b.brandColor }),
      ...(b.footer !== undefined && { emailFooter: b.footer }),
    }
    await app.db
      .insert(siteSettings)
      .values({ id: 1, ...set })
      .onConflictDoUpdate({ target: siteSettings.id, set })
    return { ok: true }
  })

  /** A sample of each email, with the current branding (shown in the console). */
  app.get('/admin/email/preview/:kind', async (req, reply) => {
    admin(req.user)
    const { kind } = parse(z.object({ kind: z.enum(EMAIL_KINDS) }), req.params)
    const brand = await getBrand(app.db)
    const { html } = await renderEmail(brand, sampleEmail(kind, brand, siteUrl(req)))
    return reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'")
      .send(html)
  })

  /** Sends a sample of an email to yourself, with the platform's key. */
  app.post('/admin/email/test/:kind', async (req) => {
    const me = admin(req.user)
    const { kind } = parse(z.object({ kind: z.enum(EMAIL_KINDS) }), req.params)
    const sender = await app.mail.senderFor(null)
    if (!sender) throw new HttpError(400, 'Set up email sending first.')
    const brand = await getBrand(app.db)
    const email = await renderEmail(brand, sampleEmail(kind, brand, siteUrl(req)))
    try {
      await app.mail.transport.send(sender.credentials(), { from: sender.from, to: me.email, ...email })
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'unknown error'
      throw new HttpError(400, sender.provider === 'resend' ? `Resend refused it: ${reason}` : `It couldn’t be sent. ${reason}`)
    }
    return { sentTo: me.email }
  })

  // ── Your own key (anyone) ───────────────────────────────────────────────

  app.get('/account/email', async (req) => {
    const me = requireUser(req.user)
    const s = await loadSettings(app.db)
    return {
      encryptionReady: encryptionReady(),
      platformReady: app.mail.platformReady,
      sender: senderView(await app.mail.senderFor(me.id)),
      allowance: { used: await app.mail.allowanceUsed(me.id), limit: s.userMonthlyAllowance },
    }
  })

  app.put('/account/email/sender', async (req) => {
    const me = requireUser(req.user)
    return saveSender(app, me, me.id, parse(SaveOwnSender, req.body), siteUrl(req))
  })

  app.delete('/account/email/sender', async (req) => {
    const me = requireUser(req.user)
    await removeSender(app, me.id)
    return { ok: true }
  })
}
