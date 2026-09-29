import { SlidersHorizontal } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { StatusDot } from '@/components/common/bits'
import { DEFAULT_DISPLAY } from '@kanbanto/model/prefs'
import type { Filter, ParentDisplay, RowsBy, ViewConfig } from '@kanbanto/model/types'

// Hidden lists have their own controls, so they don't count as a changed display (and reset keeps them).
const sameConfig = (a: ViewConfig, b: ViewConfig) =>
  a.columns === b.columns &&
  a.rows === b.rows &&
  a.filter === b.filter &&
  !!a.groupByParent === !!b.groupByParent &&
  a.parentDisplay.length === b.parentDisplay.length &&
  a.parentDisplay.every((p) => b.parentDisplay.includes(p))

/** "Display" popover: the settings that shape the board, in plain words. */
export function DisplayMenu() {
  const { data, prefs, setPrefs } = useBoard()
  const cfg = prefs.display.board
  const focused = !!prefs.focusId
  const set = (p: Partial<ViewConfig>) => setPrefs({ type: 'setDisplay', config: { ...cfg, ...p } })
  const has = (p: ParentDisplay) => cfg.parentDisplay.includes(p)
  const toggle = (p: ParentDisplay, on: boolean) => set({ parentDisplay: on ? [...cfg.parentDisplay, p] : cfg.parentDisplay.filter((x) => x !== p) })
  const changed = !sameConfig(cfg, DEFAULT_DISPLAY.board)
  const groupedByParent = cfg.rows === 'rootParent' || cfg.rows === 'directParent'
  const hiddenCount = cfg.hiddenColumns?.length ?? 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="relative h-8 gap-1.5">
          <SlidersHorizontal />
          Display
          {changed && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" aria-label="Changed" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[calc(100dvh-7rem)] w-80 overflow-y-auto p-0"
        // Picking from a dropdown inside counts as "outside" (it renders in a portal). Only real outside clicks close.
        onInteractOutside={(e) => {
          const target = e.detail.originalEvent.target as Element | null
          if (target?.closest('[data-slot="select-content"], [data-radix-popper-content-wrapper]')) e.preventDefault()
        }}
      >
        <div className="space-y-4 p-4">
          <Field label="Rows">
            <Select value={cfg.rows} onValueChange={(v) => set({ rows: v as RowsBy })}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No rows</SelectItem>
                <SelectItem value="rootParent">A row for each project</SelectItem>
                <SelectItem value="directParent">A row for each parent task</SelectItem>
                <SelectItem value="assignee">A row for each person</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Show">
            <Select
              value={cfg.filter}
              onValueChange={(v) =>
                // Parent cards are most useful with their subtasks listed on them, so switch the checklist on.
                set(
                  v === 'main' && !has('checklist')
                    ? { filter: 'main', parentDisplay: [...cfg.parentDisplay, 'checklist'] }
                    : { filter: v as Filter },
                )
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tasks</SelectItem>
                <SelectItem value="leaves">Only tasks without subtasks</SelectItem>
                <SelectItem value="main">Main tasks only</SelectItem>
                <SelectItem value="topLevel">{focused ? 'Only its direct subtasks' : 'Only projects'}</SelectItem>
                <SelectItem value="actionable">Up next (ready to start)</SelectItem>
              </SelectContent>
            </Select>
            {cfg.filter === 'actionable' && <Hint>Tasks that haven't started, have no subtasks, and aren't waiting on anything.</Hint>}
            {cfg.filter === 'main' && (
              <Hint>
                Every task shows once: a subtask is listed on its parent’s card instead of getting its own card. Keep “Subtask checklist” on to see
                them.
              </Hint>
            )}
          </Field>

          <SwitchRow
            label="Group subtasks under their parent"
            hint={
              cfg.filter === 'topLevel' || cfg.filter === 'main'
                ? 'Not used with this “Show” choice.'
                : 'Parents become headers inside each list, not cards. Drag a header to move its subtasks together.'
            }
            checked={!!cfg.groupByParent}
            onChange={(on) => set({ groupByParent: on })}
          />
        </div>

        <Separator />
        <div className="space-y-3 p-4">
          <p className="text-xs font-medium text-muted-foreground">On each card</p>
          <SwitchRow label="Where it belongs" hint="The parent tasks above the title" checked={has('label')} onChange={(on) => toggle('label', on)} />
          <SwitchRow label="Subtask checklist" checked={has('checklist')} onChange={(on) => toggle('checklist', on)} />
          <SwitchRow label="Progress bar" checked={has('progress')} onChange={(on) => toggle('progress', on)} />
          {groupedByParent && (
            <SwitchRow
              label="Show parents only as rows"
              hint="Don't also show them as cards"
              checked={has('rowHeader')}
              onChange={(on) => toggle('rowHeader', on)}
            />
          )}
        </div>

        {(cfg.columns === 'status' || hiddenCount > 0) && (
          <>
            <Separator />
            <div className="space-y-2.5 p-4">
              <p className="text-xs font-medium text-muted-foreground">Lists to show</p>
              {data.columns.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2.5">
                  <StatusDot category={c.category} color={c.color} />
                  <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                  <Switch
                    checked={!cfg.hiddenColumns?.includes(c.id)}
                    onCheckedChange={(on) =>
                      set({
                        hiddenColumns: on ? (cfg.hiddenColumns ?? []).filter((x) => x !== c.id) : [...(cfg.hiddenColumns ?? []), c.id],
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </>
        )}

        {changed && (
          <>
            <Separator />
            <div className="flex justify-end p-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setPrefs({ type: 'setDisplay', config: { ...DEFAULT_DISPLAY.board, hiddenColumns: cfg.hiddenColumns } })}
              >
                Reset to default
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
