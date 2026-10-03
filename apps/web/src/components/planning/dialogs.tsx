import { ArrowDown, ArrowUp, Trash, X } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'
import type { ColorName } from '@kanbanto/model/colors'
import { fromDay, toDay } from '@kanbanto/model/dates'
import { newId } from '@kanbanto/model/ids'
import {
  endForManDays,
  manDays,
  PERCENTS,
  personFacts,
  projectFacts,
  workDays,
  type Percent,
  type PlanBlock,
  type PlanData,
} from '@kanbanto/model/planning'
import type { PlanCommand } from '@kanbanto/model/planningCommands'
import { ColorSwatches } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatDay } from '@/lib/format'
import { fmtMd } from './planLayout'

type Run = (cmd: PlanCommand, done?: string) => boolean
const NONE = '__none__'

function Field({ id, label, hint, children }: { id?: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A delete button that asks once more on the button itself. */
function DeleteButton({ label, confirm, onDelete }: { label: string; confirm: string; onDelete: () => void }) {
  const [armed, setArmed] = useState(false)
  return (
    <Button type="button" variant="ghost" className="mr-auto gap-1.5 text-destructive" onClick={() => (armed ? onDelete() : setArmed(true))}>
      <Trash /> {armed ? confirm : label}
    </Button>
  )
}

/** A project: its name, client, planned man-days (its budget), colour; finished; deleted with its time. */
export function ProjectDialog({ plan, id, onClose, run }: { plan: PlanData; id: string | 'new'; onClose: () => void; run: Run }) {
  const p = id === 'new' ? null : plan.projects.find((x) => x.id === id)
  const [name, setName] = useState(p?.name ?? '')
  const [client, setClient] = useState(p?.client ?? '')
  const [planned, setPlanned] = useState(p?.plannedMd !== null && p?.plannedMd !== undefined ? String(p.plannedMd) : '')
  const [color, setColor] = useState<ColorName | undefined>(p?.color)
  const [finished, setFinished] = useState(!!p?.finishedAt)
  const blocks = p ? plan.blocks.filter((b) => b.projectId === p.id).length : 0
  const plannedMd = planned.trim() === '' ? null : Number(planned)

  const save = () => {
    const ok = !p
      ? run({ type: 'project.add', id: newId(), name, client, plannedMd, ...(color && { color }) })
      : run({ type: 'project.update', id: p.id, fields: { name, client, plannedMd, ...(color && { color }), finished } })
    if (ok) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{p ? 'Project' : 'New project'}</DialogTitle>
          <DialogDescription>Its planned man-days are the budget: the time people give it is counted against them.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <Field id="plan-project-name" label="Name">
            <Input
              id="plan-project-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Data platform"
              required
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="plan-project-client" label="Client">
              <Input id="plan-project-client" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Optional" />
            </Field>
            <Field id="plan-project-md" label="Planned man-days" hint="Leave empty if there's no budget yet.">
              <Input
                id="plan-project-md"
                type="number"
                min={0}
                step={0.5}
                inputMode="decimal"
                value={planned}
                onChange={(e) => setPlanned(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Color">
            <ColorSwatches value={color} onChange={setColor} />
          </Field>
          {p && (
            <label className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
              <span>
                <span className="block text-sm font-medium">Finished</span>
                <span className="block text-xs text-muted-foreground">Folded away at the bottom. Its time still counts.</span>
              </span>
              <Switch checked={finished} onCheckedChange={setFinished} />
            </label>
          )}
          <DialogFooter className="gap-2 sm:justify-end">
            {p && (
              <DeleteButton
                label="Delete project"
                confirm={blocks ? `Delete it and its ${blocks} block${blocks === 1 ? '' : 's'}` : 'Click again to delete'}
                onDelete={() => run({ type: 'project.remove', id: p.id }, `Deleted ${p.name}`) && onClose()}
              />
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || (plannedMd !== null && !(plannedMd >= 0))}>
              {p ? 'Save' : 'Add project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A person: their role and hours a day. Members' names come from their account; someone added by name can be linked
 * to a member's account (their time moves over) or deleted (their time becomes "not assigned yet").
 */
export function PersonDialog({
  plan,
  id,
  memberIds,
  forProject,
  onClose,
  run,
}: {
  plan: PlanData
  id: string | 'new'
  memberIds: string[]
  /** A new person goes straight onto this project. */
  forProject?: string
  onClose: () => void
  run: Run
}) {
  const p = id === 'new' ? null : plan.people.find((x) => x.id === id)
  const [name, setName] = useState(p?.name ?? '')
  const [roleId, setRoleId] = useState(p?.roleId ?? NONE)
  const [hours, setHours] = useState(String(p?.hoursPerDay ?? 8))
  const [link, setLink] = useState(NONE)
  const member = !!p?.userId && memberIds.includes(p.userId)
  const left = !!p?.userId && !member
  const members = plan.people.filter((x) => x.userId && memberIds.includes(x.userId) && x.id !== p?.id)

  const save = () => {
    const fields = { roleId: roleId === NONE ? null : roleId, hoursPerDay: Number(hours) }
    if (!p) {
      const newPerson = newId()
      if (!run({ type: 'person.add', id: newPerson, name, ...fields })) return
      if (forProject) run({ type: 'line.add', projectId: forProject, personId: newPerson })
      return onClose()
    }
    if (run({ type: 'person.update', id: p.id, fields: { ...(!p.userId && { name }), ...fields } })) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{p ? p.name : 'Someone not in Kanbanto'}</DialogTitle>
          <DialogDescription>
            {p
              ? member
                ? 'In the workspace: their name comes from their Kanbanto account.'
                : left
                  ? 'They’ve left the workspace. Their time stays in the plan until you take them out.'
                  : 'Added by name. If they join the workspace, link them to their account.'
              : 'A contractor, someone who hasn’t started yet, or a stand-in like “New SE”. One working day of theirs is one man-day.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          {!p?.userId && (
            <Field id="plan-person-name" label="Name">
              <Input
                id="plan-person-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Nida, or New SE"
                required
              />
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role">
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger className="w-full" aria-label="Role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No role</SelectItem>
                  {plan.roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="plan-person-hours" label="Hours a day" hint="For reference: a man-day is one of their working days.">
              <Input id="plan-person-hours" type="number" min={0.5} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} />
            </Field>
          </div>
          {p && !p.userId && members.length > 0 && (
            <div className="space-y-1.5 rounded-md border p-3">
              <Label>Link to an account</Label>
              <p className="text-xs text-muted-foreground">
                If {p.name} has joined the workspace: their time moves to their account, and this name goes.
              </p>
              <div className="flex gap-2">
                <Select value={link} onValueChange={setLink}>
                  <SelectTrigger className="flex-1" aria-label="Their account">
                    <SelectValue placeholder="Pick someone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Pick someone</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  disabled={link === NONE}
                  onClick={() =>
                    run({ type: 'person.merge', id: p.id, into: link }, `${p.name} is now ${members.find((m) => m.id === link)?.name}`) && onClose()
                  }
                >
                  Link
                </Button>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:justify-end">
            {p && !member && (
              <DeleteButton
                label="Take out of the plan"
                confirm="Their time becomes “not assigned yet”"
                onDelete={() => run({ type: 'person.remove', id: p.id }, `${p.name} taken out of the plan`) && onClose()}
              />
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={(!p?.userId && !name.trim()) || !(Number(hours) >= 0.5)}>
              {p ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A block's details: project, person, time on the project and dates, with what it adds up to. */
export function BlockDialog({
  plan,
  block: b,
  today,
  canEdit,
  onClose,
  run,
}: {
  plan: PlanData
  block: PlanBlock
  today: number
  canEdit: boolean
  onClose: () => void
  run: Run
}) {
  const [projectId, setProjectId] = useState(b.projectId)
  const [personId, setPersonId] = useState(b.personId ?? NONE)
  const [pct, setPct] = useState<Percent>(b.pct)
  const [startDay, setStart] = useState(b.start)
  const [untilDay, setUntil] = useState(b.end)
  // The end as a date, or worked out from a number of man-days.
  const [by, setBy] = useState<'date' | 'md'>('date')
  const [mdText, setMdText] = useState(String(manDays(b)))
  const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
  const fromMd = by === 'md' && isDay(startDay) ? endForManDays(toDay(startDay), Number(mdText), pct) : null
  const endDay = by === 'md' ? (fromMd !== null ? fromDay(fromMd) : '') : untilDay
  const valid = isDay(startDay) && isDay(endDay) && startDay <= endDay
  const next: PlanBlock = { ...b, projectId, personId: personId === NONE ? null : personId, pct, start: startDay, end: endDay }
  const after = { ...plan, blocks: plan.blocks.map((x) => (x.id === b.id ? next : x)) }
  const project = plan.projects.find((p) => p.id === projectId)
  const person = plan.people.find((p) => p.id === next.personId)
  const pf = valid ? projectFacts(after, projectId) : null
  const lf = valid && person ? personFacts(after, person.id, today) : null
  const save = () => {
    if (run({ type: 'block.update', id: b.id, fields: { projectId, personId: next.personId, pct, start: startDay, end: endDay } })) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Block</DialogTitle>
          <DialogDescription>
            {person ? person.name : 'Not assigned yet'} on {project?.name}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <fieldset disabled={!canEdit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project">
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="w-full" aria-label="Project">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {plan.projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Person">
                <Select value={personId} onValueChange={setPersonId}>
                  <SelectTrigger className="w-full" aria-label="Person">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not assigned yet</SelectItem>
                    {plan.people.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label="Time on this project">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={String(pct)}
                onValueChange={(v) => v && setPct(Number(v) as Percent)}
                className="w-full"
              >
                {PERCENTS.map((v) => (
                  <ToggleGroupItem key={v} value={String(v)} className="flex-1 tabular-nums">
                    {v}%
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field id="plan-block-start" label="From">
                <Input id="plan-block-start" type="date" value={startDay} onChange={(e) => setStart(e.target.value)} required />
              </Field>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={by === 'date' ? 'plan-block-end' : 'plan-block-md'}>{by === 'date' ? 'Until' : 'Man-days'}</Label>
                  <ToggleGroup
                    type="single"
                    size="sm"
                    variant="outline"
                    value={by}
                    aria-label="End by"
                    onValueChange={(v) => {
                      if (!v) return
                      // Switching keeps what's there: the man-days the dates make, or the date the man-days give.
                      if (v === 'md' && valid) setMdText(String(manDays({ start: startDay, end: endDay, pct })))
                      if (v === 'date' && endDay) setUntil(endDay)
                      setBy(v as 'date' | 'md')
                    }}
                  >
                    <ToggleGroupItem value="date" className="h-6 px-2 text-[11px]" aria-label="End on a date">
                      Date
                    </ToggleGroupItem>
                    <ToggleGroupItem value="md" className="h-6 px-2 text-[11px]" aria-label="End after a number of man-days">
                      MD
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                {by === 'date' ? (
                  <Input id="plan-block-end" type="date" value={untilDay} onChange={(e) => setUntil(e.target.value)} required />
                ) : (
                  <Input
                    id="plan-block-md"
                    type="number"
                    min={0.25}
                    step={0.25}
                    inputMode="decimal"
                    value={mdText}
                    onChange={(e) => setMdText(e.target.value)}
                    required
                  />
                )}
                {by === 'md' && (
                  <p className="text-xs text-muted-foreground">
                    {fromMd !== null ? `Until ${formatDay(fromDay(fromMd), true)}` : 'Enter the man-days it takes.'}
                  </p>
                )}
              </div>
            </div>
          </fieldset>
          <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm" aria-live="polite">
            {valid ? (
              <>
                <p className="tabular-nums">
                  {workDays(toDay(startDay), toDay(endDay))} working days × {pct}% = <b>{fmtMd(manDays(next))} man-days</b>
                  {person && ` (${fmtMd(manDays(next) * person.hoursPerDay)} hours)`}
                </p>
                {pf && project && (
                  <p className="text-muted-foreground">
                    {project.name}: {fmtMd(pf.scheduled)}
                    {project.plannedMd !== null && ` of ${fmtMd(project.plannedMd)}`} man-days
                    {pf.status !== 'none' && ` · ${pf.status === 'fit' ? 'Fit' : pf.status === 'over' ? 'Over' : 'Under'}`}
                  </p>
                )}
                {lf && (
                  <p className={lf.overFrom !== null ? 'text-destructive' : 'text-muted-foreground'}>
                    {lf.overFrom !== null
                      ? `${person!.name} goes to ${lf.peak}% from ${formatDay(new Date(lf.overFrom * 86_400_000).toISOString().slice(0, 10))}`
                      : `${person!.name}: busiest day ${lf.peak}%`}
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">Pick a start, and an end on or after it.</p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-end">
            {canEdit && (
              <DeleteButton
                label="Remove"
                confirm="Click again to remove"
                onDelete={() => run({ type: 'block.remove', id: b.id }, 'Block removed') && onClose()}
              />
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              {canEdit ? 'Cancel' : 'Close'}
            </Button>
            {canEdit && (
              <Button type="submit" disabled={!valid}>
                Save
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The workspace's roles: add, rename, put in order, remove (people who had it get none). */
export function RolesDialog({ plan, onClose, run }: { plan: PlanData; onClose: () => void; run: Run }) {
  const [added, setAdded] = useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Roles</DialogTitle>
          <DialogDescription>What people do, in the order people are listed by.</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5">
          {plan.roles.map((r, i) => (
            <li key={r.id} className="flex items-center gap-1.5">
              <Input
                defaultValue={r.name}
                aria-label="Role name"
                className="h-8"
                onBlur={(e) =>
                  e.target.value.trim() && e.target.value.trim() !== r.name && run({ type: 'role.update', id: r.id, name: e.target.value })
                }
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => run({ type: 'role.move', id: r.id, beforeId: plan.roles[i - 1].id })}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Move down"
                disabled={i === plan.roles.length - 1}
                onClick={() => run({ type: 'role.move', id: r.id, beforeId: plan.roles[i + 2]?.id })}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={`Remove ${r.name}`}
                onClick={() => run({ type: 'role.remove', id: r.id }, `Removed the role ${r.name}`)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (added.trim() && run({ type: 'role.add', name: added })) setAdded('')
          }}
        >
          <Input value={added} onChange={(e) => setAdded(e.target.value)} placeholder="New role, e.g. QA" aria-label="New role" className="h-8" />
          <Button type="submit" size="sm" className="h-8" disabled={!added.trim()}>
            Add
          </Button>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
