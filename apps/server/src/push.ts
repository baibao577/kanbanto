import { newId } from '@kanbanto/model/ids'
import { Agent } from 'node:https'
import { and, eq, ne } from 'drizzle-orm'
import webpush from 'web-push'
import { decrypt, encrypt } from './crypto'
import type { Db } from './db'
import { pushDevices, siteSettings, users } from './db/schema'
import { assertPublicEndpoint, publicLookup } from './storage/egress'

export interface PushMessage {
  title: string
  body: string
  /** Opened when the notification is clicked (an address inside the app, e.g. /#/b/…?task=…). */
  url: string
  /** Notifications with the same tag replace each other (e.g. one per card). */
  tag?: string
}
type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } }
/** How a message reaches a browser's push service (replaced in tests). */
export type PushTransport = (
  sub: Subscription,
  payload: string,
  opts: { ttl: number; vapid: { subject: string; publicKey: string; privateKey: string } },
) => Promise<void>

/**
 * The address comes from the person's browser, so it's treated like any address someone gives the server: public
 * internet only (checked again when its name is looked up), and not waited on for long.
 */
const publicAgent = new Agent({ lookup: publicLookup as never })
const webPushTransport: PushTransport = async (sub, payload, { ttl, vapid }) => {
  assertPublicEndpoint(sub.endpoint)
  await webpush.sendNotification(sub, payload, { TTL: ttl, vapidDetails: vapid, agent: publicAgent, timeout: 10_000 })
}

/**
 * Desktop notifications (Web Push): no app to install, in any browser that supports it, for people who turned them on
 * (per computer). The site's key pair is made the first time it's needed. A browser that's gone (unsubscribed,
 * permission removed) is forgotten when its push service says so.
 */
export class Push {
  transport: PushTransport = webPushTransport
  private keys: { publicKey: string; privateKey: string } | null = null

  private readonly db: Db
  private readonly site: () => string | null
  private readonly log?: { warn: (o: object, msg: string) => void }

  constructor(db: Db, site: () => string | null, log?: { warn: (o: object, msg: string) => void }) {
    this.db = db
    this.site = site
    this.log = log
  }

  /** The site's public key (browsers need it to subscribe), making the pair if there isn't one yet. */
  async publicKey(): Promise<string> {
    return (await this.pair()).publicKey
  }

  private async pair() {
    if (this.keys) return this.keys
    const [s] = await this.db.select({ pub: siteSettings.vapidPublicKey, priv: siteSettings.vapidPrivateKeyEncrypted }).from(siteSettings)
    if (s?.pub && s.priv) return (this.keys = { publicKey: s.pub, privateKey: decrypt(s.priv) })
    const made = webpush.generateVAPIDKeys()
    await this.db
      .insert(siteSettings)
      .values({ id: 1, vapidPublicKey: made.publicKey, vapidPrivateKeyEncrypted: encrypt(made.privateKey) })
      .onConflictDoUpdate({ target: siteSettings.id, set: { vapidPublicKey: made.publicKey, vapidPrivateKeyEncrypted: encrypt(made.privateKey) } })
    return (this.keys = made)
  }

  /** Sends to every browser where someone turned notifications on. `ttl`: how long a push service may hold it (seconds). */
  async toUser(userId: string, message: PushMessage, ttl = 3600): Promise<number> {
    const devices = await this.db.select().from(pushDevices).where(eq(pushDevices.userId, userId))
    if (!devices.length) return 0
    // An account that's been turned off gets nothing.
    const [u] = await this.db.select({ off: users.disabledAt }).from(users).where(eq(users.id, userId))
    if (!u || u.off) return 0
    const { publicKey, privateKey } = await this.pair()
    const site = this.site()
    const subject = site?.startsWith('https://') ? site : 'mailto:noreply@kanbanto.invalid'
    let sent = 0
    for (const d of devices) {
      try {
        await this.transport({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify(message), {
          ttl,
          vapid: { subject, publicKey, privateKey },
        })
        await this.db.update(pushDevices).set({ lastUsedAt: new Date() }).where(eq(pushDevices.id, d.id))
        sent++
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        // 404/410: the browser unsubscribed (or the subscription expired): forget it.
        if (status === 404 || status === 410) await this.db.delete(pushDevices).where(eq(pushDevices.id, d.id))
        else this.log?.warn({ err: e instanceof Error ? e.message : e, status }, 'push')
      }
    }
    return sent
  }

  /** Remembers a browser for someone (the same browser again just updates it). */
  async register(userId: string, sub: Subscription, label: string) {
    await this.db
      .insert(pushDevices)
      .values({ id: newId(), userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, label })
      .onConflictDoUpdate({ target: pushDevices.endpoint, set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, label } })
  }

  /**
   * Forgets someone's browsers: the one signing out (`only`), or all of them when the account's sessions are ended
   * (a new password, the account turned off), except the browser that stays signed in (`keep`).
   */
  async forget(userId: string, which: { only: string } | { keep?: string }) {
    const mine = eq(pushDevices.userId, userId)
    if ('only' in which) await this.db.delete(pushDevices).where(and(mine, eq(pushDevices.endpoint, which.only)))
    else await this.db.delete(pushDevices).where(which.keep ? and(mine, ne(pushDevices.endpoint, which.keep)) : mine)
  }

  /** Whether someone wants pushes of a kind. */
  async wants(userId: string, kind: 'reminders' | 'mentions' | 'follows') {
    const [u] = await this.db
      .select({ reminders: users.pushReminders, mentions: users.pushMentions, follows: users.pushFollows })
      .from(users)
      .where(eq(users.id, userId))
    return !!u && u[kind]
  }
}
