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
import { TEMPLATE_NAME_MAX, type BoardTemplate } from '@kanbanto/model/templates'

const PERSONAL = 'personal'

/** What a new board starts with: nothing, the example, a starter, or one of the board templates of where it's made (`t:` and its id). */
type Start = 'empty' | 'example' | Starter | `t:${string}`

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
  // The board templates of where the board is being made: that workspace's, or your own.
  const [templates, setTemplates] = useState<BoardTemplate[]>([])
  const [round, setRound] = useState(0)
  const templatesAt = workspace?.id
  useEffect(() => {
    if (!open) return
    let gone = false
    api<{ templates: BoardTemplate[] }>('GET', `/board-templates${templatesAt ? `?workspace=${templatesAt}` : ''}`).then(
      (r) => !gone && setTemplates(r.templates),
      () => !gone && setTemplates([]),
    )
    return () => void (gone = true)
  }, [open, templatesAt, round])
  const template = start.startsWith('t:') ? templates.find((t) => `t:${t.id}` === start) : undefined
  // (A template of another place, picked before "Where" changed, or one removed since, counts as an empty board.)
  const chosen: Start = start.startsWith('t:') && !template ? 'empty' : start
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
          name: name.trim() || starter?.name || template?.name || 'Untitled board',
          background,
          ...(template ? { templateId: template.id } : { template: chosen }),
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
      if (starter || template) setProblem(errorMessage(e))
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
              placeholder={starter ? starter.name : template ? template.name : 'e.g. Website launch'}
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
              value={chosen}
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
              {templates.length > 0 && (
                <p className="mt-1 text-xs font-medium text-muted-foreground sm:col-span-2">
                  {workspace ? `${workspace.name}’s templates` : 'Your templates'}
                </p>
              )}
              {templates.map((t) => (
                <TemplateChoice key={t.id} template={t} onChanged={() => setRound((r) => r + 1)} />
              ))}
            </RadioGroup>
            {template && !problem && (
              <p className="text-xs text-muted-foreground">
                It starts with the template’s lists, labels, fields, rules and card templates, and no cards. Fields it needs are taken from {library},
                or added there.
              </p>
            )}
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

const some = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`

/** One board template to start from: its name and what it holds; whoever may change it can rename and remove it here. */
function TemplateChoice({ template, onChanged }: { template: BoardTemplate; onChanged: () => void }) {
  const [name, setName] = useState<string | null>(null)
  const at = `/board-templates/${template.id}`
  const did = (what: Promise<unknown>, said?: string) =>
    what.then(
      () => {
        if (said) toast(said)
        onChanged()
      },
      (e) => toast.error(errorMessage(e)),
    )
  const rename = () => {
    const next = name?.trim()
    setName(null)
    if (next && next !== template.name) void did(api('PATCH', at, { name: next }))
  }
  const remove = () => {
    if (confirm(`Remove the template “${template.name}”? Boards made from it stay as they are.`))
      void did(api('DELETE', at), `Removed the template “${template.name}”`)
  }
  const holds = [
    some(template.lists, 'list'),
    ...(template.fields ? [some(template.fields, 'field')] : []),
    ...(template.cardTemplates ? [some(template.cardTemplates, 'card template')] : []),
  ]
  return (
    <div className="rounded-lg border transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
      <label className="flex cursor-pointer gap-2.5 p-3">
        <RadioGroupItem value={`t:${template.id}`} className="mt-0.5" />
        <span className="min-w-0 space-y-0.5">
          {name === null ? (
            <span className="block truncate text-sm font-medium">{template.name}</span>
          ) : (
            <Input
              autoFocus
              aria-label="Template name"
              value={name}
              maxLength={TEMPLATE_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  rename()
                }
                if (e.key === 'Escape') setName(null)
              }}
              className="h-7"
            />
          )}
          <span className="block text-xs leading-relaxed text-muted-foreground">{holds.join(' · ')}</span>
        </span>
      </label>
      {template.canChange && name === null && (
        <p className="flex gap-3 px-3 pb-2 pl-9.5 text-xs text-muted-foreground">
          <button type="button" className="hover:text-foreground hover:underline" onClick={() => setName(template.name)}>
            Rename
          </button>
          <button type="button" className="hover:text-destructive hover:underline" onClick={remove}>
            Remove
          </button>
        </p>
      )}
    </div>
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
