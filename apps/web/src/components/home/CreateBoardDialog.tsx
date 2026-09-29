import { useState, type ReactNode } from 'react'
import { navigate } from '@/app/router'
import { BackgroundSwatches } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api/client'
import type { ColorName } from '@kanbanto/model/colors'

/** New board: a name, a background, and whether to start empty or from the example. Opens it when created. */
export function CreateBoardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('')
  const [background, setBackground] = useState<ColorName | undefined>('blue')
  const [start, setStart] = useState<'empty' | 'example'>('empty')

  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const { id } = await api<{ id: string }>('POST', '/boards', { name: name.trim() || 'Untitled board', background, template: start })
      onOpenChange(false)
      setName('')
      navigate({ page: 'board', id })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a board</DialogTitle>
          <DialogDescription>You can change all of this later in Board settings.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-board-name">Name</Label>
            <Input id="new-board-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Website launch" />
          </div>
          <div className="space-y-2">
            <Label>Background</Label>
            <BackgroundSwatches value={background} onChange={setBackground} />
          </div>
          <div className="space-y-2">
            <Label>Start with</Label>
            <RadioGroup value={start} onValueChange={(v) => setStart(v as 'empty' | 'example')} className="gap-2">
              <Choice value="empty" title="An empty board">
                Lists for To Do, Doing and Done, plus a hidden Backlog. No tasks yet.
              </Choice>
              <Choice value="example" title="The example board">
                A small website-launch plan to explore how projects, subtasks and views work.
              </Choice>
            </RadioGroup>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create board
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Choice({ value, title, children }: { value: string; title: string; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </label>
  )
}
