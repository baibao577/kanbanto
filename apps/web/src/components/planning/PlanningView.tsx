import { ArrowsInSimple, ArrowsOutSimple, DotsThree, Plus, Scissors, Trash, UserPlus } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { WorkspaceDetail } from '@kanbanto/model/api'
import { fromDay, todayDay } from '@kanbanto/model/dates'
import { PERCENTS, manDays, planActuals, sumManDays, type Percent } from '@kanbanto/model/planning'
import type { PlanCommand } from '@kanbanto/model/planningCommands'
import { navigate, type WorkspaceRoute } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Empty } from '@/components/common/Empty'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { usePlanStore } from '@/data/usePlanStore'
import type { PlanEvent } from '@/data/planSync'
import { formatDay } from '@/lib/format'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { BlockDialog, PersonDialog, ProjectDialog, RolesDialog } from './dialogs'
import { PlanSheet } from './PlanSheet'
import { fmtMd, rowsByPerson, rowsByProject, type Zoom } from './planLayout'

type DialogState =
  { kind: 'project'; id: string } | { kind: 'person'; id: string; forProject?: string } | { kind: 'block'; id: string } | { kind: 'roles' } | null
const ALL = '__all__'

/** Folded groups are remembered per workspace, on this device. */
const foldedKey = (ws: string) => `kankan:planning:${ws}:folded`
function loadFolded(ws: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(foldedKey(ws)) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * A workspace's plan: who works on which project, when, and how much of their time, against each project's planned
 * man-days and each person's week. By project or by person, in weeks or days. Admins and planners change it right on
 * the sheet; everyone else in the workspace can see it.
 */
export function PlanningView({ ws, route }: { ws: WorkspaceDetail; route: WorkspaceRoute }) {
  const { user } = useAuth()
  const onEvent = useCallback((e: PlanEvent) => {
    if (e.type === 'refused') toast(e.message, { id: 'refused' })
    else if (e.type === 'gone') {
      toast('You’re no longer in this workspace.')
      navigate({ page: 'home' }, { replace: true })
    } else toast('You were signed out. Sign in again to keep planning.', { id: 'signed-out' })
  }, [])
  const store = usePlanStore(ws.id, user?.name ?? 'you', onEvent)
  const narrow = useMediaQuery('(max-width: 767px)')
  const coarse = useMediaQuery('(pointer: coarse)')
  const today = todayDay()
  const zoom: Zoom = route.zoom ?? 'weeks'
  const by = route.by === 'person' ? 'person' : 'project'
  const [showFinished, setShowFinished] = useState(false)
  const [folded, setFolded] = useState(() => loadFolded(ws.id))
  const fold = useCallback(
    (next: Set<string>) => {
      setFolded(next)
      try {
        localStorage.setItem(foldedKey(ws.id), JSON.stringify([...next]))
      } catch {
        // Not kept on this device: it's only a view setting.
      }
    },
    [ws.id],
  )
  const toggleGroup = useCallback(
    (key: string) => {
      const next = new Set(folded)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      fold(next)
    },
    [folded, fold],
  )
  const [roleId, setRoleId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; day: number | null; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [todayRequest, setTodayRequest] = useState(0)
  const state = store.state
  const { undo, redo } = store

  useEffect(() => {
    document.title = `Planning · ${ws.name} · Kanbanto`
  }, [ws.name])

  const say = useCallback((m: string | null) => m && toast(m, { id: 'undo' }), [])
  const run = useCallback(
    (cmd: PlanCommand, done?: string) => {
      const error = store.run(cmd)
      if (error) {
        toast(error, { id: 'refused' })
        return false
      }
      if (done) toast(done, { id: 'undo', action: { label: 'Undo', onClick: () => say(undo()) } })
      return true
    },
    [store, undo, say],
  )

  // ⌘/Ctrl+Z undoes, ⇧⌘Z or Ctrl+Y redoes (not while typing or in a dialog).
  const canEdit = !!state?.canEdit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (!canEdit || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('[role=dialog]')) return
      const key = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && key === 'z') {
        e.preventDefault()
        say(e.shiftKey ? redo() : undo())
      } else if ((e.metaKey || e.ctrlKey) && key === 'y') {
        e.preventDefault()
        say(redo())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, undo, redo, say])

  const set = (patch: Partial<WorkspaceRoute>) => navigate({ ...route, ...patch }, { replace: true })

  // Time logged on linked boards, as each person's man-days.
  const actuals = useMemo(() => (state ? planActuals(state.plan, state.actuals) : {}), [state])
  const rows = useMemo(() => {
    if (!state) return []
    return by === 'project'
      ? rowsByProject(state.plan, { canEdit: state.canEdit, showFinished, collapsed: folded, actuals, today })
      : rowsByPerson(state.plan, { canEdit: state.canEdit, today, memberIds: state.memberIds, roleId, collapsed: folded, actuals })
  }, [state, by, showFinished, today, roleId, folded, actuals])

  if (store.error) return <Empty>{store.error.message}</Empty>
  if (!state) return null
  const { plan } = state
  // Running projects, and prospects (might not happen) apart.
  const totals = (prospect: boolean) => {
    const projects = plan.projects.filter((p) => !p.finishedAt && p.prospect === prospect)
    const ids = new Set(projects.map((p) => p.id))
    return {
      count: projects.length,
      planned: projects.reduce((s, p) => s + (p.plannedMd ?? 0), 0),
      scheduled: sumManDays(plan.blocks.filter((b) => ids.has(b.projectId))),
    }
  }
  const running = totals(false)
  const prospects = totals(true)
  const menuBlock = menu && plan.blocks.find((b) => b.id === menu.id)
  const who = (personId: string | null) => (personId ? (plan.people.find((p) => p.id === personId)?.name ?? 'Someone') : 'Not assigned yet')
  const projectName = (id: string) => plan.projects.find((p) => p.id === id)?.name ?? ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-1.5 sm:px-4">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={by}
          onValueChange={(v) => v && set({ by: v === 'person' ? 'person' : undefined })}
        >
          <ToggleGroupItem value="project" className="px-3">
            By project
          </ToggleGroupItem>
          <ToggleGroupItem value="person" className="px-3">
            By person
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={zoom}
          onValueChange={(v) => v && set({ zoom: v === 'days' || v === 'months' ? v : undefined })}
        >
          <ToggleGroupItem value="days" className="px-3">
            Days
          </ToggleGroupItem>
          <ToggleGroupItem value="weeks" className="px-3">
            Weeks
          </ToggleGroupItem>
          <ToggleGroupItem value="months" className="px-3">
            Months
          </ToggleGroupItem>
        </ToggleGroup>
        <Button variant="outline" size="sm" className="h-8" onClick={() => setTodayRequest((n) => n + 1)}>
          Today
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Fold all"
          title="Fold all"
          onClick={() => fold(new Set([...plan.projects.map((p) => `project:${p.id}`), ...plan.people.map((p) => `person:${p.id}`)]))}
        >
          <ArrowsInSimple />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Unfold all" title="Unfold all" onClick={() => fold(new Set())}>
          <ArrowsOutSimple />
        </Button>
        {by === 'person' && plan.roles.length > 0 && (
          <Select value={roleId ?? ALL} onValueChange={(v) => setRoleId(v === ALL ? null : v)}>
            <SelectTrigger size="sm" className="h-8 w-32 text-xs" aria-label="Show people with role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every role</SelectItem>
              {plan.roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="hidden text-xs text-muted-foreground tabular-nums lg:block">
          <b className="text-foreground">{fmtMd(running.scheduled)}</b> of <b className="text-foreground">{fmtMd(running.planned)}</b> planned
          man-days scheduled
          {prospects.count > 0 && (
            <>
              {' · '}
              {fmtMd(prospects.scheduled)} of {fmtMd(prospects.planned)} on prospects
            </>
          )}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          {(state.unsaved > 0 || state.offline) && (
            <span className="text-xs text-muted-foreground">{state.offline ? 'Offline: changes will be saved when you’re back' : 'Saving…'}</span>
          )}
          {canEdit && (
            <>
              <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setDialog({ kind: 'project', id: 'new' })}>
                <Plus /> <span className="hidden sm:inline">Project</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => setDialog({ kind: 'person', id: 'new' })}
                title="Someone not in Kanbanto"
              >
                <UserPlus /> <span className="hidden sm:inline">Person</span>
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="More">
                <DotsThree weight="bold" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {canEdit && <DropdownMenuItem onSelect={() => setDialog({ kind: 'roles' })}>Roles…</DropdownMenuItem>}
              <DropdownMenuCheckboxItem checked={showFinished} onCheckedChange={(v) => setShowFinished(!!v)}>
                Show finished projects
              </DropdownMenuCheckboxItem>
              {!canEdit && (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Only admins and planners can change the plan.
                </DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {plan.projects.length === 0 ? (
          <Empty
            action={
              canEdit ? (
                <Button onClick={() => setDialog({ kind: 'project', id: 'new' })}>
                  <Plus /> Add a project
                </Button>
              ) : undefined
            }
          >
            {canEdit
              ? 'Plan who works on which project, and see who’s free. Start with a project and its planned man-days.'
              : 'Nothing is planned yet. The workspace’s admins and planners can add projects and people’s time.'}
          </Empty>
        ) : (
          <PlanSheet
            plan={plan}
            rows={rows}
            zoom={zoom}
            narrow={narrow}
            today={today}
            canEdit={canEdit}
            coarse={coarse}
            activity={state.activity}
            boards={state.boards}
            todayRequest={todayRequest}
            run={run}
            setBusy={store.setBusy}
            openBlockMenu={(id, day, at) => setMenu({ id, day, ...at })}
            editProject={(id) => setDialog({ kind: 'project', id })}
            editPerson={(id) => setDialog({ kind: 'person', id })}
            newPerson={(projectId) => setDialog({ kind: 'person', id: 'new', forProject: projectId })}
            toggleFinished={() => setShowFinished((v) => !v)}
            toggleGroup={toggleGroup}
          />
        )}
      </div>

      {/* A block's menu, where it was clicked. */}
      <DropdownMenu open={!!menuBlock} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-px" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </DropdownMenuTrigger>
        {menuBlock && (
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="space-y-0.5 font-normal">
              <span className="block truncate text-sm font-medium">
                {who(menuBlock.personId)} on {projectName(menuBlock.projectId)}
              </span>
              <span className="block text-xs text-muted-foreground tabular-nums">
                {formatDay(menuBlock.start)} – {formatDay(menuBlock.end)} · {fmtMd(manDays(menuBlock))} man-days
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {canEdit && (
              <>
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Time on this project</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={String(menuBlock.pct)}
                  onValueChange={(v) => run({ type: 'block.update', id: menuBlock.id, fields: { pct: Number(v) as Percent } })}
                >
                  {PERCENTS.map((v) => (
                    <DropdownMenuRadioItem key={v} value={String(v)} className="tabular-nums">
                      {v}%
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={menu!.day === null}
                  onSelect={() =>
                    menu!.day !== null &&
                    run({ type: 'block.split', id: menuBlock.id, at: fromDay(menu!.day) }, `Split on ${formatDay(fromDay(menu!.day))}`)
                  }
                >
                  <Scissors /> {menu!.day !== null ? `Split on ${formatDay(fromDay(menu!.day))}` : 'Split (point further inside)'}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={() => setDialog({ kind: 'block', id: menuBlock.id })}>Details…</DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => run({ type: 'block.remove', id: menuBlock.id }, 'Block removed')}>
                  <Trash /> Remove
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        )}
      </DropdownMenu>

      {dialog?.kind === 'project' && (
        <ProjectDialog
          key={dialog.id}
          plan={plan}
          id={dialog.id}
          workspaceId={ws.id}
          boards={state.boards}
          onBoardMade={store.addBoard}
          onClose={() => setDialog(null)}
          run={run}
        />
      )}
      {dialog?.kind === 'person' && (
        <PersonDialog
          key={dialog.id}
          plan={plan}
          id={dialog.id}
          memberIds={state.memberIds}
          forProject={dialog.forProject}
          onClose={() => setDialog(null)}
          run={run}
        />
      )}
      {dialog?.kind === 'block' &&
        (() => {
          const b = plan.blocks.find((x) => x.id === dialog.id)
          return b ? <BlockDialog key={b.id} plan={plan} block={b} today={today} canEdit={canEdit} onClose={() => setDialog(null)} run={run} /> : null
        })()}
      {dialog?.kind === 'roles' && <RolesDialog plan={plan} onClose={() => setDialog(null)} run={run} />}
    </div>
  )
}
