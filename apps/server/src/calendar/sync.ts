import { createHash } from 'node:crypto'
import { calendarItems, dayAfter, type CalendarItem } from '@kanbanto/model/calendar'
import { newId } from '@kanbanto/model/ids'
import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { BoardEngine } from '../boards/engine'
import { decrypt, encrypt } from '../crypto'
import type { Db } from '../db'
import { calendarBoards, calendarConnections, calendarEvents, siteSettings, users } from '../db/schema'
import { HttpError } from '../http'
import { loadSettings } from '../settings'
import { badApp, GoogleError, type GoogleApi, type GoogleApp, type GoogleEvent } from './google'
import { boardsInCalendar, taskUrl, type CalendarBoard } from './items'

/**
 * Keeps people's Google calendars up to date: for each connected person, a calendar of Kanbanto's own in their Google
 * account holds one event per due date (and per reminder that can't be an alert), by the rule in model/calendar.ts.
 * One way only: what's in Kanbanto is what the calendar shows.
 *
 * It works from what should be there, not from what just happened. Every board has a change number (`boards.seq`)
 * that goes up with any change to its cards, lists or people; for each person and board, the number last sent to
 * Google is kept (calendar_boards.synced_seq). A different number means: work out the board's events again, compare
 * them with what was sent (calendar_events, by hash), and add, change or remove the difference. Boards someone can no
 * longer open (removed from it, made private, archived, deleted, left out) have their events removed.
 */

/** Delays before trying again when Google doesn't answer, in minutes; the last one repeats. It never gives up. */
const RETRY_MINUTES = [1, 5, 30, 120, 360]
/** Calls to Google for one person in one pass: the rest waits for the next pass (a first sync of many cards). */
const MAX_CALLS = 200

type Connection = typeof calendarConnections.$inferSelect
type EventRow = typeof calendarEvents.$inferSelect

/** The pass used up its calls for this person: carry on next time. */
class Paused extends Error {}
/** The calendar isn't in their Google account any more (they deleted it): make a new one and fill it again. */
class CalendarGone extends Error {}

interface Pass {
  userId: string
  accessToken: string
  calendarId: string
  calls: number
}

const hashOf = (event: GoogleEvent) => createHash('sha256').update(JSON.stringify(event)).digest('hex')
/** Google wants event ids in lowercase letters a–v and digits. */
const newEventId = () => newId().replace(/-/g, '')
const gone = (e: unknown) => e instanceof GoogleError && (e.status === 404 || e.status === 410)

/** The site's Google app, if a platform admin has saved one. */
export async function googleApp(db: Db): Promise<GoogleApp | null> {
  const [s] = await db.select({ id: siteSettings.googleClientId, secret: siteSettings.googleClientSecretEncrypted }).from(siteSettings)
  if (!s?.id || !s.secret) return null
  try {
    return { clientId: s.id, clientSecret: decrypt(s.secret) }
  } catch {
    // Saved with an encryption key the server no longer has: it has to be entered again.
    return null
  }
}

export function toGoogleEvent(item: CalendarItem, boardName: string, url: string | null): GoogleEvent {
  return {
    summary: item.title,
    description: url ? `${boardName}\n${url}` : boardName,
    start: 'day' in item.when ? { date: item.when.day } : { dateTime: item.when.start, timeZone: 'UTC' },
    end: 'day' in item.when ? { date: dayAfter(item.when.day) } : { dateTime: item.when.end, timeZone: 'UTC' },
    transparency: 'transparent',
    ...(url && { source: { title: boardName, url } }),
    reminders: { useDefault: false, overrides: item.alerts.map((minutes) => ({ method: 'popup', minutes })) },
  }
}

export class CalendarSync {
  /** Google itself, or a stand-in (tests). */
  google: GoogleApi
  private timer: ReturnType<typeof setInterval> | null = null
  private soon: ReturnType<typeof setTimeout> | null = null
  private busy = false
  private log: FastifyBaseLogger | null = null
  /** Access tokens, kept until shortly before they run out. */
  private tokens = new Map<string, { accessToken: string; until: number }>()
  /** Every board's change number, summed up: unchanged since the last pass means there's nothing to do. */
  private seen = ''
  /** Something changed that the boards' change numbers don't show (a new connection, a board left out, unfinished work). */
  private dirty = true

