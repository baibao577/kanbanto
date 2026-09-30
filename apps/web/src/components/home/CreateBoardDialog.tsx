import { useEffect, useState, type ReactNode } from 'react'
import type { WorkspaceSummary } from '@kanbanto/model/api'
import { navigate } from '@/app/router'
import { BackgroundSwatches } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api/client'
import type { BoardBackground } from '@kanbanto/model/colors'

const PERSONAL = 'personal'

/**
 * New board: a name, where it goes (Personal or one of your workspaces), a background, and whether to start empty or
 * from the example. Opens it when created. `where` is the workspace to suggest.
 */
export function CreateBoardDialog({
  open,
  onOpenChange,
  workspaces: given,
  where,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Your workspaces; loaded when it opens if not given. */
  workspaces?: WorkspaceSummary[]
  where?: string | null
}) {
  const [loaded, setLoaded] = useState<WorkspaceSummary[]>([])
  useEffect(() => {
    if (open && !given)
      api<{ workspaces: WorkspaceSummary[] }>('GET', '/workspaces').then(
        (r) => setLoaded(r.workspaces),
        () => {},
      )
  }, [open, given])
  const workspaces = given ?? loaded
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  // Until you pick, it follows where you started from ("New board" in a workspace's section).
  const place = picked ?? where ?? PERSONAL
  const workspace = workspaces.find((w) => w.id === place)
  const [background, setBackground] = useState<BoardBackground | undefined>('blue')
  const [start, setStart] = useState<'empty' | 'example'>('empty')

  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const { id } = await api<{ id: string }>('POST', '/boards', {
        name: name.trim() || 'Untitled board',
        background,
        template: start,
        workspaceId: workspace?.id ?? null,
      })
      onOpenChange(false)
      setName('')
      setPicked(null)
      navigate({ page: 'board', id })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setPicked(null)
        onOpenChange(o)
      }}
    >
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
          {workspaces.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="new-board-where">Where</Label>
              <Select value={place} onValueChange={setPicked}>
                <SelectTrigger id="new-board-where" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PERSONAL}>Personal</SelectItem>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {workspace ? `Everyone in ${workspace.name} can open and edit it. You can change that with Share.` : 'Only you, until you share it.'}
              </p>
            </div>
          )}
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
