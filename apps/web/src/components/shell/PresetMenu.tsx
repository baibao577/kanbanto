import { ArrowCounterClockwise, BookmarkSimple, Check, FloppyDisk, X } from '@phosphor-icons/react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { BoardPreset } from '@kanbanto/model/api'
import { cleanPrefs, defaultPrefs, matchesPreset, presetOf, type PresetSettings } from '@kanbanto/model/prefs'
import { api, errorMessage } from '@/api/client'
import { useBoard, useReadOnly } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useLoaded } from '@/data/useLoaded'

type Naming = { mode: 'new' } | { mode: 'rename'; preset: BoardPreset }

/**
 * "Presets": named filters and display settings saved on the board, for everyone on it. Picking one changes only
 * your view; editors save, update, rename and delete them.
 */
export function PresetMenu() {
  const { data, prefs, setPrefs } = useBoard()
  const readOnly = useReadOnly()
  const base = `/boards/${data.board.id}/presets`
  const [loaded, reload] = useLoaded(useCallback(() => api<{ presets: BoardPreset[] }>('GET', base).then((r) => r.presets), [base]))
  const [changed, setChanged] = useState<BoardPreset[] | null>(null)
  const presets = changed ?? loaded ?? []
  const [naming, setNaming] = useState<Naming | null>(null)

  /** Settings, minus lists, labels or people that are gone from the board. */
  const cleaned = (s: PresetSettings): PresetSettings => presetOf(cleanPrefs({ ...prefs, ...s }, data))
  const settingsOf = (p: BoardPreset) => cleaned(p.settings)
  const active = presets.find((p) => p.id === prefs.presetId)
  const drifted = !!active && !matchesPreset(prefs, settingsOf(active))

  const apply = (p: BoardPreset) => setPrefs({ type: 'applyPreset', id: p.id, settings: settingsOf(p) })
  const act = async (method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
    try {
      const r = await api<{ presets: BoardPreset[]; id?: string }>(method, `${base}${path}`, body)
      setChanged(r.presets)
      return r
    } catch (e) {
      toast.error(errorMessage(e))
      return null
    }
  }

  // Nothing to pick and nothing you can save: no button (visitors, viewers on a board without presets).
  if (readOnly && !presets.length) return null

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          // Someone else may have changed them.
          if (open) void reload().then(() => setChanged(null))
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 max-w-44 gap-1.5 max-sm:px-2" title={active ? `Preset: ${active.name}` : 'Presets'}>
            <BookmarkSimple weight={active ? 'fill' : 'regular'} />
            {/* On a phone: just the icon (filled while a preset is on). */}
            <span className="truncate max-sm:hidden">{active?.name ?? 'Presets'}</span>
            {drifted && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="changed since" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Presets on this board</DropdownMenuLabel>
          {presets.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => apply(p)}>
              <Check className={p.id === active?.id ? '' : 'invisible'} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.id === active?.id && drifted && <span className="text-[11px] text-muted-foreground">changed</span>}
            </DropdownMenuItem>
          ))}
          {!presets.length && (
            <p className="px-2 pb-2 text-xs text-muted-foreground">
              None yet. Set up filters and the Display options, then save them here for everyone on the board.
            </p>
          )}
          {active && (
            <>
              <DropdownMenuSeparator />
              {/* Changed the filters or Display since picking it: go back, or (editors) keep the changes in it. */}
              {drifted && (
                <DropdownMenuItem onSelect={() => apply(active)}>
                  <ArrowCounterClockwise />
                  Back to “{active.name}” as saved
                </DropdownMenuItem>
              )}
              {drifted && !readOnly && (
                <DropdownMenuItem
                  onSelect={async () => {
                    if (await act('PATCH', `/${active.id}`, { settings: presetOf(prefs) })) toast(`“${active.name}” updated`)
                  }}
                >
                  <FloppyDisk />
                  Update “{active.name}” with this view
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setPrefs({ type: 'leavePreset', settings: cleaned(prefs.beforePreset ?? presetOf(defaultPrefs())) })}>
                <X />
                Turn off preset
              </DropdownMenuItem>
            </>
          )}
          {!readOnly && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setNaming({ mode: 'new' })}>Save this view as a new preset…</DropdownMenuItem>
              {active && (
                <>
                  <DropdownMenuItem onSelect={() => setNaming({ mode: 'rename', preset: active })}>Rename “{active.name}”…</DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={async () => {
                      if (await act('DELETE', `/${active.id}`)) {
                        setPrefs({ type: 'leavePreset' })
                        toast(`“${active.name}” deleted`)
                      }
                    }}
                  >
                    Delete “{active.name}”
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {naming && (
        <NameDialog
          naming={naming}
          onClose={() => setNaming(null)}
          onSave={async (name) => {
            if (naming.mode === 'rename') return !!(await act('PATCH', `/${naming.preset.id}`, { name }))
            const settings = presetOf(prefs)
            const r = await act('POST', '', { name, settings })
            if (r?.id) {
              setPrefs({ type: 'applyPreset', id: r.id, settings })
              toast(`Saved “${name}” for everyone on this board`)
            }
            return !!r
          }}
        />
      )}
    </>
  )
}

function NameDialog({ naming, onClose, onSave }: { naming: Naming; onClose: () => void; onSave: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState(naming.mode === 'rename' ? naming.preset.name : '')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    const ok = await onSave(name.trim())
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{naming.mode === 'rename' ? 'Rename preset' : 'Save as a preset'}</DialogTitle>
          <DialogDescription>
            {naming.mode === 'rename'
              ? 'Everyone on the board sees the new name.'
              : 'Keeps the filters and Display options you have now. Everyone on the board can pick it.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input
            autoFocus
            aria-label="Preset name"
            placeholder="Focus, Review, This week…"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              {naming.mode === 'rename' ? 'Rename' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
