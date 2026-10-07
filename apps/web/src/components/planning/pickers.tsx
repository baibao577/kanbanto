import { Plus, UserPlus } from '@phosphor-icons/react'
import { useState } from 'react'
import { tone } from '@kanbanto/model/colors'
import type { PlanData, PlanPerson, PlanProject } from '@kanbanto/model/planning'
import { Avatar } from '@/components/common/bits'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const trigger =
  'flex h-7 items-center gap-1.5 rounded-md border border-dashed px-2 text-xs text-muted-foreground hover:border-solid hover:text-foreground'

/** "+ Add a person" on a project: puts someone on it with no time yet, so their line is there to add time to. */
export function AddPersonPicker({
  options,
  plan,
  pictures,
  onPick,
  onNew,
  onOpenLine,
}: {
  options: PlanPerson[]
  plan: PlanData
  pictures: Record<string, string>
  onPick: (personId: string) => void
  onNew: () => void
  /** Another "not assigned yet" line, for a need nobody is chosen for yet. */
  onOpenLine: () => void
}) {
  const [open, setOpen] = useState(false)
  const roles = new Map(plan.roles.map((r) => [r.id, r.name]))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={trigger}>
          <UserPlus className="size-3.5" /> Add a person
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find someone…" />
          <CommandList>
            <CommandEmpty>Nobody by that name.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="not assigned yet nobody chosen another line"
                onSelect={() => {
                  onOpenLine()
                  setOpen(false)
                }}
              >
                <span className="grid size-5 place-items-center rounded-full border border-dashed text-[10px] text-muted-foreground">?</span>
                <span className="text-muted-foreground italic">Not assigned yet</span>
                <span className="ml-auto text-xs text-muted-foreground">another line</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              {options.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${roles.get(p.roleId ?? '') ?? ''} ${p.id}`}
                  onSelect={() => {
                    onPick(p.id)
                    setOpen(false)
                  }}
                >
                  <Avatar name={p.name} picture={p.userId ? pictures[p.userId] : null} className="size-5 text-[9px]" />
                  <span className="truncate">{p.name}</span>
                  {p.roleId && roles.get(p.roleId) && <span className="ml-auto text-xs text-muted-foreground">{roles.get(p.roleId)}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="new person someone not in kanbanto"
                onSelect={() => {
                  setOpen(false)
                  onNew()
                }}
              >
                <Plus /> Someone not in Kanbanto…
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** "+ Add to a project" on a person: puts them on it with no time yet. */
export function AddProjectPicker({ options, onPick }: { options: PlanProject[]; onPick: (projectId: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={trigger}>
          <Plus className="size-3.5" /> Add to a project
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find a project…" />
          <CommandList>
            <CommandEmpty>No project by that name.</CommandEmpty>
            <CommandGroup>
              {options.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.client} ${p.id}`}
                  onSelect={() => {
                    onPick(p.id)
                    setOpen(false)
                  }}
                >
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: tone(p.color) }} />
                  <span className="truncate">{p.name}</span>
                  {p.client && <span className="ml-auto truncate text-xs text-muted-foreground">{p.client}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
