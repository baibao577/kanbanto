import type { PlanningMutationResult, PlanningView } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import type { PlanData } from '@kanbanto/model/planning'
import { applyPlanChanges, executePlan, type PlanChange, type PlanCommand } from '@kanbanto/model/planningCommands'
import { api, ApiError } from '@/api/client'

/** Things the page should tell the person about. */
export type PlanEvent =
  /** A change of yours was refused (someone else's got there first, or you can't change the plan any more). */
  | { type: 'refused'; message: string }
  /** You're no longer in the workspace (or it's gone). */
  | { type: 'gone' }
  | { type: 'signed-out' }

export interface PlanState {
  /** The plan as you see it: the server's copy with your unsaved changes on top. */
  plan: PlanData
  canEdit: boolean
  memberIds: string[]
  activity: PlanningView['activity']
  pictures: PlanningView['pictures']
  /** The workspace's boards you can open (what a project can be linked to). */
  boards: PlanningView['boards']
  /** Time logged on linked boards' cards (minutes by board, then by account), fresh with every check. */
  actuals: PlanningView['actuals']
  /** Changes made here that the server hasn't confirmed yet. */
  unsaved: number
  /** The server can't be reached right now (changes are kept and sent when it can). */
  offline: boolean
}

interface Pending {
  id: string
  command: PlanCommand
  sent: boolean
}

const backoff = (attempt: number) => Math.min(10_000, 500 * 2 ** attempt)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SERVER_TRIES = 5
/** How often an open plan checks for other people's changes (and when the tab comes back into view). */
const POLL_MS = 60_000

/** Adds get their ids here, so the server makes exactly the same records. */
function withIds(cmd: PlanCommand): PlanCommand {
  switch (cmd.type) {
    case 'block.add':
    case 'project.add':
    case 'person.add':
    case 'line.add':
    case 'role.add':
      return cmd.id ? cmd : { ...cmd, id: newId() }
    case 'block.split':
      return cmd.newId ? cmd : { ...cmd, newId: newId() }
    default:
      return cmd
  }
}

/** The projects a change is about (for "changed just now by you"). */
function projectsOf(changes: PlanChange[]) {
  const ids = new Set<string>()
  for (const c of changes)
    for (const r of [c.before, c.after]) {
      if (!r) continue
      if (c.entity === 'project') ids.add(r.id)
      if ((c.entity === 'block' || c.entity === 'line') && 'projectId' in r) ids.add(r.projectId)
    }
  return ids
}

/**
 * Keeps one workspace's plan in step with the server, the way BoardSync does for boards: your commands run here at
 * once, then go to the server one at a time, in order; the server runs them again with the same rules. What you see
 * is your pending commands replayed on the server's copy. Other people's changes are picked up by checking now and
 * then (the plan has no live connection yet), and whenever the tab comes back into view.
 */
export class PlanSync {
  readonly workspaceId: string
  private readonly me: string
  private confirmed: PlanData
  private seq: number
  private pending: Pending[] = []
  private state: PlanState
  private sending = false
  private closed = false
  private signedOut = false
  private attempts = 0
  private serverErrors = 0
  private resyncing: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<() => void>()
  private eventListeners = new Set<(e: PlanEvent) => void>()
  /** Something is being dragged: checking for changes waits, so the plan doesn't shift underneath. */
  private busy = false

  constructor(workspaceId: string, view: PlanningView, me: string) {
    this.workspaceId = workspaceId
    this.me = me
    this.confirmed = view.plan
    this.seq = view.seq
    this.state = {
      plan: view.plan,
      canEdit: view.canEdit,
      memberIds: view.memberIds,
      activity: view.activity,
      pictures: view.pictures,
      boards: view.boards,
      actuals: view.actuals,
      unsaved: 0,
      offline: false,
    }
    this.timer = setInterval(() => void this.check(), POLL_MS)
    window.addEventListener('focus', this.check)
    document.addEventListener('visibilitychange', this.check)
  }

  getState = () => this.state
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  onEvent(l: (e: PlanEvent) => void) {
    this.eventListeners.add(l)
    return () => void this.eventListeners.delete(l)
  }

  private ctx = () => ({ now: new Date().toISOString(), newId, members: new Set(this.state.memberIds) })

