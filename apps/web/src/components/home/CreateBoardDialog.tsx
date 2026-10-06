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
import { CLIENTS_BOARD_NAME, isStarter, STARTER_INFO, STARTERS, type Starter } from '@kanbanto/model/starters'

const PERSONAL = 'personal'

type Start = 'empty' | 'example' | Starter

const joinWords = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)

/**
 * New board: a name, where it goes (Personal or one of your workspaces), a background, and what it starts with:
 * nothing, the example, or a starter (a board for a kind of work, with its own lists and fields). Opens it when
 * created. `where` is the workspace to suggest.
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
  const [start, setStart] = useState<Start>('empty')
  const starter = isStarter(start) ? STARTER_INFO[start] : null
  // A starter's fields go into the library of where the board is made: the workspace's, or your own.
  const library = workspace ? `${workspace.name}’s fields` : 'your own fields'
  /** Why a starter couldn't be made (it's a few lines: said in the window, not in a passing message). */
  const [problem, setProblem] = useState('')

  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    setProblem('')
    try {
      const { id, added, leftOut, clients } = await api<{ id: string; added?: string[]; leftOut?: string[]; clients?: { made: boolean } }>(
        'POST',
        '/boards',
        {
          name: name.trim() || starter?.name || 'Untitled board',
          background,
          template: start,
          workspaceId: workspace?.id ?? null,
        },
      )
      onOpenChange(false)
      setName('')
      setPicked(null)
      setStart('empty')
      navigate({ page: 'board', id })
      if (clients?.made) toast(`A “${CLIENTS_BOARD_NAME}” board came with it: the cards its Client field links to. Add your own clients there.`)
      if (added?.length) toast(`Added to ${library}: ${joinWords(added)}.`)
      if (leftOut?.length)
        toast(`Made without ${joinWords(leftOut)}: ${leftOut.length === 1 ? 'that field is' : 'those fields are'} archived in ${library}.`)
    } catch (e) {
      if (starter) setProblem(errorMessage(e))
      else toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPicked(null)
          setProblem('')
        }
        onOpenChange(o)
      }}
    >
      {/* (As tall as the window at most: what's inside scrolls, and the buttons stay in view.) */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Create a board</DialogTitle>
          <DialogDescription>You can change all of this later in Board settings.</DialogDescription>
        </DialogHeader>
        <form
          id="new-board"
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-board-name">Name</Label>
            <Input
              id="new-board-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={starter ? starter.name : 'e.g. Website launch'}
            />
          </div>
          {workspaces.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="new-board-where">Where</Label>
              <Select
                value={place}
                onValueChange={(v) => {
                  setPicked(v)
                  setProblem('')
                }}
              >
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
            <Label>Start with</Label>
            <RadioGroup
              value={start}
              onValueChange={(v) => {
                setStart(v as Start)
                setProblem('')
              }}
              className="grid gap-2 sm:grid-cols-2"
            >
              <Choice value="empty" title="An empty board">
                Lists for To Do, Doing and Done, plus a hidden Backlog. No tasks yet.
              </Choice>
              <Choice value="example" title="The example board">
                A small website-launch plan to explore how projects, subtasks and views work.
              </Choice>
              {STARTERS.map((kind) => (
                <Choice key={kind} value={kind} title={STARTER_INFO[kind].title}>
                  {STARTER_INFO[kind].hint}
                </Choice>
              ))}
            </RadioGroup>
            {starter && !problem && (
              <p className="text-xs text-muted-foreground">
                It comes with its own fields, a few saved filters and example cards. Each card is for a client: a card on a “{CLIENTS_BOARD_NAME}”
                board, made with your first starter and shared by the ones after.{' '}
                {workspace && workspace.role !== 'admin'
                  ? `The fields are ${workspace.name}’s: if they aren’t there yet, one of its admins has to make the first board from this starter.`
                  : `The fields it needs are added to ${library}, unless they’re there already.`}
              </p>
            )}
            {problem && (
              <p
                role="alert"
                ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
                className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs leading-relaxed text-destructive"
              >
                {problem}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Background</Label>
            <BackgroundSwatches value={background} onChange={setBackground} />
          </div>
        </form>
        <DialogFooter className="border-t px-5 py-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-board" disabled={busy}>
            Create board
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Choice({ value, title, children }: { value: string; title: string; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </label>
  )
}
