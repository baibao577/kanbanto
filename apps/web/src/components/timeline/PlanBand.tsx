import { CaretDown, CaretRight, ChartBarHorizontal } from '@phosphor-icons/react'
import { useState } from 'react'
import type { BoardPlan } from '@kanbanto/model/api'
import { tone } from '@kanbanto/model/colors'
import { toDay } from '@kanbanto/model/dates'
import { hrefFor } from '@/app/router'
import { Avatar } from '@/components/common/bits'
import { formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'

const fmtMd = (x: number) => (Math.round(x * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })
const HEAD_H = 32
const LINE_H = 28
const foldKey = (boardId: string) => `kankan:planband:${boardId}`

/**
 * On a board's Timeline, when the board is linked to a project in its workspace's plan: who is booked on it, at
 * what share of their time, from when until when. Read only; the plan itself is changed on the workspace's Planning
 * tab (linked from here). It folds to one line, remembered per board on this device.
 */
export function PlanBand({
  plan,
  boardId,
  x,
  width,
  left,
  dayW,
  today,
  start,
  end,
}: {
  plan: NonNullable<BoardPlan['plan']>
  boardId: string
  x: (day: number) => number
  width: number
  left: number
  dayW: number
  today: number
  start: number
  end: number
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(foldKey(boardId)) !== 'folded'
    } catch {
      return true
    }
  })
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(foldKey(boardId), open ? 'folded' : 'open')
    } catch {
      // Only a view setting.
    }
  }
  const color = tone(plan.project.color)
  // A prospect (might not happen): its time is pencilled in, dashed and paler, as on the plan.
  const prospect = plan.project.prospect
  const todayLine = <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary/40" style={{ left: x(today) + dayW / 2 - 1 }} />
  const cell = 'sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r bg-muted px-2'

  return (
    <div className="border-b-2 border-grid-line bg-muted/50">
      <div className="flex border-b border-grid-line" style={{ height: HEAD_H }}>
        <div className={cell} style={{ width: left }}>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? 'Fold the plan' : 'Show the plan'}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
          >
            {open ? <CaretDown className="size-3" /> : <CaretRight className="size-3" />}
          </button>
          <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} />
          {/* A prospect says so in place of "Plan", leaving the name its room. */}
          {prospect ? (
            <span
              className="shrink-0 rounded-full border border-dashed border-muted-foreground/60 px-1.5 text-[10px] font-semibold text-muted-foreground"
              title="A prospect: might not happen"
            >
              Prospect
            </span>
          ) : (
            <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Plan</span>
          )}
          <span className="min-w-0 truncate text-xs font-semibold" title={plan.project.name}>
            {plan.project.name}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {fmtMd(plan.scheduled)}
            {plan.project.plannedMd !== null && ` / ${fmtMd(plan.project.plannedMd)}`} MD
          </span>
          <a
            href={hrefFor({ page: 'workspace', id: plan.workspaceId, section: 'planning' })}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Open the plan"
            aria-label="Open the plan"
          >
            <ChartBarHorizontal className="size-3.5" />
          </a>
        </div>
        <div className="relative flex shrink-0 items-center px-3 text-[11px] text-muted-foreground" style={{ width }}>
          {todayLine}
          {!open && (
            <span className="sticky" style={{ left: left + 12 }}>
              {plan.lines.length ? `${plan.lines.length} ${plan.lines.length === 1 ? 'line' : 'lines'} of people’s time` : 'Nobody is booked yet.'}
            </span>
          )}
          {open && !plan.lines.length && (
            <span className="sticky" style={{ left: left + 12 }}>
              Nobody is booked on it yet.
            </span>
          )}
        </div>
      </div>
      {open &&
        plan.lines.map((line) => (
          <div key={line.key} className="flex border-b border-grid-line last:border-b-0" style={{ height: LINE_H }}>
            <div className={cell} style={{ width: left, paddingLeft: 30 }}>
              {line.name ? (
                <>
                  <Avatar name={line.name} picture={line.picture} className="size-4 text-[8px]" />
                  <span className="min-w-0 truncate text-xs">{line.name}</span>
                  {line.role && <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">{line.role}</span>}
                </>
              ) : (
                <span className="truncate text-xs text-muted-foreground italic">Not assigned yet</span>
              )}
            </div>
            <div className="relative shrink-0" style={{ width }}>
              {todayLine}
              {line.blocks.map((b, i) => {
                const s = Math.max(toDay(b.start), start)
                const e = Math.min(toDay(b.end), end)
                if (s > e) return null
                return (
                  <div
                    key={i}
                    title={`${prospect ? 'Prospect · ' : ''}${line.name ?? 'Not assigned yet'} · ${b.pct}% · ${formatDay(b.start)} – ${formatDay(b.end)}`}
                    className={cn(
                      'absolute top-1 bottom-1 flex items-center overflow-hidden rounded border px-1 text-[10px] font-medium tabular-nums',
                      prospect && 'border-[1.5px] border-dashed text-foreground/80',
                    )}
                    style={{
                      left: x(s),
                      width: Math.max(dayW, x(e + 1) - x(s)),
                      borderColor: color,
                      backgroundColor: `color-mix(in oklab, ${color} ${(line.name ? 22 : 10) / (prospect ? 2.5 : 1)}%, var(--background))`,
                      backgroundImage: line.name
                        ? undefined
                        : `repeating-linear-gradient(135deg, color-mix(in oklab, ${color} 25%, transparent) 0 4px, transparent 4px 9px)`,
                    }}
                  >
                    {/* Stays readable when the booking starts left of what's showing. */}
                    <span className="sticky truncate" style={{ left: left + 4 }}>
                      {b.pct}%
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
    </div>
  )
}