  /** Runs a command: shown at once, saved in the background. Returns its changes, or why it isn't allowed. */
  run(cmd: PlanCommand): { changes: PlanChange[] } | { error: string } {
    if (!this.state.canEdit) return { error: 'You can see this plan, but not change it.' }
    const command = withIds(cmd)
    const r = executePlan(this.state.plan, command, this.ctx())
    if ('error' in r || !r.changes.length) return r
    this.pending.push({ id: newId(), command, sent: false })
    const at = new Date().toISOString()
    const activity = { ...this.state.activity }
    for (const id of projectsOf(r.changes)) activity[id] = { at, by: this.me }
    this.set({ plan: applyPlanChanges(this.state.plan, r.changes), unsaved: this.pending.length, activity })
    void this.flush()
    return r
  }

  /** A board made here (from a project): known at once, before the next fetch. */
  addBoard(board: PlanningView['boards'][number]) {
    this.set({ boards: [...this.state.boards, board] })
  }

  setBusy(busy: boolean) {
    this.busy = busy
  }

  close() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    window.removeEventListener('focus', this.check)
    document.removeEventListener('visibilitychange', this.check)
  }

  private async flush() {
    if (this.sending || this.closed || this.signedOut) return
    this.sending = true
    try {
      while (this.pending.length && !this.closed && !this.signedOut) {
        const p = this.pending[0]
        p.sent = true
        try {
          const res = await api<PlanningMutationResult>('POST', `/workspaces/${this.workspaceId}/planning/mutations`, {
            mutationId: p.id,
            command: p.command,
          })
          this.attempts = 0
          this.serverErrors = 0
          if (this.state.offline) this.set({ offline: false })
          this.receive(res.seq, res.changes, p.id)
        } catch (e) {
          const status = e instanceof ApiError ? e.status : 0
          if (status === 401) {
            this.signedOut = true
            this.emit({ type: 'signed-out' })
          } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            this.drop(p, (e as Error).message)
            // Rights may have changed (or the workspace is gone): get the current state.
            if (status === 403 || status === 404) void this.resync()
          } else if (status >= 500 && ++this.serverErrors >= SERVER_TRIES) {
            this.drop(p, 'A change couldn’t be saved because of a problem on the server, so it was undone.')
            void this.resync()
          } else {
            this.set({ offline: true })
            await sleep(backoff(this.attempts++))
          }
        }
      }
    } finally {
      this.sending = false
    }
  }

  private drop(p: Pending, message: string) {
    this.pending = this.pending.filter((x) => x !== p)
    this.serverErrors = 0
    this.replay()
    this.emit({ type: 'refused', message })
  }

  private receive(seq: number, changes: PlanChange[], mutationId: string) {
    this.pending = this.pending.filter((p) => p.id !== mutationId)
    if (!changes.length || seq <= this.seq) return this.replay()
    // Someone else changed the plan in between: fetch it whole.
    if (seq !== this.seq + 1) return void this.resync()
    this.confirmed = applyPlanChanges(this.confirmed, changes)
    this.seq = seq
    this.replay()
  }

  private replay() {
    let plan = this.confirmed
    const kept: Pending[] = []
    for (const p of this.pending) {
      const r = executePlan(plan, p.command, this.ctx())
      if ('error' in r) {
        if (!p.sent) this.emit({ type: 'refused', message: `Your change couldn’t be applied: ${r.error}` })
        continue
      }
      plan = applyPlanChanges(plan, r.changes)
      kept.push(p)
    }
    this.pending = kept
    this.set({ plan, unsaved: kept.length })
  }

  /** Looks for other people's changes (not while you're dragging or saving). */
  check = () => {
    if (this.closed || this.busy || this.pending.length || document.visibilityState !== 'visible') return
    void this.resync()
  }

  /** Fetches the whole plan again. */
  resync(): Promise<void> {
    this.resyncing ??= (async () => {
      try {
        const view = await api<PlanningView>('GET', `/workspaces/${this.workspaceId}/planning`)
        if (this.busy && view.seq !== this.seq) {
          // A drag started while this was on its way: try again afterwards rather than move things under it.
          return
        }
        this.confirmed = view.plan
        this.seq = view.seq
        this.set({
          canEdit: view.canEdit,
          memberIds: view.memberIds,
          activity: view.activity,
          pictures: view.pictures,
          boards: view.boards,
          actuals: view.actuals,
        })
        this.replay()
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) this.emit({ type: 'gone' })
        if (e instanceof ApiError && e.status === 401) this.emit({ type: 'signed-out' })
      } finally {
        this.resyncing = null
      }
    })()
    return this.resyncing
  }

  private set(patch: Partial<PlanState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  private emit(e: PlanEvent) {
    for (const l of this.eventListeners) l(e)
  }
}