  private readonly db: Db
  private readonly engine: BoardEngine
  private readonly site: () => string | null

  constructor(db: Db, engine: BoardEngine, google: GoogleApi, site: () => string | null) {
    this.db = db
    this.engine = engine
    this.google = google
    this.site = site
  }

  /** Syncs in the background (the server does this; tests call `process` themselves). */
  start(log: FastifyBaseLogger, everyMs = 5000) {
    this.log = log
    this.timer = setInterval(() => void this.process(), everyMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.timer = this.soon = null
  }

  /** Something changed: sync within a second instead of waiting for the next round (several changes share one pass). */
  kick() {
    if (!this.timer || this.soon) return
    this.soon = setTimeout(() => {
      this.soon = null
      void this.process()
    }, 1000)
  }

  /** Something changed that isn't a change to a board: look at everyone on the next pass. */
  changed() {
    this.dirty = true
    this.kick()
  }

  /** Sends what's new to Google, for everyone connected. Returns how many calls it made. */
  async process(now = new Date()): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    try {
      const [state] = await this.db.execute<{ boards: string; retries: number }>(sql`
        select (select coalesce(sum(seq), 0)::text || ':' || count(*)::text from boards) as boards,
          (select count(*)::int from calendar_connections
            where attempts > 0 and failing_since is null and next_attempt_at <= ${now.toISOString()}::timestamptz) as retries`)
      if (!this.dirty && state.boards === this.seen && !state.retries) return 0
      const app = await googleApp(this.db)
      if (!app) return 0
      this.dirty = false
      this.seen = state.boards
      const due = await this.db
        .select({ c: calendarConnections, timeZone: users.timeZone })
        .from(calendarConnections)
        .innerJoin(users, eq(users.id, calendarConnections.userId))
        .where(and(isNull(users.disabledAt), isNull(calendarConnections.failingSince), lte(calendarConnections.nextAttemptAt, now)))
      let calls = 0
      for (const { c, timeZone } of due) calls += await this.syncPerson(app, c, timeZone, now)
      return calls
    } catch (e) {
      this.dirty = true
      this.log?.error({ err: e instanceof Error ? e.message : e }, 'calendar sync')
      return 0
    } finally {
      this.busy = false
    }
  }

  /** Saves a new connection (or a renewed one) and starts filling its calendar. */
  async connect(userId: string, grant: { refreshToken: string; email: string | null }) {
    const [old] = await this.db.select().from(calendarConnections).where(eq(calendarConnections.userId, userId))
    // A first connection, or another Google account: its calendar is a new one, filled from nothing.
    if (!old || old.googleEmail !== grant.email) await this.forget(userId)
    const fresh = { googleEmail: grant.email, refreshTokenEncrypted: encrypt(grant.refreshToken), lastError: null, failingSince: null, attempts: 0 }
    await this.db
      .insert(calendarConnections)
      .values({ userId, ...fresh })
      .onConflictDoUpdate({ target: calendarConnections.userId, set: { ...fresh, nextAttemptAt: new Date() } })
    this.tokens.delete(userId)
    this.changed()
  }

  /**
   * Ends someone's connection: the calendar is removed from their Google account and the access given back (as far as
   * Google still lets us), and everything kept about it here is deleted.
   */
  async disconnect(userId: string) {
    const [c] = await this.db.select().from(calendarConnections).where(eq(calendarConnections.userId, userId))
    if (!c) return
    try {
      const app = await googleApp(this.db)
      if (app && c.calendarId && !c.failingSince) await this.google.deleteCalendar(await this.accessToken(app, c), c.calendarId)
      await this.google.revoke(decrypt(c.refreshTokenEncrypted))
    } catch (e) {
      this.log?.warn({ err: e instanceof Error ? e.message : e }, 'removing a Google calendar')
    }
    await this.forget(userId)
    await this.db.delete(calendarConnections).where(eq(calendarConnections.userId, userId))
    this.tokens.delete(userId)
  }

