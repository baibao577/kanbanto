import type { LiveMessage } from '@kanbanto/model/api'
import type { WebSocket } from 'ws'

export type { LiveMessage }

interface Listener {
  socket: WebSocket
  userId: string | null
  /** The session it was opened with, so ending sessions can close it. */
  session: string | null
}

/**
 * Who has each board open, for sending changes live. It lives in this process: with several server
 * instances, add Postgres LISTEN/NOTIFY (or Redis) to pass messages between them.
 */
export class LiveHub {
  private boards = new Map<string, Set<Listener>>()

  join(boardId: string, socket: WebSocket, userId: string | null, session: string | null = null) {
    const set = this.boards.get(boardId) ?? new Set()
    this.boards.set(boardId, set)
    const listener = { socket, userId, session: userId ? session : null }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (!set.size) this.boards.delete(boardId)
    }
  }

  send(socket: WebSocket, message: LiveMessage) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  broadcast(boardId: string, message: LiveMessage) {
    for (const l of this.boards.get(boardId) ?? []) this.send(l.socket, message)
  }

  /** After sharing changes: disconnect people who lost access, tell everyone else to reload. */
  async recheck(boardId: string, canView: (userId: string | null) => Promise<boolean>) {
    for (const l of [...(this.boards.get(boardId) ?? [])]) {
      if (await canView(l.userId)) this.send(l.socket, { type: 'reload' })
      else {
        this.send(l.socket, { type: 'access-lost' })
        l.socket.close(4403, 'No access')
      }
    }
  }

  /**
   * Someone's sessions ended (password changed or reset, account turned off): close their live connections, except
   * the ones opened with `keepSession` (the device that changed the password).
   */
  signOut(userId: string, keepSession?: string) {
    for (const set of this.boards.values())
      for (const l of [...set]) {
        if (l.userId !== userId || (keepSession && l.session === keepSession)) continue
        this.send(l.socket, { type: 'signed-out' })
        l.socket.close(4401, 'Signed out')
        set.delete(l)
      }
  }

  /** One session ended (signed out): close the connections it opened. */
  endSession(session: string) {
    for (const set of this.boards.values())
      for (const l of [...set]) {
        if (l.session !== session) continue
        this.send(l.socket, { type: 'signed-out' })
        l.socket.close(4401, 'Signed out')
        set.delete(l)
      }
  }

  /** The board is gone: tell everyone and disconnect. */
  closeBoard(boardId: string) {
    for (const l of this.boards.get(boardId) ?? []) {
      this.send(l.socket, { type: 'deleted' })
      l.socket.close(4404, 'Deleted')
    }
    this.boards.delete(boardId)
  }

  count(boardId: string) {
    return this.boards.get(boardId)?.size ?? 0
  }
}
