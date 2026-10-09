import type { ActivityItem } from '@kanbanto/model/activity'
import type { Change } from '@kanbanto/model/records'

/** What the engine says after a command changed something (see its `onChanged`). */
export interface Changed {
  board: { id: string; name: string }
  userId: string
  command: string
  seq: number
  changes: Change[]
  items: ActivityItem[]
  mutationId?: string
  autosave?: boolean
}

interface Held {
  boardId: string
  first: number
  /** The card as it was before the first of the saves held. */
  before: Change['before']
  last: Changed
  timer: ReturnType<typeof setTimeout>
}

/**
 * A description written together is saved every few seconds for as long as the writing goes on. What listens to a
 * board from outside (its webhooks, the chats they post to) gets those saves as one change: held here until the
 * writing has paused, then sent as the card before the first of them and after the last.
 */
export class HeldSaves {
  private held = new Map<string, Held>()
  private send: (boardId: string, e: Changed) => void
  private pause: number
  private most: number

  /** `pause`: how long after the last save a card's change is sent. `most`: how long it is held at the longest (ms). */
  constructor(send: (boardId: string, e: Changed) => void, { pause = 60_000, most = 5 * 60_000 }: { pause?: number; most?: number } = {}) {
    this.send = send
    this.pause = pause
    this.most = most
  }

  /** A save of a description being written: held, with the ones held for that card before it. */
  hold(boardId: string, e: Changed) {
    const change = e.changes[0]
    if (!change) return
    const key = `${boardId}\u0000${change.id}`
    const was = this.held.get(key)
    if (was) clearTimeout(was.timer)
    const held: Held = {
      boardId,
      first: was?.first ?? Date.now(),
      before: was ? was.before : change.before,
      last: e,
      timer: setTimeout(() => this.release(key), this.pause),
    }
    this.held.set(key, held)
    if (Date.now() - held.first >= this.most) this.release(key)
  }

  private release(key: string) {
    const h = this.held.get(key)
    if (!h) return
    clearTimeout(h.timer)
    this.held.delete(key)
    const [change, ...rest] = h.last.changes
    this.send(h.boardId, { ...h.last, changes: [{ ...change, before: h.before } as Change, ...rest] })
  }

  /**
   * Sends what is held for a board now: before anything else that happened on it is sent, so changes reach the
   * outside in the order they were made. Without a board: everything (the server is stopping).
   */
  flush(boardId?: string) {
    for (const [key, h] of [...this.held]) if (!boardId || h.boardId === boardId) this.release(key)
  }
}