  /** Forgets what was sent for someone, so everything is sent again (to a new calendar). */
  private async forget(userId: string) {
    await this.db.delete(calendarEvents).where(eq(calendarEvents.userId, userId))
    await this.db.update(calendarBoards).set({ syncedSeq: null }).where(eq(calendarBoards.userId, userId))
    await this.db.update(calendarConnections).set({ calendarId: null }).where(eq(calendarConnections.userId, userId))
  }

  private async accessToken(app: GoogleApp, c: Connection): Promise<string> {
    const hit = this.tokens.get(c.userId)
    if (hit && hit.until > Date.now()) return hit.accessToken
    const { accessToken, expiresIn } = await this.google.refresh(app, decrypt(c.refreshTokenEncrypted))
    this.tokens.set(c.userId, { accessToken, until: Date.now() + (expiresIn - 60) * 1000 })
    return accessToken
  }

  private async syncPerson(app: GoogleApp, c: Connection, timeZone: string | null, now: Date): Promise<number> {
    const set = (values: Partial<Connection>) => this.db.update(calendarConnections).set(values).where(eq(calendarConnections.userId, c.userId))
    const pass: Pass = { userId: c.userId, accessToken: '', calendarId: '', calls: 0 }
    try {
      const wanted = await boardsInCalendar(this.db, c.userId)
      const stale = wanted.filter((b) => b.syncedSeq !== b.seq)
      const sent = await this.db.selectDistinct({ boardId: calendarEvents.boardId }).from(calendarEvents).where(eq(calendarEvents.userId, c.userId))
      const left = sent.filter((s) => !wanted.some((b) => b.id === s.boardId))
      if (!stale.length && !left.length) {
        if (c.attempts) await set({ attempts: 0, lastError: null })
        return 0
      }
      pass.accessToken = await this.accessToken(app, c)
      if (c.calendarId) pass.calendarId = c.calendarId
      else {
        this.spend(pass)
        const name = (await loadSettings(this.db)).brandName
        pass.calendarId = await this.google.createCalendar(pass.accessToken, { name, timeZone: timeZone ?? 'UTC' })
        await set({ calendarId: pass.calendarId })
      }
      for (const { boardId } of left) await this.clearBoard(pass, boardId)
      for (const b of stale) await this.syncBoard(pass, b)
      await set({ lastSyncedAt: now, attempts: 0, lastError: null })
    } catch (e) {
      if (e instanceof Paused) this.dirty = true
      else if (e instanceof CalendarGone) {
        await this.forget(c.userId)
        this.dirty = true
      } else if (e instanceof GoogleError && e.refused && !badApp(e)) {
        // (When it's the site's Google app that Google refuses, connecting again wouldn't help: that waits and retries.)
        this.tokens.delete(c.userId)
        await set({ failingSince: now, lastError: 'Google no longer accepts this connection. Connect it again.' })
      } else {
        const attempts = c.attempts + 1
        const wait = RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1]
        const lastError = e instanceof GoogleError ? e.message : 'Something went wrong while updating the calendar.'
        if (!(e instanceof GoogleError)) this.log?.error({ err: e instanceof Error ? e.message : e }, 'calendar sync')
        await set({ attempts, nextAttemptAt: new Date(now.getTime() + wait * 60_000), lastError })
      }
    }
    return pass.calls
  }

  /** One more call to Google in this pass, if there's room for it. */
  private spend(pass: Pass) {
    if (pass.calls >= MAX_CALLS) throw new Paused()
    pass.calls++
  }

  private rows(userId: string, boardId: string) {
    return this.db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.boardId, boardId)))
  }
  private row(r: Pick<EventRow, 'userId' | 'boardId' | 'taskId' | 'part'>) {
    return and(
      eq(calendarEvents.userId, r.userId),
      eq(calendarEvents.boardId, r.boardId),
      eq(calendarEvents.taskId, r.taskId),
      eq(calendarEvents.part, r.part),
    )
  }

  /** Removes a board's events from the calendar (it's no longer in it). */
  private async clearBoard(pass: Pass, boardId: string) {
    for (const r of await this.rows(pass.userId, boardId)) await this.remove(pass, r)
    await this.db
      .update(calendarBoards)
      .set({ syncedSeq: null })
      .where(and(eq(calendarBoards.userId, pass.userId), eq(calendarBoards.boardId, boardId)))
  }

  /** (Also for a row that was never marked as sent: a pass may have been cut short just after making its event.) */
  private async remove(pass: Pass, r: EventRow) {
    this.spend(pass)
    await this.google.deleteEvent(pass.accessToken, pass.calendarId, r.eventId)
    await this.db.delete(calendarEvents).where(this.row(r))
  }

  /** Makes the calendar show one board as it is now. */
  private async syncBoard(pass: Pass, b: CalendarBoard) {
    let snapshot: Awaited<ReturnType<BoardEngine['snapshot']>>
    try {
      snapshot = await this.engine.snapshot(b.id)
    } catch (e) {
      // Deleted a moment ago: the next pass removes its events.
      if (e instanceof HttpError && e.status === 404) return void (this.dirty = true)
      throw e
    }
    const { data, seq } = snapshot
    const site = this.site()
    const had = new Map((await this.rows(pass.userId, b.id)).map((r) => [`${r.taskId}\n${r.part}`, r]))
    for (const item of calendarItems(data, pass.userId)) {
      const event = toGoogleEvent(item, data.board.name, site && taskUrl(site, b.id, item.taskId))
      const hash = hashOf(event)
      const key = `${item.taskId}\n${item.key}`
      const r = had.get(key)
      had.delete(key)
      if (r?.sentHash !== hash)
        await this.put(
          pass,
          r ?? { userId: pass.userId, boardId: b.id, taskId: item.taskId, part: item.key, eventId: '', sentHash: null },
          event,
          hash,
        )
    }
    for (const r of had.values()) await this.remove(pass, r)
    await this.db
      .insert(calendarBoards)
      .values({ userId: pass.userId, boardId: b.id, syncedSeq: seq })
      .onConflictDoUpdate({ target: [calendarBoards.userId, calendarBoards.boardId], set: { syncedSeq: seq } })
  }

  /**
   * Adds or changes one event. A new event's id is saved before Google is asked, so a pass that's cut short (and tried
   * again) finds the event it already made instead of making a second one.
   */
  private async put(pass: Pass, r: EventRow, event: GoogleEvent, hash: string) {
    const { accessToken, calendarId } = pass
    const save = (eventId: string, sentHash: string | null) =>
      this.db
        .insert(calendarEvents)
        .values({ ...r, eventId, sentHash })
        .onConflictDoUpdate({
          target: [calendarEvents.userId, calendarEvents.boardId, calendarEvents.taskId, calendarEvents.part],
          set: { eventId, sentHash },
        })
    const add = async (eventId: string) => {
      await save(eventId, null)
      this.spend(pass)
      try {
        await this.google.insertEvent(accessToken, calendarId, eventId, event)
      } catch (e) {
        // Events can be gone; a calendar that is means starting over.
        if (gone(e)) throw new CalendarGone()
        if (!(e instanceof GoogleError) || e.status !== 409) throw e
        // It's there from a pass that was cut short: bring it up to date.
        this.spend(pass)
        await this.google.updateEvent(accessToken, calendarId, eventId, event)
      }
      return eventId
    }
    let eventId = r.eventId || newEventId()
    try {
      if (!r.sentHash) await add(eventId)
      else {
        this.spend(pass)
        await this.google.updateEvent(accessToken, calendarId, eventId, event).catch(async (e) => {
          if (!gone(e)) throw e
          // They deleted it in Google: put it back, as a new event.
          eventId = await add(newEventId())
        })
      }
    } catch (e) {
      // Google won't take this one event as it is: leave it until it changes, rather than stop everything else.
      if (!(e instanceof GoogleError) || e.status !== 400) throw e
      this.log?.warn({ err: e.message, boardId: r.boardId, taskId: r.taskId }, 'a calendar event Google refused')
    }
    await save(eventId, hash)
  }
}
